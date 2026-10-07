import { astVisitor, Statement } from 'pgsql-ast-parser';
import { _IDb, _IPreparedQuery, _ISchema, _IStatementExecutor, _Transaction, FieldInfo, _IBoundQuery, IPreparedQuery, nil, NotSupported, Parameter, ParameterInfo, QueryDescription, QueryError, QueryResult, StatementResult, _QueryResult } from '../interfaces-private';
import { StatementExec } from '../execution/statement-exec';
import { runDeferredChecks } from '../execution/deferred-checks';
import { SelectExec } from '../execution/select';
import { Types } from '../datatypes';
import { withParameters } from '../parser/context';
import { cleanResults } from '../execution/clean-results';

function isSchemaChange(s: Statement): boolean {
    switch (s.type) {
        case 'alter enum':
        case 'alter index':
        case 'alter sequence':
        case 'alter table':
        case 'create composite type':
        case 'create enum':
        case 'create extension':
        case 'create function':
        case 'create index':
        case 'create materialized view':
        case 'create schema':
        case 'create sequence':
        case 'create table':
        case 'create view':
        case 'drop function':
        case 'drop index':
        case 'drop sequence':
        case 'drop table':
        case 'drop view':
        case 'drop materialized view':
        case 'drop trigger':
        case 'drop type':
            return true;

        case 'do':
            // we dont know what's in there
            //  => assume it could be schema change
            return true;
        default:
            return false;
    }
}

/**
 * Where a top-level query call starts: the transaction block a previous call left open
 * (BEGIN without COMMIT/ROLLBACK yet), or a fresh implicit transaction forked from root.
 *
 * Inside a block that a failed statement aborted, Postgres refuses everything but the
 * statement that ends the block; COMMIT then rolls back, like it does in Postgres.
 */
function startCall(db: _IDb, statements: Statement[]): _Transaction {
    const open = db.sessionTx;
    db.sessionTx = null;
    if (!open) {
        return db.data.fork();
    }
    if (open.aborted) {
        const first = statements[0]?.type;
        if (first === 'rollback' && (statements[0] as any).to) {
            // ROLLBACK TO SAVEPOINT is how a client recovers an aborted block without ending it
            // (what drivers' nested transactions do after an error): rewind to the savepoint and
            // carry on in the block. If the savepoint does not exist, that statement fails and the
            // block stays aborted.
            open.aborted = false;
            return open;
        }
        if (first === 'rollback' || first === 'commit') {
            // the block is over either way (a COMMIT on an aborted block is a ROLLBACK in
            // postgres): undo it, schema included, and carry on in whatever enclosed it
            statements.splice(0, 1);
            const after = open.explicitBlock?.rollback() ?? db.data;
            return after.isChild ? after : db.data.fork();
        }
        db.sessionTx = open;
        throw new QueryError('current transaction is aborted, commands ignored until end of transaction block', '25P02');
    }
    return open;
}

/** End of a top-level call: commit, unless a BEGIN block is still open, in which case keep it for the next call. */
function endCall(db: _IDb, state: _Transaction) {
    if (state.inExplicitBlock) {
        db.sessionTx = state;
        return;
    }
    // run any deferred (DEFERRABLE INITIALLY DEFERRED) constraint checks before
    // finalizing - a violation aborts the batch, so nothing persists to root
    runDeferredChecks(state);
    state.fullCommit();
}

/** A statement failed: if it ran inside a BEGIN block, the block is now aborted until ROLLBACK. */
function failCall(db: _IDb, state: _Transaction) {
    if (state.inExplicitBlock) {
        state.aborted = true;
        db.sessionTx = state;
        return;
    }
    // the call's implicit transaction is dropped, so its data is gone: put the schema back too
    // (a failed migration must not leave half its tables behind)
    state.discardAll();
}

let _paramList: Parameter[] | null = null;
const paramsVisitor = astVisitor(() => ({
    // a PREPAREd statement's own $-parameters are bound at EXECUTE time; they are not
    // parameters of the enclosing query, so don't descend into its inner statement
    prepare: () => { },
    parameter: p => {
        const [, istr] = /^\$(\d+)$/.exec(p.name) ?? [];
        if (!istr) {
            throw new QueryError('Invalid parameter name');
        }
        _paramList ??= [];
        const idx = parseInt(istr, 10) - 1;
        if (_paramList!.find(p => p.index === idx)) {
            return;
        }
        _paramList!.push({
            index: idx,
            value: null,
            inferedType: Types.text(),
        });
    }
}))

export function collectParams(stmt: Statement[]): Parameter[] | null {
    for (const s of stmt) {
        paramsVisitor.statement(s);
    }
    const ret = _paramList;
    _paramList = null;
    return ret;
}

export function prepareQuery(schema: _ISchema, query: Statement[], singleSql: string | nil): _IPreparedQuery {


    const params = collectParams(query) ?? [];
    const hasSchemaChange = query.some(isSchemaChange);

    // if there are parameters in the query, then PG protocol will expect
    //  describes to also yield parameter descriptors, which will be innaccessible for the same reason
    //   as described below
    if (hasSchemaChange && params.length) {
        throw new NotSupported('schema change with parameters');
    }
    // pg-mem does not support preparing statements that will trigger schema changes
    //  suppose we have:
    //   - a create table
    //   - a select on this table
    // compiling the second statement before executing the first will fail
    //  supporting this would require pg-mem to to implement transactions for schema changes,
    //  which is no small feat (and frankly, not a priority)
    // => when there is a schema change, we fallback to a PreparedQueryNoDescribe
    //   which compiles AND executes statements one by-one, commiting things each time it executes a schema change
    //   and thus does not allow describing the operation before executing it
    const ret = hasSchemaChange
        ? new PreparedQueryNoDescribe(schema, query, singleSql)
        : new PreparedQuery(schema, query, params, singleSql);

    return ret;
}

class PreparedQueryNoDescribe implements _IPreparedQuery {

    executed?: () => void;
    failed?: (e: any) => void;

    constructor(readonly schema: _ISchema, private query: Statement[], private singleSql: string | nil) {
    }

    describe(): QueryDescription {
        const l = this.query[this.query.length - 1];
        if (!isSchemaChange(l)) {
            // see comment in prepareQuery
            throw new NotSupported('describe a schema-change query');
        }
        return {
            result: [],
            parameters: [],
        };
    }

    bind(args: any[]): _IBoundQuery {
        const db = this.schema.db;
        const query = [...this.query];
        let t = startCall(db, query);
        const results: StatementResult[] = [];
        try {
            for (const stmt of query) {
                const s = new StatementExec(this.schema, stmt, this.singleSql);

                const compiled = s.compile();

                // store last select for debug purposes
                if (compiled instanceof SelectExec) {
                    this.schema.lastSelect = compiled.selection;
                }

                // execute statement
                const r = s.executeStatement(t, args);
                r.result.rows = cleanResults(r.result.rows);
                results.push(r);
                t = r.state;
            }
        } catch (e) {
            failCall(db, t);
            throw e;
        }
        if (!results.length) {
            // the call was only the ROLLBACK/COMMIT closing an aborted block
            endCall(db, t);
            return new NoDescribeBound(this, [{ result: { command: 'ROLLBACK', fields: [], rowCount: 0, rows: [], location: { start: 0, end: 0 } } as any, state: t }], true);
        }
        return new NoDescribeBound(this, results);
    }
}

class NoDescribeBound implements _IBoundQuery {
    constructor(private parent: PreparedQueryNoDescribe, private results: StatementResult[], private ended = false) {
    }
    executeAll(): QueryResult {
        const last = this.results[this.results.length - 1]!;
        if (!this.ended) {
            endCall(this.parent.schema.db, last.state);
        }
        this.parent.executed?.();
        return last.result;
    }

    *iterate(): IterableIterator<QueryResult> {
        for (const res of this.results) {
            res.result.rows = cleanResults(res.result.rows);
            yield res.result;
        }
        this.executeAll();
    }
}

class PreparedQuery implements _IPreparedQuery {

    lastSelect: SelectExec | null = null;
    private lastStmt: _IStatementExecutor | null = null;
    private stmts: StatementExec[];
    executed?: () => void;
    failed?: (e: any) => void;

    constructor(readonly schema: _ISchema, query: Statement[], private params: Parameter[], singleSql: string | nil) {
        // there is no schema change, meaning that we can compile statements
        // without fearing that a statement
        const stmts = query.map(s => new StatementExec(schema, s, singleSql));
        for (const stmt of stmts) {
            const compiled = withParameters(params, () => stmt.compile());

            // store last select for debug purposes
            if (compiled instanceof SelectExec) {
                this.lastSelect = compiled;
            }
            this.lastStmt = compiled;
        }

        this.stmts = stmts;
    }

    describe(): QueryDescription {
        this.params.sort((a, b) => a.index - b.index);
        // is there an ununsed parameter?
        for (let i = 0; i < this.params.length; i++) {
            if (this.params[i].index !== i || !this.params[i].inferedType) {
                throw new QueryError(`Parameter $${i + 1} is not used`);
            }
        }

        const parameters = this.params.map<ParameterInfo>(p => ({
            type: p.inferedType!.primary,
            typeId: p.inferedType!.reg.typeId,
        }));

        if (this.lastStmt instanceof SelectExec) {
            return {
                result: this.lastStmt.selection.columns.map<FieldInfo>(c => ({
                    name: c.id!,
                    type: c.type.primary,
                    typeId: c.type.reg.typeId,
                })),
                parameters,
            };
        }
        return { result: [], parameters };
    }

    bind(args: any[]): Bound {
        return new Bound(this, this.stmts, args, this.lastSelect);
    }
}


class Bound implements _IBoundQuery {
    constructor(private parent: PreparedQuery, private stmts: StatementExec[], private args: any[], private lastSelect: SelectExec | null) {
    }

    executeAll(outerTx?: _Transaction): _QueryResult {
        const all = [...this.doExecute(outerTx)];
        const f = all[all.length - 1];
        if (!outerTx) {
            return f.result;
        } else {
            return {
                ...f.result,
                state: f.state,
            }
        }

    }

    private *doExecute(outerTx?: _Transaction): IterableIterator<StatementResult> {
        // Start an implicit transaction (to avoid messing global data if an operation fails
        // mid-write), or resume the BEGIN block a previous call left open
        const db = this.parent.schema.db;
        let stmts = this.stmts;
        let t: _Transaction;
        if (outerTx) {
            t = outerTx;
        } else {
            const asts = stmts.map(s => s.statement);
            t = startCall(db, asts);
            if (asts.length < stmts.length) {
                // the leading ROLLBACK/COMMIT closed an aborted block
                stmts = stmts.slice(stmts.length - asts.length);
                if (!stmts.length) {
                    yield { result: { command: 'ROLLBACK', fields: [], rowCount: 0, rows: [], location: { start: 0, end: 0 } } as any, state: t };
                    endCall(db, t);
                    return;
                }
            }
        }

        let lastResult: StatementResult;
        try {
            for (const s of stmts) {
                // Execute statement
                const r = s.executeStatement(t, this.args);
                r.result.rows = cleanResults(r.result.rows);
                yield r;
                lastResult = r;
                t = r.state;
            }
        } catch (e) {
            if (!outerTx) {
                failCall(db, t);
            }
            throw e;
        }

        if (this.parent.lastSelect) {
            this.parent.schema.lastSelect = this.parent.lastSelect.selection;
        }
        this.parent.executed?.();

        if (!outerTx) {
            endCall(db, lastResult!.state);
        }
    }

    *iterate(): IterableIterator<QueryResult> {
        for (const res of this.doExecute()) {
            yield res.result;
        }
    }
}

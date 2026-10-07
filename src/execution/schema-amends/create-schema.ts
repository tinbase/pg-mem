import { _Transaction, asTable, _ISchema, NotSupported, CreateIndexColDef, _ITable, CreateIndexDef, _IStatement, _IStatementExecutor, QueryError } from '../../interfaces-private';
import { CreateSchemaStatement } from 'pgsql-ast-parser';
import { ExecHelper } from '../exec-utils';
import { ignore } from '../../utils';

export class CreateSchema extends ExecHelper implements _IStatementExecutor {
    private toCreate?: string;

    constructor(private st: _IStatement, p: CreateSchemaStatement) {
        super(p);
        const sch = this.st.schema.db.getSchema(p.name.name, true);
        if (!p.ifNotExists && sch) {
            throw new QueryError('schema already exists! ' + p.name);
        }
        if (sch) {
            ignore(p);
        } else {
            this.toCreate = p.name.name;
        }
    }

    execute(t: _Transaction) {

        // create schema
        if (this.toCreate) {
            this.st.schema.db.createSchema(this.toCreate);
        }
        return this.noData(t, 'CREATE');
    }
}

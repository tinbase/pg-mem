import { _ISchema, _Transaction, _ISequence, _IStatementExecutor, _IStatement, asSeq, asIndex, _INamedIndex } from '../../interfaces-private';
import { DropStatement } from 'pgsql-ast-parser';
import { ExecHelper } from '../exec-utils';
import { ignore, notNil } from '../../utils';

export class DropIndex extends ExecHelper implements _IStatementExecutor {
    private idx: _INamedIndex[];


    constructor({ schema }: _IStatement, statement: DropStatement) {
        super(statement);

        this.idx = notNil(statement.names.map(x => asIndex(schema.getObject(x, {
            nullIfNotFound: statement.ifExists,
        }))));

        if (this.idx.length) {
            ignore(statement.concurrently);
        } else {
            ignore(statement);
        }
    }

    execute(t: _Transaction) {

        // alter the sequence
        for (const idx of this.idx) {
            idx.onTable.dropIndex(t, idx.name);
        }

        return this.noData(t, 'DROP');
    }
}

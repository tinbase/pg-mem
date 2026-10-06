import { _ISchema, _Transaction, _ISequence, _IStatementExecutor, _IStatement, asSeq, asIndex, _INamedIndex, _ITable, asTable } from '../../interfaces-private';
import { DropStatement } from 'pgsql-ast-parser';
import { ExecHelper } from '../exec-utils';
import { ignore, notNil } from '../../utils';

export class DropTable extends ExecHelper implements _IStatementExecutor {
    private tables: _ITable[];
    private cascade: boolean;


    constructor({ schema }: _IStatement, statement: DropStatement) {
        super(statement);

        this.tables = notNil(statement.names.map(x => asTable(schema.getObject(x, {
            nullIfNotFound: statement.ifExists,
        }))));

        this.cascade = statement.cascade === 'cascade';

        if (!this.tables.length) {
            ignore(statement);
        }
    }

    execute(t: _Transaction) {

        // drop table
        for (const table of this.tables) {
            table.drop(t, this.cascade);
        }

        return this.noData(t, 'DROP');
    }
}

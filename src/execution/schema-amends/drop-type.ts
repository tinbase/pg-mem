import { _ISchema, _Transaction, _ISequence, _IStatementExecutor, _IStatement, asSeq, asType, _IType } from '../../interfaces-private';
import { DropStatement } from 'pgsql-ast-parser';
import { ExecHelper } from '../exec-utils';
import { ignore, notNil } from '../../utils';

export class DropType extends ExecHelper implements _IStatementExecutor {
    private types: _IType[];

    constructor({ schema }: _IStatement, statement: DropStatement) {
        super(statement);

        this.types = notNil(statement.names.map(x => asType(schema.getObject(x, {
            nullIfNotFound: statement.ifExists,
        }))));
        if (!this.types.length) {
            ignore(statement);
        }
    }

    execute(t: _Transaction) {

        // drop the sequence
        for (const seq of this.types) {
            seq.drop(t);
        }

        return this.noData(t, 'DROP');
    }
}

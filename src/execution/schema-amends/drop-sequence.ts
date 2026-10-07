import { _ISchema, _Transaction, _ISequence, _IStatementExecutor, _IStatement, asSeq } from '../../interfaces-private';
import { DropStatement } from 'pgsql-ast-parser';
import { ExecHelper } from '../exec-utils';
import { ignore, notNil } from '../../utils';

export class DropSequence extends ExecHelper implements _IStatementExecutor {
    private seqs: _ISequence[];

    constructor({ schema }: _IStatement, statement: DropStatement) {
        super(statement);

        this.seqs = notNil(statement.names.map(x => asSeq(schema.getObject(x, {
            nullIfNotFound: statement.ifExists,
        }))));
        if (!this.seqs.length) {
            ignore(statement);
        }
    }

    execute(t: _Transaction) {

        // drop the sequence
        for (const seq of this.seqs) {
            seq.drop(t);
        }

        return this.noData(t, 'DROP');
    }
}

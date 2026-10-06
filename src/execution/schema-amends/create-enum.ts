import { _Transaction, _ISchema, NotSupported, CreateIndexColDef, _ITable, CreateIndexDef, _IStatement, _IStatementExecutor } from '../../interfaces-private';
import { CreateEnumType } from 'pgsql-ast-parser';
import { ExecHelper } from '../exec-utils';

export class CreateEnum extends ExecHelper implements _IStatementExecutor {
    private onSchema: _ISchema;
    private values: string[];
    private name: string;

    constructor({ schema }: _IStatement, st: CreateEnumType) {
        super(st);
        this.onSchema = schema.getThisOrSiblingFor(st.name);
        this.values = st.values.map(x => x.value);
        this.name = st.name.name;
    }

    execute(t: _Transaction) {

        // register enum
        this.onSchema
            .registerEnum(this.name, this.values);
        return this.noData(t, 'CREATE');
    }
}

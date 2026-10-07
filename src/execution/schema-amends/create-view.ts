import { _Transaction, asTable, _ISchema, NotSupported, CreateIndexColDef, _ITable, CreateIndexDef, _IStatement, _IStatementExecutor, asView, _IView, QueryError } from '../../interfaces-private';
import { CreateViewStatement, SelectedColumn } from 'pgsql-ast-parser';
import { ExecHelper } from '../exec-utils';
import { ignore } from '../../utils';
import { View } from '../../schema/view';
import { buildSelect } from '../select';

export class CreateView extends ExecHelper implements _IStatementExecutor {
    private schema: _ISchema;
    private drop: boolean;
    existing: _IView | null;
    toRegister: View;


    constructor(st: _IStatement, p: CreateViewStatement) {
        super(p);
        this.schema = st.schema.getThisOrSiblingFor(p.name);
        // check existence
        this.existing = asView(this.schema.getObject(p.name, { nullIfNotFound: true }));
        ignore(p.orReplace);
        // WITH (security_invoker = true, security_barrier, ...): accepted; pg-mem evaluates a view's
        // query in the caller's context, which is what security_invoker asks for
        ignore(p.parameters);
        this.drop = !!(p.orReplace && this.existing);

        let view = buildSelect(p.query);

        // optional column mapping
        if (p.columnNames?.length) {
            if (p.columnNames.length > view.columns.length) {
                throw new QueryError('CREATE VIEW specifies more column names than columns', '42601');
            }
            view = view.select(view.columns.map<string | SelectedColumn>((x, i) => {
                const alias = p.columnNames?.[i]?.name;
                if (!alias) {
                    return x.id!;
                }
                return {
                    expr: { type: 'ref', name: x.id! },
                    alias: { name: alias },
                }
            }));
        }

        this.toRegister = new View(this.schema, p.name.name, view);
    }

    execute(t: _Transaction) {

        // drop if needed
        if (this.existing && this.drop) {
            this.existing.drop(t);
        }

        // view creation
        this.toRegister.register();
        return this.noData(t, 'CREATE');
    }
}

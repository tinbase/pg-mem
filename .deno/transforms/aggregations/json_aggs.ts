import { _ISelection, QueryError, AggregationComputer, IValue, _IType, _Transaction, AggregationGroupComputer } from '../../interfaces-private.ts';
import { ExprCall } from 'npm:@tinbase/pgsql-ast-parser@^12.1.0';
import { withSelection } from '../../parser/context.ts';
import { buildValue } from '../../parser/expression-builder.ts';
import { nullIsh } from '../../utils.ts';
import { Types } from '../../datatypes/index.ts';
import { toJsonValue } from '../../datatypes/json-numbers.ts';


class JsonAggExpr implements AggregationComputer<any[]> {

    constructor(private exp: IValue, readonly type: _IType) {
    }

    createGroup(t: _Transaction): AggregationGroupComputer<any[]> {
        let full: any[][] = [];
        return {
            feedItem: (item) => {
                const value = this.exp.get(item, t);
                if (!nullIsh(value)) {
                    // Same conversion row_to_json does: the aggregated body must
                    // carry json numbers for numeric/bigint, not the strings
                    // pg-mem holds them as internally.
                    full.push(toJsonValue(value, this.exp.type));
                }
            },
            finish: () => full.length === 0 ? null : full,
        }
    }
}


export function buildJsonAgg(this: void, base: _ISelection, call: ExprCall, fn: 'json_agg' | 'jsonb_agg') {
    return withSelection(base, () => {
        const args = call.args;
        if (args.length !== 1) {
            throw new QueryError(fn + ' expects one argument, given ' + args.length);
        }
        const type = fn === 'json_agg' ? Types.json : Types.jsonb;
        const what = buildValue(args[0]);
        return new JsonAggExpr(what, type);
    });
}

import { AggregationComputer, AggregationGroupComputer, IValue, nil, QueryError, _ISelection, _IType, _Transaction } from '../../interfaces-private';
import { ExprCall } from 'pgsql-ast-parser';
import { buildValue } from '../../parser/expression-builder';
import { Types } from '../../datatypes';
import { Decimal } from '../../datatypes/numeric';
import { nullIsh } from '../../utils';
import { withSelection } from '../../parser/context';


class AvgExpr implements AggregationComputer<number> {

    constructor(private exp: IValue) {
    }

    get type(): _IType<any> {
        return Types.bigint;
    }

    createGroup(t: _Transaction): AggregationGroupComputer<number> {
        let full: number[] = [];
        return {
            feedItem: (item) => {
                const value = this.exp.get(item, t);
                if (!nullIsh(value)) {
                    full.push(value);
                }
            },
            // summed exactly (numeric / bigint arrive as digit strings, and 0.1 + 0.2 must not drift)
            finish: () => full.length === 0
                ? null
                : full.reduce((acc, v) => acc.add(Decimal.fromText(String(v))), Decimal.fromNumber(0))
                    .div(Decimal.fromNumber(full.length))
                    .toNumber(),
        }
    }
}


export function buildAvg(this: void, base: _ISelection, call: ExprCall) {
    return withSelection(base, () => {
        const args = call.args;
        if (args.length !== 1) {
            throw new QueryError('AVG expects one argument, given ' + args.length);
        }

        const what = buildValue(args[0]);
        return new AvgExpr(what);
    });
}

import { AggregationComputer, AggregationGroupComputer, IValue, nil, QueryError, _ISelection, _IType, _Transaction } from '../../interfaces-private';
import { ExprCall } from 'pgsql-ast-parser';
import { buildValue } from '../../parser/expression-builder';
import { Types } from '../../datatypes';
import { Decimal } from '../../datatypes/numeric';
import { DataType } from '../../interfaces';
import { nullIsh } from '../../utils';
import { withSelection } from '../../parser/context';

class SumExpr implements AggregationComputer<any> {

    constructor(private exp: IValue) {
    }

    /** sum(numeric) and sum(bigint) are numeric in postgres; the others keep their kind */
    get type(): _IType<any> {
        switch (this.exp.type.primary) {
            case DataType.decimal:
            case DataType.bigint:
                return Types.decimal();
            case DataType.float:
                return Types.float;
            default:
                return Types.integer;
        }
    }

    createGroup(t: _Transaction): AggregationGroupComputer<any> {
        // numeric and bigint are held as digit strings: add them exactly (`+` concatenated them)
        const exact = this.exp.type.primary === DataType.decimal || this.exp.type.primary === DataType.bigint;
        let val: any = null;
        return {
            feedItem: (item) => {
                const value = this.exp.get(item, t);
                if (nullIsh(value)) {
                    return;
                }
                if (exact) {
                    const d = Decimal.fromText(String(value));
                    val = nullIsh(val) ? d : (val as Decimal).add(d);
                } else {
                    val = nullIsh(val) ? value : val + value;
                }
            },
            finish: () => exact && !nullIsh(val) ? (val as Decimal).toString() : val,
        }
    }
}

export function buildSum(this: void, base: _ISelection, call: ExprCall) {
    return withSelection(base, () => {
        const args = call.args;
        if (args.length !== 1) {
            throw new QueryError('SUM expects one argument, given ' + args.length);
        }

        const what = buildValue(args[0]);
        return new SumExpr(what);

    });
}

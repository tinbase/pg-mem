import { AggregationComputer, AggregationGroupComputer, IValue, nil, QueryError, _ISelection, _IType, _Transaction } from '../../interfaces-private';
import { Expr } from 'pgsql-ast-parser';
import { buildValue } from '../../parser/expression-builder';
import { nullIsh } from '../../utils';
import { DataType } from '../../interfaces';
import { withSelection } from '../../parser/context';


class MinMax implements AggregationComputer<number> {

    constructor(private exp: IValue, private isMax: boolean) {
    }

    get type(): _IType<any> {
        return this.exp.type;
    }

    createGroup(t: _Transaction): AggregationGroupComputer<number> {
        let val: number | nil = null;
        return {
            feedItem: (item) => {
                const value = this.exp.get(item, t);
                // compare as the type does (numeric/bigint are digit strings: '9' > '10' as text)
                if (!nullIsh(value) && (nullIsh(val) || (
                    this.isMax
                        ? this.exp.type.gt(value, val)
                        : this.exp.type.lt(value, val)
                ))) {
                    val = value;
                }
            },
            finish: () => val,
        };
    }
}


export function buildMinMax(this: void, base: _ISelection, args: Expr[], op: 'max' | 'min') {
    return withSelection(base, () => {
        if (args.length !== 1) {
            throw new QueryError(op.toUpperCase() + ' expects one argument, given ' + args.length);
        }

        const what = buildValue(args[0]);

        switch (what.type.primary) {
            case DataType.bigint:
            case DataType.integer:
            case DataType.decimal:
            case DataType.date:
            case DataType.float:
            case DataType.text:
            case DataType.time:
            case DataType.timetz:
            case DataType.timestamp:
            case DataType.timestamptz:
                break;
            default:
                // enums (max(priority)) compare in declaration order
                if (Array.isArray((what.type as any).values)) {
                    break;
                }
                throw new QueryError(`function ${op}(${what.type.primary}) does not exist`, '42883');
        }
        return new MinMax(what, op === 'max');
    });
}

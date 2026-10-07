import { IValue, _ISelection, _Transaction, _Explainer, _SelectExplanation, Stats, _IAggregation, Row } from '../interfaces-private';
import { FilterBase } from './transform-base';
import { OrderByStatement, ExprCall } from 'pgsql-ast-parser';
import { buildValue } from '../parser/expression-builder';
import { nullIsh } from '../utils';
import { withSelection } from '../parser/context';

export function buildOrderBy(on: _ISelection, order: OrderByStatement[]) {
    return new OrderBy(on, order);
}

export interface SortKey {
    by: IValue;
    order: 'ASC' | 'DESC';
    nullsLast: boolean;
}

/** ORDER BY items as sort keys (build them within the selection they read) */
export function buildSortKeys(order: OrderByStatement[]): SortKey[] {
    return order.map(x => {
        const dir = x.order ?? 'ASC';
        return {
            by: buildValue(x.by),
            order: dir,
            // postgres: NULLS LAST by default ascending, NULLS FIRST descending
            nullsLast: dir === 'ASC' ? x.nulls !== 'FIRST' : x.nulls === 'LAST',
        };
    });
}

/** a row comparator for Array.sort, following postgres' ORDER BY rules */
export function compareRows(keys: SortKey[], t: _Transaction): (a: Row, b: Row) => number {
    return (a, b) => {
        for (const o of keys) {
            const aval = o.by.get(a, t);
            const bval = o.by.get(b, t);
            const na = nullIsh(aval);
            const nb = nullIsh(bval);
            if (na && nb) {
                continue;
            }
            if (na || nb) {
                return nb === o.nullsLast ? -1 : 1;
            }
            if (o.by.type.equals(aval, bval)) {
                continue;
            }
            if (o.by.type.gt(aval, bval)) {
                return o.order === 'ASC' ? 1 : -1;
            }
            return o.order === 'ASC' ? -1 : 1;
        }
        return 0;
    };
}

class OrderBy extends FilterBase implements _IAggregation {
    order: SortKey[];

    get index() {
        return null;
    }

    isAggregation(): this is _IAggregation {
        return this.selection.isAggregation();
    }

    getAggregation(name: string, call: ExprCall): IValue {
        return this.asAggreg.getAggregation(name, call);
    }

    checkIfIsKey(got: IValue): IValue {
        return this.asAggreg.checkIfIsKey(got);
    }

    private get asAggreg(): _IAggregation {

        if (!this.selection.isAggregation()) {
            throw new Error('Not an aggregation');
        }
        return this.selection;
    }

    entropy(t: _Transaction) {
        const ret = this.selection.entropy(t);
        // sort algorithm is n*log(n)
        return ret * Math.log(ret + 1);
    }

    hasItem(raw: Row, t: _Transaction): boolean {
        return this.base.hasItem(raw, t);
    }

    constructor(private selection: _ISelection, order: OrderByStatement[]) {
        super(selection);
        this.order = withSelection(selection, () => buildSortKeys(order));
    }


    stats(t: _Transaction): Stats | null {
        return this.base.stats(t);
    }


    getIndex(...forValue: IValue[]) {
        // same index as underlying selection, given that ordering does not modify indices.
        return this.base.getIndex(...forValue);
    }

    enumerate(t: _Transaction): Iterable<Row> {
        const all = [...this.base.enumerate(t)];
        all.sort(compareRows(this.order, t));
        return all;
    }

    explain(e: _Explainer): _SelectExplanation {
        return {
            id: e.idFor(this),
            _: 'orderBy',
            of: this.selection.explain(e),
        };
    }
}
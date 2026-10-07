import { _Transaction, IValue, _Explainer, _IIndex, _SelectExplanation, Stats } from '../interfaces-private';
import { RecordCol } from '../datatypes';
import { buildCtx } from '../parser/context';
import { DataSourceBase } from '../transforms/transform-base';
import { columnEvaluator } from '../transforms/selection';
import { colByName, fromEntries } from '../utils';

export class FunctionCallTable extends DataSourceBase {
    readonly columns: readonly IValue[];
    private readonly colsByName: Map<string, IValue>;
    private symbol = Symbol();

    get isExecutionWithNoResult(): boolean {
        return false;
    }

    constructor(cols: readonly RecordCol[], private evaluator: IValue) {
        super(buildCtx().schema);
        this.columns = cols.map(c => columnEvaluator(this, c.name, c.type).setOrigin(this));
        this.colsByName = fromEntries(this.columns.map(c => [c.id!, c]));
    }

    entropy(t: _Transaction): number {
        return 0;
    }

    enumerate(t: _Transaction): Iterable<any> {
        // nothing precedes this FROM item, so the arguments read no row: they are constants, or
        // outer-query references in a correlated subquery (`from jsonb_array_elements(outer.col)`),
        // which are bound per outer row before this runs - evaluated now, not as constants
        const results = this.evaluator.isConstant
            ? this.evaluator.get()
            : this.evaluator.get({}, t);
        for (const result of results ?? []) {
            result[this.symbol] = true;
        }
        return results;
    }

    hasItem(value: any, t: _Transaction): boolean {
        return !!(value as any)[this.symbol];
    }

    getColumn(column: string, nullIfNotFound?: boolean | undefined): IValue {
        return colByName(this.colsByName, column, nullIfNotFound)!;
    }

    getIndex(forValue: IValue): _IIndex | null | undefined {
        return null;
    }

    isOriginOf(value: IValue): boolean {
        return value.origin === this;
    }


    explain(e: _Explainer): _SelectExplanation {
        return {
            id: e.idFor(this),
            _: 'table',
            table: 'function call',
        } as any;
    }

    stats(t: _Transaction): Stats | null {
        return null;
    }
}

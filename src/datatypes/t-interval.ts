import { DataType, nil, _IType } from '../interfaces-private';
import { Interval, normalizeInterval, parseIntervalLiteral, intervalToString } from 'pgsql-ast-parser';
import { TypeBase } from './datatype-base';
import { Evaluator } from '../evaluator';
import { intervalToSec } from '../utils';

export class IntervalType extends TypeBase<Interval> {

    get primary(): DataType {
        return DataType.interval;
    }

    doCanBuildFrom(from: _IType) {
        switch (from.primary) {
            case DataType.text:
                return true;
        }
        return false;
    }

    doBuildFrom(value: Evaluator, from: _IType): Evaluator<Interval> | nil {
        switch (from.primary) {
            case DataType.text:
                return value
                    .setConversion(str => {
                        const conv = normalizeInterval(parseIntervalLiteral(str));
                        return conv;
                    }
                        , toInterval => ({ toInterval }));
        }
        return null;
    }

    doCanCast(to: _IType) {
        return to.primary === DataType.text;
    }

    doCast(value: Evaluator<Interval>, to: _IType): Evaluator<any> | nil {
        if (to.primary !== DataType.text) {
            return null;
        }
        return value
            .setType(to)
            .setConversion((i: Interval) => pgIntervalText(i), intervalToText => ({ intervalToText }));
    }

    doEquals(a: Interval, b: Interval): boolean {
        return intervalToSec(a) === intervalToSec(b);
    }
    doGt(a: Interval, b: Interval): boolean {
        return intervalToSec(a) > intervalToSec(b);
    }
    doLt(a: Interval, b: Interval): boolean {
        return intervalToSec(a) < intervalToSec(b);
    }
}

/** postgres' default (IntervalStyle = postgres) text form: "1 year 2 mons 3 days 04:05:06", "00:00:00" for zero */
function pgIntervalText(i: Interval): string {
    const txt = String(intervalToString(i))
        .replace(/(-?\d+) months?\b/, (_, n) => `${n} ${Math.abs(Number(n)) === 1 ? 'mon' : 'mons'}`)
        .trim();
    return txt || '00:00:00';
}

import { _IConstraint, _Transaction } from '../interfaces-private.ts';

export class ConstraintWrapper implements _IConstraint {
    constructor(private refs: Map<string, _IConstraint>, private inner: _IConstraint) {
        if (inner.name) {
            refs.set(inner.name, this);
        }
    }
    get name() {
        return this.inner.name;
    }

    /**
     * The constraint this wraps.
     *
     * Needed by the catalogues: the map holds wrappers, so introspection that looks for a foreign
     * key finds only the wrapper's own (empty) shape unless it can reach through.
     */
    get wrapped(): _IConstraint {
        return this.inner;
    }

    /** Forwarded so a caller can classify a constraint without unwrapping it first. */
    get constraintKind(): string | undefined {
        return (this.inner as any).constraintKind;
    }
    uninstall(t: _Transaction): void {
        this.inner.uninstall(t);
        if (this.name) {
            this.refs.delete(this.name);
        }
    }
}

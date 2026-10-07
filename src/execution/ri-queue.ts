/**
 * Referential actions run the way postgres runs its RI triggers: queued as AFTER events and fired
 * in order once the statement's own rows are done. A cascade's own RI events are appended to the
 * SAME queue (postgres runs RI actions with fire_triggers = false), so actions run breadth-first:
 * deleting a user checks a direct NO ACTION reference BEFORE a grandchild cascade (user ->
 * profile -> rows) has removed the rows - and fails, like postgres does.
 *
 * Each statement execution has its own queue (a statement run by a trigger fires its RI events at
 * its own end). Outside any statement (the JS table API) actions run immediately.
 */
const queues: (() => void)[][] = [];

export function withRiQueue<T>(run: () => T): T {
    const queue: (() => void)[] = [];
    queues.push(queue);
    try {
        const ret = run();
        while (queue.length) {
            queue.shift()!();
        }
        return ret;
    } finally {
        queues.pop();
    }
}

export function enqueueRi(action: () => void): void {
    const queue = queues[queues.length - 1];
    if (queue) {
        queue.push(action);
    } else {
        action();
    }
}

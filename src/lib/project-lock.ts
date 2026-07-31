/**
 * Process-wide async mutex for write/edit/bash serialization.
 */
export class ProjectLock {
    private tail: Promise<unknown> = Promise.resolve();

    /**
     * Run `task` exclusively (no concurrent mutating tool calls).
     *
     * @param task - Async work to run under the lock
     * @returns Task result
     */
    async runExclusive<T>(task: () => Promise<T>): Promise<T> {
        const previous = this.tail;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        this.tail = previous.then(() => gate);

        await previous.catch(() => undefined);
        try {
            return await task();
        } finally {
            release();
        }
    }
}

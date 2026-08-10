/** Minimal FIFO async mutex for serializing lifecycle/state transitions. */
export class AsyncMutex {
    private tail: Promise<void> = Promise.resolve();

    async runExclusive<T>(task: () => Promise<T>): Promise<T> {
        const previous = this.tail;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        this.tail = previous.then(() => gate, () => gate);
        await previous.catch(() => undefined);
        try {
            return await task();
        } finally {
            release();
        }
    }
}

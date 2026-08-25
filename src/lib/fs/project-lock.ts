/**
 * Process-wide async mutex for transactional file mutation serialization.
 */
export class ProjectLock {
    private tail: Promise<unknown> = Promise.resolve();

    
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

/**
 * Bounded text buffer optimized for append-heavy process output.
 *
 * Chunks stay separate while the process is producing output, avoiding repeated
 * whole-buffer string copies. Materialization happens only when a caller peeks
 * or consumes the buffer.
 */
export class RollingTextBuffer {
    private chunks: string[] = [];
    private head = 0;
    private bufferedChars = 0;

    constructor(private readonly maxChars: number) {
        if (!Number.isInteger(maxChars) || maxChars <= 0) {
            throw new Error("Rolling text buffer maxChars must be a positive integer");
        }
    }

    get length(): number {
        return this.bufferedChars;
    }

    /** Append text and return true when older text had to be discarded. */
    append(text: string): boolean {
        if (!text) return false;
        if (text.length >= this.maxChars) {
            const truncated = this.bufferedChars > 0 || text.length > this.maxChars;
            this.chunks = [text.slice(-this.maxChars)];
            this.head = 0;
            this.bufferedChars = this.maxChars;
            return truncated;
        }

        this.chunks.push(text);
        this.bufferedChars += text.length;
        return this.trimTo(this.maxChars);
    }

    /** Keep only the newest maxChars characters; returns true when trimmed. */
    trimTo(maxChars: number): boolean {
        const target = Math.max(0, Math.min(Math.floor(maxChars), this.maxChars));
        if (this.bufferedChars <= target) return false;

        let excess = this.bufferedChars - target;
        while (excess > 0 && this.head < this.chunks.length) {
            const chunk = this.chunks[this.head]!;
            if (chunk.length <= excess) {
                excess -= chunk.length;
                this.bufferedChars -= chunk.length;
                this.head += 1;
                continue;
            }
            this.chunks[this.head] = chunk.slice(excess);
            this.bufferedChars -= excess;
            excess = 0;
        }
        this.compactIfNeeded();
        return true;
    }

    toString(): string {
        if (this.bufferedChars === 0) return "";
        if (this.head === 0) return this.chunks.join("");
        return this.chunks.slice(this.head).join("");
    }

    clear(): void {
        this.chunks = [];
        this.head = 0;
        this.bufferedChars = 0;
    }

    private compactIfNeeded(): void {
        if (this.head === 0) return;
        if (this.head < 64 && this.head * 2 < this.chunks.length) return;
        this.chunks = this.chunks.slice(this.head);
        this.head = 0;
    }
}

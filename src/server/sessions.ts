export interface ClosableMcpTransport {
    close(): Promise<void>;
}

export interface McpSessionCloseResult {
    sessionId: string;
    error?: unknown;
}

interface McpSessionEntry<TTransport> {
    transport: TTransport;
    ownerClientId?: string;
    lastActivityAt: number;
}

export class McpSessionRegistry<TTransport extends ClosableMcpTransport> {
    private readonly sessions = new Map<string, McpSessionEntry<TTransport>>();
    private readonly now: () => number;

    constructor(options: { now?: () => number } = {}) {
        this.now = options.now ?? Date.now;
    }

    
    get size(): number {
        return this.sessions.size;
    }

    
    register(sessionId: string, transport: TTransport, ownerClientId?: string): void {
        this.sessions.set(sessionId, {
            transport,
            ownerClientId,
            lastActivityAt: this.now(),
        });
    }

    
    get(sessionId: string, ownerClientId?: string): TTransport | undefined {
        const entry = this.sessions.get(sessionId);
        if (!entry || entry.ownerClientId !== ownerClientId) return undefined;
        entry.lastActivityAt = this.now();
        return entry.transport;
    }

    
    remove(sessionId: string): boolean {
        return this.sessions.delete(sessionId);
    }

    
    async closeIdle(idleTimeoutMs: number): Promise<McpSessionCloseResult[]> {
        const cutoff = this.now() - idleTimeoutMs;
        const idle: Array<{ sessionId: string; transport: TTransport }> = [];

        for (const [sessionId, entry] of this.sessions) {
            if (entry.lastActivityAt > cutoff) continue;
            this.sessions.delete(sessionId);
            idle.push({ sessionId, transport: entry.transport });
        }

        return closeSessions(idle);
    }

    
    async closeAll(): Promise<McpSessionCloseResult[]> {
        const all = Array.from(this.sessions, ([sessionId, entry]) => ({
            sessionId,
            transport: entry.transport,
        }));
        this.sessions.clear();
        return closeSessions(all);
    }
}

async function closeSessions<TTransport extends ClosableMcpTransport>(
    sessions: Array<{ sessionId: string; transport: TTransport }>,
): Promise<McpSessionCloseResult[]> {
    return Promise.all(
        sessions.map(async ({ sessionId, transport }) => {
            try {
                await transport.close();
                return { sessionId };
            } catch (error) {
                return { sessionId, error };
            }
        }),
    );
}

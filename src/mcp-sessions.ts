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

/**
 * In-memory MCP session registry keyed by session id.
 */
export class McpSessionRegistry<TTransport extends ClosableMcpTransport> {
    private readonly sessions = new Map<string, McpSessionEntry<TTransport>>();
    private readonly now: () => number;

    constructor(options: { now?: () => number } = {}) {
        this.now = options.now ?? Date.now;
    }

    /**
     * Number of live sessions.
     *
     * @returns Session count
     */
    get size(): number {
        return this.sessions.size;
    }

    /**
     * Register a transport under a session id.
     *
     * @param sessionId - MCP session id
     * @param transport - Streamable HTTP transport
     * @param ownerClientId - OAuth client that created the session; undefined in local noauth mode
     */
    register(sessionId: string, transport: TTransport, ownerClientId?: string): void {
        this.sessions.set(sessionId, {
            transport,
            ownerClientId,
            lastActivityAt: this.now(),
        });
    }

    /**
     * Fetch a session transport and refresh activity time.
     *
     * @param sessionId - MCP session id
     * @param ownerClientId - Current OAuth client; must match the creator in public mode
     * @returns Transport or undefined
     */
    get(sessionId: string, ownerClientId?: string): TTransport | undefined {
        const entry = this.sessions.get(sessionId);
        if (!entry || entry.ownerClientId !== ownerClientId) return undefined;
        entry.lastActivityAt = this.now();
        return entry.transport;
    }

    /**
     * Remove a session without closing it.
     *
     * @param sessionId - MCP session id
     * @returns True when removed
     */
    remove(sessionId: string): boolean {
        return this.sessions.delete(sessionId);
    }

    /**
     * Close sessions idle longer than the timeout.
     *
     * @param idleTimeoutMs - Idle threshold
     * @returns Close results
     */
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

    /**
     * Close every session.
     *
     * @returns Close results
     */
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

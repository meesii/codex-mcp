import {
    loadBindingsFile,
    saveBindingsFile,
    type SessionBinding,
} from "../daemon/state.js";
import { writeRuntimeLog } from "../lib/runtime-log.js";
import { AsyncMutex } from "../lib/util/mutex.js";

const DEFAULT_BINDING_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000;
const BINDING_TOUCH_INTERVAL_MS = 10 * 60 * 1_000;

/**
 * Durable map from conversation owner key to bound project id.
 *
 * Owner keys reuse the permission/process namespace: `<oauth/local owner>|openai-session:<id>`,
 * then `<oauth/local owner>|mcp-session:<id>`, then the OAuth/local fallback id.
 * The key is a routing correlation value, not an authorization secret; the
 * OAuth/password boundary still protects /mcp.
 */
export class BindingStore {
    private bindings: SessionBinding[];
    private readonly save: (bindings: SessionBinding[]) => Promise<void>;
    private readonly mutex = new AsyncMutex();

    constructor(options: {
        bindings?: SessionBinding[];
        save?: (bindings: SessionBinding[]) => Promise<void>;
    } = {}) {
        this.save = options.save ?? saveBindingsFile;
        this.bindings = (options.bindings ?? loadBindingsFile()).map((item) => ({ ...item }));
    }

    resolve(ownerKey: string): SessionBinding | undefined {
        const binding = this.bindings.find((item) => item.ownerKey === ownerKey);
        return binding ? { ...binding } : undefined;
    }

    /** Bind (or rebind) an owner key to a project. Never stores tool/command data. */
    async bind(ownerKey: string, projectId: string): Promise<SessionBinding> {
        return await this.mutex.runExclusive(async () => {
            const now = new Date().toISOString();
            const existing = this.resolve(ownerKey);
            const updated: SessionBinding = existing
                ? { ...existing, projectId, boundAt: now, lastSeenAt: now }
                : { ownerKey, projectId, boundAt: now, lastSeenAt: now };
            const nextBindings = [
                ...this.bindings.filter((item) => item.ownerKey !== ownerKey),
                updated,
            ];
            await this.persist(nextBindings);
            this.bindings = nextBindings;
            return { ...updated };
        });
    }

    /**
     * Refresh the durable last-seen marker for a conversation at a coarse cadence.
     * Binding expiry is measured in months, so rewriting the whole state file on
     * every tool call would only add disk churn and mutex contention.
     */
    async touch(ownerKey: string, now = Date.now()): Promise<void> {
        await this.mutex.runExclusive(async () => {
            const binding = this.resolve(ownerKey);
            if (!binding) return;
            const previous = Date.parse(binding.lastSeenAt);
            if (Number.isFinite(previous) && now - previous < BINDING_TOUCH_INTERVAL_MS) return;
            const updated = { ...binding, lastSeenAt: new Date(now).toISOString() };
            const nextBindings = [
                ...this.bindings.filter((item) => item.ownerKey !== ownerKey),
                updated,
            ];
            await this.persist(nextBindings);
            this.bindings = nextBindings;
        });
    }

    async unbind(ownerKey: string): Promise<boolean> {
        return await this.mutex.runExclusive(async () => {
            const lengthBefore = this.bindings.length;
            const nextBindings = this.bindings.filter((item) => item.ownerKey !== ownerKey);
            const removed = nextBindings.length !== lengthBefore;
            if (removed) {
                await this.persist(nextBindings);
                this.bindings = nextBindings;
            }
            return removed;
        });
    }

    list(): SessionBinding[] {
        return this.bindings.map((item) => ({ ...item }));
    }

    countForProject(projectId: string): number {
        return this.bindings.filter((item) => item.projectId === projectId).length;
    }

    /** Remove only the requested owner keys from one project, preserving bindings created later. */
    async removeFromProject(projectId: string, ownerKeys: Iterable<string>): Promise<number> {
        const targets = new Set(ownerKeys);
        if (targets.size === 0) return 0;
        return await this.mutex.runExclusive(async () => {
            const remaining = this.bindings.filter(
                (item) => item.projectId !== projectId || !targets.has(item.ownerKey),
            );
            const removed = this.bindings.length - remaining.length;
            if (removed > 0) {
                await this.persist(remaining);
                this.bindings = remaining;
            }
            return removed;
        });
    }

    /** Drop every binding that points at a deactivated project. */
    async invalidateProject(projectId: string): Promise<number> {
        return await this.mutex.runExclusive(async () => {
            const remaining = this.bindings.filter((item) => item.projectId !== projectId);
            const removed = this.bindings.length - remaining.length;
            if (removed > 0) {
                await this.persist(remaining);
                this.bindings = remaining;
            }
            return removed;
        });
    }

    /** Remove inactive conversation bindings so durable state remains bounded. */
    async pruneStale(maxAgeMs = DEFAULT_BINDING_MAX_AGE_MS, now = Date.now()): Promise<number> {
        if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
            throw new Error("Binding max age must be a non-negative finite number");
        }
        return await this.mutex.runExclusive(async () => {
            const cutoff = now - maxAgeMs;
            const remaining = this.bindings.filter((item) => {
                const lastSeen = Date.parse(item.lastSeenAt);
                return Number.isFinite(lastSeen) && lastSeen >= cutoff;
            });
            const removed = this.bindings.length - remaining.length;
            if (removed > 0) {
                await this.persist(remaining);
                this.bindings = remaining;
                writeRuntimeLog("info", "stale_bindings_pruned", { removed, maxAgeMs });
            }
            return removed;
        });
    }

    private async persist(bindings: SessionBinding[]): Promise<void> {
        try {
            await this.save(bindings);
        } catch (error: unknown) {
            const detail = error instanceof Error ? error.message : String(error);
            writeRuntimeLog("error", "binding_state_save_failed", { error: detail });
            throw error;
        }
    }
}

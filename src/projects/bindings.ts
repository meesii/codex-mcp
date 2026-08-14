import {
    loadBindingsFile,
    saveBindingsFile,
    type SessionBinding,
} from "../daemon/state.js";
import { writeRuntimeLog } from "../lib/runtime-log.js";

const DEFAULT_BINDING_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000;

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

    constructor(options: {
        bindings?: SessionBinding[];
        save?: (bindings: SessionBinding[]) => Promise<void>;
        /** Disable startup GC only for deterministic tests/migrations. */
        pruneOnLoad?: boolean;
    } = {}) {
        this.save = options.save ?? saveBindingsFile;
        this.bindings = (options.bindings ?? loadBindingsFile()).map((item) => ({ ...item }));
        if (options.pruneOnLoad !== false) this.pruneStale();
    }

    resolve(ownerKey: string): SessionBinding | undefined {
        return this.bindings.find((item) => item.ownerKey === ownerKey);
    }

    /** Bind (or rebind) an owner key to a project. Never stores tool/command data. */
    bind(ownerKey: string, projectId: string): SessionBinding {
        const now = new Date().toISOString();
        const existing = this.resolve(ownerKey);
        const updated: SessionBinding = existing
            ? { ...existing, projectId, boundAt: now, lastSeenAt: now }
            : { ownerKey, projectId, boundAt: now, lastSeenAt: now };
        this.bindings = [
            ...this.bindings.filter((item) => item.ownerKey !== ownerKey),
            updated,
        ];
        this.persist();
        return { ...updated };
    }

    /** Refresh the last-seen marker for a conversation. */
    touch(ownerKey: string): void {
        const binding = this.resolve(ownerKey);
        if (!binding) return;
        binding.lastSeenAt = new Date().toISOString();
        this.bindings = [
            ...this.bindings.filter((item) => item.ownerKey !== ownerKey),
            binding,
        ];
        this.persist();
    }

    unbind(ownerKey: string): boolean {
        const lengthBefore = this.bindings.length;
        this.bindings = this.bindings.filter((item) => item.ownerKey !== ownerKey);
        const removed = this.bindings.length !== lengthBefore;
        if (removed) this.persist();
        return removed;
    }

    list(): SessionBinding[] {
        return [...this.bindings];
    }

    countForProject(projectId: string): number {
        return this.bindings.filter((item) => item.projectId === projectId).length;
    }

    /** Drop every binding that points at a deactivated project. */
    invalidateProject(projectId: string): number {
        const remaining = this.bindings.filter((item) => item.projectId !== projectId);
        const removed = this.bindings.length - remaining.length;
        if (removed > 0) {
            this.bindings = remaining;
            this.persist();
        }
        return removed;
    }

    /** Remove inactive conversation bindings so durable state remains bounded. */
    pruneStale(maxAgeMs = DEFAULT_BINDING_MAX_AGE_MS, now = Date.now()): number {
        if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
            throw new Error("Binding max age must be a non-negative finite number");
        }
        const cutoff = now - maxAgeMs;
        const remaining = this.bindings.filter((item) => {
            const lastSeen = Date.parse(item.lastSeenAt);
            return Number.isFinite(lastSeen) && lastSeen >= cutoff;
        });
        const removed = this.bindings.length - remaining.length;
        if (removed > 0) {
            this.bindings = remaining;
            this.persist();
            writeRuntimeLog("info", "stale_bindings_pruned", { removed, maxAgeMs });
        }
        return removed;
    }

    private persist(): void {
        this.save(this.bindings).catch((error: unknown) => {
            const detail = error instanceof Error ? error.message : String(error);
            writeRuntimeLog("error", "binding_state_save_failed", { error: detail });
        });
    }
}

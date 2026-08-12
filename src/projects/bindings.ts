import {
    loadBindingsFile,
    saveBindingsFile,
    type SessionBinding,
} from "../daemon/state.js";
import { writeRuntimeLog } from "../lib/runtime-log.js";

/**
 * Durable map from conversation owner key to bound project id.
 *
 * Owner keys are `openai-session:<id>`, then `mcp-session:<id>`, then the
 * OAuth/local client fallback id. The key is a routing correlation value, not
 * an authorization secret; the OAuth/password boundary still protects /mcp.
 */
export class BindingStore {
    private bindings: SessionBinding[];
    private readonly save: (bindings: SessionBinding[]) => Promise<void>;

    constructor(options: {
        bindings?: SessionBinding[];
        save?: (bindings: SessionBinding[]) => Promise<void>;
    } = {}) {
        this.bindings = (options.bindings ?? loadBindingsFile()).map((item) => ({ ...item }));
        this.save = options.save ?? saveBindingsFile;
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

    private persist(): void {
        this.save(this.bindings).catch((error: unknown) => {
            const detail = error instanceof Error ? error.message : String(error);
            writeRuntimeLog("error", "binding_state_save_failed", { error: detail });
        });
    }
}

import { ProcessSessionManager } from "./sessions.js";

const DEFAULT_RELEASE_GRACE_MS = 5 * 60 * 1000;

interface ProcessOwnerEntry {
    processes: ProcessSessionManager;
    leases: number;
    cleanupTimer?: NodeJS.Timeout;
}

export interface ProcessOwnerLease {
    processes: ProcessSessionManager;
    release: () => void;
}

/**
 * Keep process ownership stable across transient MCP transport sessions.
 *
 * Multiple transports for the same authenticated owner share one process scope,
 * while different owners remain isolated. When the last transport disconnects,
 * the owner's processes are kept for a short reconnect grace period before
 * being terminated.
 */
export class ProcessOwnerPool {
    private readonly owners = new Map<string, ProcessOwnerEntry>();

    constructor(
        private readonly root: ProcessSessionManager,
        private readonly releaseGraceMs = DEFAULT_RELEASE_GRACE_MS,
    ) {
        if (!Number.isFinite(releaseGraceMs) || releaseGraceMs < 0) {
            throw new Error("Process owner release grace must be a non-negative number");
        }
    }

    acquire(ownerId: string): ProcessOwnerLease {
        if (!ownerId) throw new Error("Process owner id is required");

        let entry = this.owners.get(ownerId);
        if (!entry) {
            entry = {
                processes: this.root.scope(ownerId),
                leases: 0,
            };
            this.owners.set(ownerId, entry);
        }

        if (entry.cleanupTimer) {
            clearTimeout(entry.cleanupTimer);
            entry.cleanupTimer = undefined;
        }
        entry.leases += 1;

        let released = false;
        return {
            processes: entry.processes,
            release: () => {
                if (released) return;
                released = true;
                this.release(ownerId, entry!);
            },
        };
    }

    async shutdown(): Promise<void> {
        for (const entry of this.owners.values()) {
            if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
        }
        this.owners.clear();
        await this.root.shutdown();
    }

    private release(ownerId: string, entry: ProcessOwnerEntry): void {
        if (this.owners.get(ownerId) !== entry || entry.leases === 0) return;

        entry.leases -= 1;
        if (entry.leases > 0) return;

        entry.cleanupTimer = setTimeout(() => {
            if (this.owners.get(ownerId) !== entry || entry.leases > 0) return;
            this.owners.delete(ownerId);
            void entry.processes.shutdown().catch(() => undefined);
        }, this.releaseGraceMs);
        entry.cleanupTimer.unref();
    }
}

import type { PermissionCapability, PermissionGrant, PermissionGrantDuration } from "./types.js";
import { isPathInsideRoot } from "../lib/fs/path-guard.js";

interface EphemeralPermissionGrant extends PermissionGrant {
    duration: Exclude<PermissionGrantDuration, "permanent">;
}

/**
 * Process-lifetime permission state shared across stateless MCP requests.
 * Grants are partitioned by the stable authenticated client owner id.
 */
export class PermissionRuntime {
    private readonly grants = new Map<string, EphemeralPermissionGrant[]>();

    list(ownerId: string): EphemeralPermissionGrant[] {
        return (this.grants.get(ownerId) ?? []).map((grant) => ({ ...grant }));
    }

    uncoveredTargets(
        ownerId: string,
        capability: PermissionCapability,
        targets: string[],
    ): string[] {
        const grants = (this.grants.get(ownerId) ?? []).filter(
            (grant) => grant.capability === capability,
        );
        return targets.filter(
            (target) => !grants.some((grant) => isPathInsideRoot(target, grant.path)),
        );
    }

    consumeGrant(ownerId: string, capability: PermissionCapability, targets: string[]): boolean {
        const grants = this.grants.get(ownerId) ?? [];
        const selected = new Set<number>();

        for (const target of targets) {
            let index = grants.findIndex(
                (grant) =>
                    grant.capability === capability &&
                    grant.duration === "session" &&
                    isPathInsideRoot(target, grant.path),
            );
            if (index < 0) {
                index = grants.findIndex(
                    (grant) =>
                        grant.capability === capability &&
                        grant.duration === "once" &&
                        isPathInsideRoot(target, grant.path),
                );
            }
            if (index < 0) return false;
            if (grants[index]!.duration === "once") selected.add(index);
        }

        for (const index of [...selected].sort((left, right) => right - left)) {
            grants.splice(index, 1);
        }
        if (grants.length === 0) this.grants.delete(ownerId);
        return true;
    }

    addGrant(
        ownerId: string,
        grant: PermissionGrant,
        duration: "once" | "session",
    ): void {
        const grants = this.grants.get(ownerId) ?? [];
        if (
            duration === "session" &&
            grants.some(
                (item) =>
                    item.duration === "session" &&
                    item.capability === grant.capability &&
                    item.path === grant.path,
            )
        ) {
            return;
        }
        grants.push({ ...grant, duration });
        this.grants.set(ownerId, grants);
    }

    removeGrant(ownerId: string, grant: PermissionGrant): number {
        const grants = this.grants.get(ownerId) ?? [];
        const kept = grants.filter(
            (item) => item.capability !== grant.capability || item.path !== grant.path,
        );
        const removed = grants.length - kept.length;
        if (removed === 0) return 0;
        if (kept.length === 0) this.grants.delete(ownerId);
        else this.grants.set(ownerId, kept);
        return removed;
    }

    clearOwner(ownerId: string): void {
        this.grants.delete(ownerId);
    }

    clear(): void {
        this.grants.clear();
    }
}

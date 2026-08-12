import type { PermissionCapability, PermissionGrant } from "./types.js";
import {
    loadUserConfig,
    saveUserConfig,
    type PermissionGrantConfig,
} from "../config/user-config.js";

export interface PermissionGrantStore {
    list(): PermissionGrant[];
    add(grant: PermissionGrant): void;
    remove(grant: PermissionGrant): number;
}

export class UserConfigPermissionGrantStore implements PermissionGrantStore {
    list(): PermissionGrant[] {
        return (loadUserConfig().permissions?.grants ?? []).map(fromConfigGrant);
    }

    add(grant: PermissionGrant): void {
        const current = this.list();
        if (
            current.some(
                (item) => item.capability === grant.capability && item.path === grant.path,
            )
        ) {
            return;
        }
        const grants = [...current, grant].map(toConfigGrant);
        saveUserConfig({ permissions: { grants } });
    }

    remove(grant: PermissionGrant): number {
        const current = this.list();
        const grants = current.filter(
            (item) => item.capability !== grant.capability || item.path !== grant.path,
        );
        const removed = current.length - grants.length;
        if (removed > 0) {
            saveUserConfig({ permissions: { grants: grants.map(toConfigGrant) } });
        }
        return removed;
    }
}

export class MemoryPermissionGrantStore implements PermissionGrantStore {
    private readonly grants: PermissionGrant[] = [];

    list(): PermissionGrant[] {
        return this.grants.map((item) => ({ ...item }));
    }

    add(grant: PermissionGrant): void {
        if (
            this.grants.some(
                (item) => item.capability === grant.capability && item.path === grant.path,
            )
        ) {
            return;
        }
        this.grants.push({ ...grant });
    }

    remove(grant: PermissionGrant): number {
        const index = this.grants.findIndex(
            (item) => item.capability === grant.capability && item.path === grant.path,
        );
        if (index < 0) return 0;
        this.grants.splice(index, 1);
        return 1;
    }
}

function fromConfigGrant(grant: PermissionGrantConfig): PermissionGrant {
    return {
        capability: grant.capability as PermissionCapability,
        path: grant.path,
    };
}

function toConfigGrant(grant: PermissionGrant): PermissionGrantConfig {
    return {
        capability: grant.capability,
        path: grant.path,
    };
}

import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { getUserConfigPath } from "../config/user-config.js";
import { getCloudflaredConfigPath } from "./yml.js";

interface FileSnapshot {
    path: string;
    existed: boolean;
    content?: Buffer;
    mode?: number;
}

export interface PublicSetupTransaction {
    commit(): void;
    rollback(): void;
}

/**
 * Snapshot the durable local public-connection state before an interactive
 * setup attempt. Cloudflare remote changes cannot be rolled back reliably,
 * but the last known-good local config and cloudflared route remain intact.
 */
export function beginPublicSetupTransaction(
    paths: string[] = [getUserConfigPath(), getCloudflaredConfigPath()],
): PublicSetupTransaction {
    const snapshots = [...new Set(paths)].map(snapshotFile);
    let finished = false;

    return {
        commit: () => {
            finished = true;
        },
        rollback: () => {
            if (finished) return;
            finished = true;
            for (const snapshot of snapshots) restoreFile(snapshot);
        },
    };
}

export async function withPublicSetupTransaction<T>(
    operation: () => Promise<T>,
): Promise<T> {
    const transaction = beginPublicSetupTransaction();
    try {
        const result = await operation();
        transaction.commit();
        return result;
    } catch (error) {
        transaction.rollback();
        throw error;
    }
}

function snapshotFile(path: string): FileSnapshot {
    if (!existsSync(path)) return { path, existed: false };
    const info = statSync(path);
    return {
        path,
        existed: true,
        content: readFileSync(path),
        mode: info.mode & 0o777,
    };
}

function restoreFile(snapshot: FileSnapshot): void {
    if (!snapshot.existed) {
        rmSync(snapshot.path, { force: true });
        return;
    }

    mkdirSync(dirname(snapshot.path), { recursive: true });
    const tempPath = `${snapshot.path}.${process.pid}.${randomUUID()}.rollback`;
    try {
        writeFileSync(tempPath, snapshot.content ?? Buffer.alloc(0), {
            mode: snapshot.mode,
        });
        if (process.platform === "win32") {
            // Windows rename does not reliably replace an existing destination.
            rmSync(snapshot.path, { force: true });
        }
        renameSync(tempPath, snapshot.path);
        if (process.platform !== "win32" && snapshot.mode !== undefined) {
            chmodSync(snapshot.path, snapshot.mode);
        }
    } finally {
        rmSync(tempPath, { force: true });
    }
}

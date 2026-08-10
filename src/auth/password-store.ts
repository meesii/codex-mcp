import { Algorithm, hash, verify } from "@node-rs/argon2";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { getUserConfigDir } from "../user-config.js";
import { readJsonFile, writePrivateJson } from "./storage.js";

const AUTH_FILE_VERSION = 1;
const MIN_PASSWORD_LENGTH = 12;

interface AuthCredentialFile {
    version: 1;
    passwordHash: string;
    updatedAt: string;
}

export function getAuthCredentialPath(): string {
    return join(getUserConfigDir(), "auth.json");
}

export async function hasAdminPassword(): Promise<boolean> {
    const state = await readCredentialFile();
    return typeof state?.passwordHash === "string" && state.passwordHash.length > 0;
}

export async function setAdminPassword(password: string): Promise<void> {
    validateNewPassword(password);
    const passwordHash = await hash(password, {
        algorithm: Algorithm.Argon2id,
        memoryCost: 64 * 1024,
        timeCost: 3,
        parallelism: 1,
        outputLen: 32,
    });
    await writePrivateJson(getAuthCredentialPath(), {
        version: AUTH_FILE_VERSION,
        passwordHash,
        updatedAt: new Date().toISOString(),
    } satisfies AuthCredentialFile);
}

export async function verifyAdminPassword(password: string): Promise<boolean> {
    return (await verifyAdminPasswordWithGeneration(password)) !== undefined;
}

/**
 * Verify a password and return the generation derived from the exact PHC hash
 * that was verified. This avoids a password-reset race where an old password
 * verification could otherwise be paired with the new credential generation.
 */
export async function verifyAdminPasswordWithGeneration(
    password: string,
): Promise<string | undefined> {
    const state = await readCredentialFile();
    if (!state?.passwordHash) return undefined;
    try {
        if (!(await verify(state.passwordHash, password))) return undefined;
        return generationForHash(state.passwordHash);
    } catch {
        return undefined;
    }
}

/**
 * Return a stable, non-secret generation identifier for the current admin
 * credential. Argon2 salts make the PHC hash change on every password reset,
 * even when the same password is chosen again.
 */
export async function getAdminCredentialGeneration(): Promise<string | undefined> {
    const state = await readCredentialFile();
    if (!state?.passwordHash) return undefined;
    return generationForHash(state.passwordHash);
}

function generationForHash(passwordHash: string): string {
    return createHash("sha256").update(passwordHash, "utf8").digest("base64url");
}

export function validateNewPassword(password: string): void {
    if (password.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`连接密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符`);
    }
    if (password.length > 1024) {
        throw new Error("连接密码太长了，请换一个短一些的密码");
    }
}

async function readCredentialFile(): Promise<AuthCredentialFile | null> {
    const state = await readJsonFile<AuthCredentialFile | null>(getAuthCredentialPath(), null);
    if (state === null) return null;
    if (state.version !== AUTH_FILE_VERSION || typeof state.passwordHash !== "string") {
        throw new Error(`Invalid OAuth credential file: ${getAuthCredentialPath()}`);
    }
    return state;
}

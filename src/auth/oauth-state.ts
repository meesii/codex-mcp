import { OAuthClientInformationFullSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
    OAuthClientInformationFull,
    OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
    InvalidGrantError,
    InvalidScopeError,
    InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { getUserConfigDir } from "../config/user-config.js";
import { readJsonFile, writePrivateJson } from "./storage.js";
import { AsyncMutex } from "../lib/util/mutex.js";

export const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TOKEN_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RETIRED_REFRESH_RETENTION_MS = 45 * 24 * 60 * 60 * 1000;
// 1.0 intentionally invalidates all pre-1.0 OAuth clients and grants.
const STATE_VERSION = 2;

interface AuthorizationCodeRecord {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
    resource?: string;
    credentialGeneration: string;
    expiresAt: number;
}

interface AccessTokenRecord {
    clientId: string;
    scopes: string[];
    resource?: string;
    familyId: string;
    credentialGeneration: string;
    expiresAt: number;
}

interface RefreshTokenRecord {
    clientId: string;
    scopes: string[];
    resource?: string;
    familyId: string;
    credentialGeneration: string;
    issuedAt: number;
    lastUsedAt: number;
    active: boolean;
    retiredAt?: number;
}

interface PersistedOAuthState {
    version: 2;
    clients: Record<string, OAuthClientInformationFull>;
    clientIssuers: Record<string, string>;
    authorizationCodes: Record<string, AuthorizationCodeRecord>;
    accessTokens: Record<string, AccessTokenRecord>;
    refreshTokens: Record<string, RefreshTokenRecord>;
    revokedFamilies: Record<string, number>;
}

interface AuthorizationCodeInput {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
    resource?: URL;
    credentialGeneration: string;
}

export function getOAuthStatePath(): string {
    return join(getUserConfigDir(), "oauth-state.json");
}

export class OAuthStateStore {
    private readonly mutex = new AsyncMutex();

    private constructor(
        private state: PersistedOAuthState,
        private readonly path: string,
    ) {}

    static async open(path: string = getOAuthStatePath()): Promise<OAuthStateStore> {
        const fallback: PersistedOAuthState = {
            version: STATE_VERSION,
            clients: {},
            clientIssuers: {},
            authorizationCodes: {},
            accessTokens: {},
            refreshTokens: {},
            revokedFamilies: {},
        };
        const state = await readJsonFile<unknown>(path, fallback);
        if (!isPersistedOAuthState(state)) {
            throw new Error(`Unsupported OAuth state version in ${path}`);
        }
        const store = new OAuthStateStore(state, path);
        await store.cleanup();
        return store;
    }

    getClient(
        clientId: string,
        issuer: string,
    ): OAuthClientInformationFull | undefined {
        const client = this.state.clients[clientId];
        if (!client || this.state.clientIssuers[clientId] !== issuer) return undefined;
        return structuredClone(client);
    }

    get registeredClientCount(): number {
        return Object.keys(this.state.clients).length;
    }

    async registerClient(
        client: OAuthClientInformationFull,
        issuer: string,
        options?: { maxClients?: number; protectRecentMs?: number },
    ): Promise<OAuthClientInformationFull> {
        return this.mutex.runExclusive(async () => {
            const state = structuredClone(this.state);
            const now = Date.now();
            this.prune(state, now);
            const maxClients = options?.maxClients;
            if (
                maxClients !== undefined &&
                Object.keys(state.clients).length >= maxClients
            ) {
                this.evictInactiveClients(
                    state,
                    maxClients,
                    options?.protectRecentMs ?? 0,
                    now,
                );
            }
            if (
                maxClients !== undefined &&
                Object.keys(state.clients).length >= maxClients
            ) {
                throw new Error(`OAuth client capacity reached (${maxClients})`);
            }

            state.clients[client.client_id] = structuredClone(client);
            state.clientIssuers[client.client_id] = issuer;
            await this.persist(state);
            return structuredClone(client);
        });
    }

    async createAuthorizationCode(input: AuthorizationCodeInput): Promise<string> {
        return this.mutex.runExclusive(async () => {
            const state = structuredClone(this.state);
            this.prune(state, Date.now());
            const code = randomToken();
            state.authorizationCodes[tokenDigest(code)] = {
                clientId: input.clientId,
                redirectUri: input.redirectUri,
                codeChallenge: input.codeChallenge,
                scopes: [...input.scopes],
                resource: input.resource?.href,
                credentialGeneration: input.credentialGeneration,
                expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_MS,
            };
            await this.persist(state);
            return code;
        });
    }

    async challengeForAuthorizationCode(clientId: string, code: string): Promise<string> {
        const record = this.state.authorizationCodes[tokenDigest(code)];
        if (!record || record.clientId !== clientId || record.expiresAt <= Date.now()) {
            throw new InvalidGrantError("Invalid or expired authorization code");
        }
        return record.codeChallenge;
    }

    async exchangeAuthorizationCode(input: {
        clientId: string;
        code: string;
        redirectUri?: string;
        resource?: URL;
        credentialGeneration: string;
    }): Promise<OAuthTokens> {
        return this.mutex.runExclusive(async () => {
            const state = structuredClone(this.state);
            const now = Date.now();
            this.prune(state, now);
            const digest = tokenDigest(input.code);
            const record = state.authorizationCodes[digest];
            if (!record || record.clientId !== input.clientId || record.expiresAt <= now) {
                throw new InvalidGrantError("Invalid or expired authorization code");
            }
            if (!input.redirectUri || input.redirectUri !== record.redirectUri) {
                throw new InvalidGrantError("redirect_uri does not match the authorization request");
            }
            if (!input.resource || input.resource.href !== record.resource) {
                throw new InvalidGrantError("resource is required and must match the authorization request");
            }
            if (input.credentialGeneration !== record.credentialGeneration) {
                delete state.authorizationCodes[digest];
                await this.persist(state);
                throw new InvalidGrantError("Administrator credential changed; restart authorization");
            }

            delete state.authorizationCodes[digest];
            const familyId = randomUUID();
            const tokens = this.issueTokenPair(state, {
                clientId: record.clientId,
                scopes: record.scopes,
                resource: record.resource,
                familyId,
                credentialGeneration: record.credentialGeneration,
                now,
            });
            await this.persist(state);
            return tokens;
        });
    }

    async exchangeRefreshToken(input: {
        clientId: string;
        refreshToken: string;
        scopes?: string[];
        resource?: URL;
        credentialGeneration: string;
    }): Promise<OAuthTokens> {
        return this.mutex.runExclusive(async () => {
            const state = structuredClone(this.state);
            const now = Date.now();
            this.prune(state, now);
            const digest = tokenDigest(input.refreshToken);
            const record = state.refreshTokens[digest];
            if (!record) {
                throw new InvalidGrantError("Invalid refresh token");
            }
            if (!record.active) {
                this.revokeFamily(state, record.familyId, now);
                await this.persist(state);
                throw new InvalidGrantError("Refresh token reuse detected; token family revoked");
            }
            if (
                record.clientId !== input.clientId ||
                record.credentialGeneration !== input.credentialGeneration ||
                record.lastUsedAt + REFRESH_TOKEN_IDLE_TTL_MS <= now ||
                state.revokedFamilies[record.familyId] !== undefined
            ) {
                record.active = false;
                record.retiredAt = now;
                await this.persist(state);
                throw new InvalidGrantError("Invalid or expired refresh token");
            }

            const requestedScopes = input.scopes ?? record.scopes;
            if (!isScopeSubset(requestedScopes, record.scopes)) {
                throw new InvalidScopeError("Requested scope exceeds the original grant");
            }
            if (!input.resource || input.resource.href !== record.resource) {
                throw new InvalidGrantError("resource is required and must match the original grant");
            }

            record.active = false;
            record.retiredAt = now;
            record.lastUsedAt = now;
            const tokens = this.issueTokenPair(state, {
                clientId: record.clientId,
                scopes: requestedScopes,
                resource: record.resource,
                familyId: record.familyId,
                credentialGeneration: record.credentialGeneration,
                now,
            });
            await this.persist(state);
            return tokens;
        });
    }

    async verifyAccessToken(token: string, credentialGeneration: string): Promise<AuthInfo> {
        const record = this.state.accessTokens[tokenDigest(token)];
        if (
            !record ||
            record.credentialGeneration !== credentialGeneration ||
            record.expiresAt <= Date.now()
        ) {
            throw new InvalidTokenError("Invalid or expired access token");
        }
        if (this.state.revokedFamilies[record.familyId] !== undefined) {
            throw new InvalidTokenError("Access token has been revoked");
        }
        return {
            token,
            clientId: record.clientId,
            scopes: [...record.scopes],
            expiresAt: Math.floor(record.expiresAt / 1000),
            resource: record.resource ? new URL(record.resource) : undefined,
            extra: { codexMcpSessionId: record.familyId },
        };
    }

    async revokeToken(token: string, clientId: string): Promise<void> {
        await this.mutex.runExclusive(async () => {
            const state = structuredClone(this.state);
            const now = Date.now();
            const digest = tokenDigest(token);
            const access = state.accessTokens[digest];
            if (access?.clientId === clientId) {
                delete state.accessTokens[digest];
                await this.persist(state);
                return;
            }

            const refresh = state.refreshTokens[digest];
            if (refresh?.clientId === clientId) {
                this.revokeFamily(state, refresh.familyId, now);
                await this.persist(state);
            }
        });
    }

    async cleanup(): Promise<void> {
        await this.mutex.runExclusive(async () => {
            const state = structuredClone(this.state);
            this.prune(state, Date.now());
            await this.persist(state);
        });
    }

    private evictInactiveClients(
        state: PersistedOAuthState,
        maxClients: number,
        protectRecentMs: number,
        now: number,
    ): void {
        const activeClientIds = new Set<string>();
        for (const record of Object.values(state.authorizationCodes)) {
            activeClientIds.add(record.clientId);
        }
        for (const record of Object.values(state.accessTokens)) {
            activeClientIds.add(record.clientId);
        }
        for (const record of Object.values(state.refreshTokens)) {
            if (record.active) activeClientIds.add(record.clientId);
        }

        const removable = Object.values(state.clients)
            .filter((client) => {
                if (activeClientIds.has(client.client_id)) return false;
                const issuedAtMs = (client.client_id_issued_at ?? 0) * 1000;
                return issuedAtMs + protectRecentMs <= now;
            })
            .sort(
                (left, right) =>
                    (left.client_id_issued_at ?? 0) - (right.client_id_issued_at ?? 0),
            );

        while (
            Object.keys(state.clients).length >= maxClients &&
            removable.length > 0
        ) {
            const client = removable.shift()!;
            delete state.clients[client.client_id];
            delete state.clientIssuers[client.client_id];
        }
    }

    private issueTokenPair(state: PersistedOAuthState, input: {
        clientId: string;
        scopes: string[];
        resource?: string;
        familyId: string;
        credentialGeneration: string;
        now: number;
    }): OAuthTokens {
        const accessToken = randomToken();
        const refreshToken = randomToken();
        state.accessTokens[tokenDigest(accessToken)] = {
            clientId: input.clientId,
            scopes: [...input.scopes],
            resource: input.resource,
            familyId: input.familyId,
            credentialGeneration: input.credentialGeneration,
            expiresAt: input.now + ACCESS_TOKEN_TTL_MS,
        };
        state.refreshTokens[tokenDigest(refreshToken)] = {
            clientId: input.clientId,
            scopes: [...input.scopes],
            resource: input.resource,
            familyId: input.familyId,
            credentialGeneration: input.credentialGeneration,
            issuedAt: input.now,
            lastUsedAt: input.now,
            active: true,
        };
        return {
            access_token: accessToken,
            refresh_token: refreshToken,
            token_type: "Bearer",
            expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
            scope: input.scopes.join(" "),
        };
    }

    private revokeFamily(state: PersistedOAuthState, familyId: string, now: number): void {
        state.revokedFamilies[familyId] = now;
        for (const [digest, record] of Object.entries(state.accessTokens)) {
            if (record.familyId === familyId) delete state.accessTokens[digest];
        }
        for (const record of Object.values(state.refreshTokens)) {
            if (record.familyId !== familyId) continue;
            record.active = false;
            record.retiredAt = record.retiredAt ?? now;
        }
    }

    private prune(state: PersistedOAuthState, now: number): void {
        for (const [digest, record] of Object.entries(state.authorizationCodes)) {
            if (record.expiresAt <= now) delete state.authorizationCodes[digest];
        }
        for (const [digest, record] of Object.entries(state.accessTokens)) {
            if (record.expiresAt <= now) delete state.accessTokens[digest];
        }
        for (const [digest, record] of Object.entries(state.refreshTokens)) {
            if (record.active && record.lastUsedAt + REFRESH_TOKEN_IDLE_TTL_MS <= now) {
                record.active = false;
                record.retiredAt = now;
            }
            if (
                !record.active &&
                record.retiredAt !== undefined &&
                record.retiredAt + RETIRED_REFRESH_RETENTION_MS <= now
            ) {
                delete state.refreshTokens[digest];
            }
        }
        for (const [familyId, revokedAt] of Object.entries(state.revokedFamilies)) {
            if (revokedAt + RETIRED_REFRESH_RETENTION_MS <= now) {
                delete state.revokedFamilies[familyId];
            }
        }
    }

    private async persist(state: PersistedOAuthState): Promise<void> {
        await writePrivateJson(this.path, state);
        this.state = state;
    }
}

function isPersistedOAuthState(value: unknown): value is PersistedOAuthState {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const state = value as Record<string, unknown>;
    const keys = [
        "version", "clients", "clientIssuers", "authorizationCodes", "accessTokens",
        "refreshTokens", "revokedFamilies",
    ];
    if (!hasExactKeys(state, keys) ||
        state.version !== STATE_VERSION ||
        !isRecord(state.clients) || !isStringRecord(state.clientIssuers) ||
        !isRecord(state.authorizationCodes) || !isRecord(state.accessTokens) ||
        !isRecord(state.refreshTokens) || !isNumberRecord(state.revokedFamilies)) {
        return false;
    }
    const clientIds = Object.keys(state.clients);
    const issuerIds = Object.keys(state.clientIssuers);
    return clientIds.length === issuerIds.length &&
        clientIds.every((id) => Object.prototype.hasOwnProperty.call(state.clientIssuers, id)) &&
        Object.entries(state.clients).every(([id, client]) => isOAuthClientRecord(client) && client.client_id === id) &&
        Object.values(state.authorizationCodes).every(isAuthorizationCodeRecord) &&
        Object.values(state.accessTokens).every(isAccessTokenRecord) &&
        Object.values(state.refreshTokens).every(isRefreshTokenRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isStringRecord(value: unknown): value is Record<string, string> {
    return isRecord(value) && Object.values(value).every((item) => typeof item === "string" && item.length > 0);
}

function isNumberRecord(value: unknown): value is Record<string, number> {
    return isRecord(value) && Object.values(value).every((item) => typeof item === "number" && Number.isFinite(item));
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
    return Object.keys(value).every((key) => allowed.includes(key));
}

function isOAuthClientRecord(value: unknown): value is OAuthClientInformationFull {
    return OAuthClientInformationFullSchema.safeParse(value).success;
}

function isAuthorizationCodeRecord(value: unknown): value is AuthorizationCodeRecord {
    if (!isRecord(value) || !hasExactKeys(value, [
        "clientId", "redirectUri", "codeChallenge", "scopes", "resource", "credentialGeneration", "expiresAt",
    ])) return false;
    return typeof value.clientId === "string" && value.clientId.length > 0 &&
        typeof value.redirectUri === "string" && value.redirectUri.length > 0 &&
        typeof value.codeChallenge === "string" && value.codeChallenge.length > 0 &&
        isStringArray(value.scopes) &&
        isResource(value.resource) &&
        typeof value.credentialGeneration === "string" && value.credentialGeneration.length > 0 &&
        isFiniteNumber(value.expiresAt);
}

function isAccessTokenRecord(value: unknown): value is AccessTokenRecord {
    if (!isRecord(value) || !hasExactKeys(value, [
        "clientId", "scopes", "resource", "familyId", "credentialGeneration", "expiresAt",
    ])) return false;
    return typeof value.clientId === "string" && value.clientId.length > 0 &&
        isStringArray(value.scopes) &&
        isResource(value.resource) &&
        typeof value.familyId === "string" && value.familyId.length > 0 &&
        typeof value.credentialGeneration === "string" && value.credentialGeneration.length > 0 &&
        isFiniteNumber(value.expiresAt);
}

function isRefreshTokenRecord(value: unknown): value is RefreshTokenRecord {
    if (!isRecord(value) || !hasExactKeys(value, [
        "clientId", "scopes", "resource", "familyId", "credentialGeneration", "issuedAt", "lastUsedAt", "active", "retiredAt",
    ])) return false;
    return typeof value.clientId === "string" && value.clientId.length > 0 &&
        isStringArray(value.scopes) &&
        isResource(value.resource) &&
        typeof value.familyId === "string" && value.familyId.length > 0 &&
        typeof value.credentialGeneration === "string" && value.credentialGeneration.length > 0 &&
        isFiniteNumber(value.issuedAt) && isFiniteNumber(value.lastUsedAt) &&
        typeof value.active === "boolean" &&
        (value.retiredAt === undefined || isFiniteNumber(value.retiredAt));
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function isResource(value: unknown): value is string {
    if (typeof value !== "string") return false;
    try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password && !url.hash;
    } catch {
        return false;
    }
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

export function tokenDigest(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("base64url");
}

function randomToken(): string {
    return randomBytes(32).toString("base64url");
}

function isScopeSubset(requested: string[], granted: string[]): boolean {
    const allowed = new Set(granted);
    return requested.every((scope) => allowed.has(scope));
}

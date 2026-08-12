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
import { AsyncMutex, readJsonFile, writePrivateJson } from "./storage.js";

export const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TOKEN_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RETIRED_REFRESH_RETENTION_MS = 45 * 24 * 60 * 60 * 1000;
const STATE_VERSION = 1;

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
    version: 1;
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
        const state = await readJsonFile<PersistedOAuthState>(path, fallback);
        if (state.version !== STATE_VERSION) {
            throw new Error(`Unsupported OAuth state version in ${path}`);
        }
        state.clientIssuers ??= {};
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
        return this.mutex.run(async () => {
            const now = Date.now();
            this.prune(now);
            const maxClients = options?.maxClients;
            if (
                maxClients !== undefined &&
                Object.keys(this.state.clients).length >= maxClients
            ) {
                this.evictInactiveClients(
                    maxClients,
                    options?.protectRecentMs ?? 0,
                    now,
                );
            }
            if (
                maxClients !== undefined &&
                Object.keys(this.state.clients).length >= maxClients
            ) {
                throw new Error(`OAuth client capacity reached (${maxClients})`);
            }

            this.state.clients[client.client_id] = structuredClone(client);
            this.state.clientIssuers[client.client_id] = issuer;
            await this.persist();
            return structuredClone(client);
        });
    }

    async createAuthorizationCode(input: AuthorizationCodeInput): Promise<string> {
        return this.mutex.run(async () => {
            this.prune(Date.now());
            const code = randomToken();
            this.state.authorizationCodes[tokenDigest(code)] = {
                clientId: input.clientId,
                redirectUri: input.redirectUri,
                codeChallenge: input.codeChallenge,
                scopes: [...input.scopes],
                resource: input.resource?.href,
                credentialGeneration: input.credentialGeneration,
                expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_MS,
            };
            await this.persist();
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
        return this.mutex.run(async () => {
            const now = Date.now();
            this.prune(now);
            const digest = tokenDigest(input.code);
            const record = this.state.authorizationCodes[digest];
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
                delete this.state.authorizationCodes[digest];
                await this.persist();
                throw new InvalidGrantError("Administrator credential changed; restart authorization");
            }

            delete this.state.authorizationCodes[digest];
            const familyId = randomUUID();
            const tokens = this.issueTokenPair({
                clientId: record.clientId,
                scopes: record.scopes,
                resource: record.resource,
                familyId,
                credentialGeneration: record.credentialGeneration,
                now,
            });
            await this.persist();
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
        return this.mutex.run(async () => {
            const now = Date.now();
            this.prune(now);
            const digest = tokenDigest(input.refreshToken);
            const record = this.state.refreshTokens[digest];
            if (!record) {
                throw new InvalidGrantError("Invalid refresh token");
            }
            if (!record.active) {
                this.revokeFamily(record.familyId, now);
                await this.persist();
                throw new InvalidGrantError("Refresh token reuse detected; token family revoked");
            }
            if (
                record.clientId !== input.clientId ||
                record.credentialGeneration !== input.credentialGeneration ||
                record.lastUsedAt + REFRESH_TOKEN_IDLE_TTL_MS <= now ||
                this.state.revokedFamilies[record.familyId] !== undefined
            ) {
                record.active = false;
                record.retiredAt = now;
                await this.persist();
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
            const tokens = this.issueTokenPair({
                clientId: record.clientId,
                scopes: requestedScopes,
                resource: record.resource,
                familyId: record.familyId,
                credentialGeneration: record.credentialGeneration,
                now,
            });
            await this.persist();
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
        await this.mutex.run(async () => {
            const now = Date.now();
            const digest = tokenDigest(token);
            const access = this.state.accessTokens[digest];
            if (access?.clientId === clientId) {
                delete this.state.accessTokens[digest];
                await this.persist();
                return;
            }

            const refresh = this.state.refreshTokens[digest];
            if (refresh?.clientId === clientId) {
                this.revokeFamily(refresh.familyId, now);
                await this.persist();
            }
        });
    }

    async cleanup(): Promise<void> {
        await this.mutex.run(async () => {
            this.prune(Date.now());
            await this.persist();
        });
    }

    private evictInactiveClients(
        maxClients: number,
        protectRecentMs: number,
        now: number,
    ): void {
        const activeClientIds = new Set<string>();
        for (const record of Object.values(this.state.authorizationCodes)) {
            activeClientIds.add(record.clientId);
        }
        for (const record of Object.values(this.state.accessTokens)) {
            activeClientIds.add(record.clientId);
        }
        for (const record of Object.values(this.state.refreshTokens)) {
            if (record.active) activeClientIds.add(record.clientId);
        }

        const removable = Object.values(this.state.clients)
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
            Object.keys(this.state.clients).length >= maxClients &&
            removable.length > 0
        ) {
            const client = removable.shift()!;
            delete this.state.clients[client.client_id];
            delete this.state.clientIssuers[client.client_id];
        }
    }

    private issueTokenPair(input: {
        clientId: string;
        scopes: string[];
        resource?: string;
        familyId: string;
        credentialGeneration: string;
        now: number;
    }): OAuthTokens {
        const accessToken = randomToken();
        const refreshToken = randomToken();
        this.state.accessTokens[tokenDigest(accessToken)] = {
            clientId: input.clientId,
            scopes: [...input.scopes],
            resource: input.resource,
            familyId: input.familyId,
            credentialGeneration: input.credentialGeneration,
            expiresAt: input.now + ACCESS_TOKEN_TTL_MS,
        };
        this.state.refreshTokens[tokenDigest(refreshToken)] = {
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

    private revokeFamily(familyId: string, now: number): void {
        this.state.revokedFamilies[familyId] = now;
        for (const [digest, record] of Object.entries(this.state.accessTokens)) {
            if (record.familyId === familyId) delete this.state.accessTokens[digest];
        }
        for (const record of Object.values(this.state.refreshTokens)) {
            if (record.familyId !== familyId) continue;
            record.active = false;
            record.retiredAt = record.retiredAt ?? now;
        }
    }

    private prune(now: number): void {
        for (const [digest, record] of Object.entries(this.state.authorizationCodes)) {
            if (record.expiresAt <= now) delete this.state.authorizationCodes[digest];
        }
        for (const [digest, record] of Object.entries(this.state.accessTokens)) {
            if (record.expiresAt <= now) delete this.state.accessTokens[digest];
        }
        for (const [digest, record] of Object.entries(this.state.refreshTokens)) {
            if (record.active && record.lastUsedAt + REFRESH_TOKEN_IDLE_TTL_MS <= now) {
                record.active = false;
                record.retiredAt = now;
            }
            if (
                !record.active &&
                record.retiredAt !== undefined &&
                record.retiredAt + RETIRED_REFRESH_RETENTION_MS <= now
            ) {
                delete this.state.refreshTokens[digest];
            }
        }
        for (const [familyId, revokedAt] of Object.entries(this.state.revokedFamilies)) {
            if (revokedAt + RETIRED_REFRESH_RETENTION_MS <= now) {
                delete this.state.revokedFamilies[familyId];
            }
        }
    }

    private async persist(): Promise<void> {
        await writePrivateJson(this.path, this.state);
    }
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

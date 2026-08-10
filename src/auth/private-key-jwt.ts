import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
    createLocalJWKSet,
    decodeJwt,
    jwtVerify,
    type JSONWebKeySet,
    type JWTPayload,
} from "jose";
import { safeHttpGet } from "../lib/safe-http.js";

const ASSERTION_MAX_BYTES = 16 * 1024;
const ASSERTION_MAX_LIFETIME_SECONDS = 5 * 60;
const ASSERTION_CLOCK_TOLERANCE_SECONDS = 60;
const MAX_REPLAY_ENTRIES = 8_192;
const JWKS_MAX_BYTES = 128 * 1024;
const JWKS_DEFAULT_TTL_MS = 10 * 60 * 1000;
const JWKS_MAX_TTL_MS = 60 * 60 * 1000;
const JWKS_FORCE_REFRESH_COOLDOWN_MS = 30_000;
const JWKS_MAX_CACHE_ENTRIES = 256;
const MAX_JWKS_KEYS = 32;
const MIN_RSA_MODULUS_BYTES = 256;
export const PRIVATE_KEY_JWT_ALGORITHMS = ["RS256"] as const;
export const JWT_BEARER_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

interface CachedJwks {
    jwks: JSONWebKeySet;
    expiresAt: number;
    lastForcedRefreshAt: number;
}

export class PrivateKeyJwtVerifier {
    private readonly jwksCache = new Map<string, CachedJwks>();
    private readonly replayCache = new Map<string, number>();

    constructor(private readonly issuerUrl: URL) {}

    /**
     * Extract the client identifier from an unverified assertion only for client lookup.
     * The returned identifier is never trusted until verify() completes successfully.
     */
    identifyClient(assertion: string): string | undefined {
        if (Buffer.byteLength(assertion, "utf8") > ASSERTION_MAX_BYTES) return undefined;
        try {
            const payload = decodeJwt(assertion);
            if (typeof payload.iss !== "string" || typeof payload.sub !== "string") return undefined;
            if (payload.iss !== payload.sub) return undefined;
            return payload.iss;
        } catch {
            return undefined;
        }
    }

    async verify(client: OAuthClientInformationFull, assertion: string): Promise<void> {
        if (Buffer.byteLength(assertion, "utf8") > ASSERTION_MAX_BYTES) {
            throw new Error("client assertion exceeds size limit");
        }
        if (client.token_endpoint_auth_method !== "private_key_jwt") {
            throw new Error("client is not registered for private_key_jwt");
        }

        const inlineJwks = client.jwks === undefined ? undefined : parsePublicJwks(client.jwks);
        const jwksUri = client.jwks_uri;
        if ((inlineJwks ? 1 : 0) + (jwksUri ? 1 : 0) !== 1) {
            throw new Error("private_key_jwt client must publish exactly one of jwks or jwks_uri");
        }

        let jwks = inlineJwks ?? (await this.getRemoteJwks(jwksUri!, false));
        try {
            await this.verifyWithJwks(client, assertion, jwks);
            return;
        } catch (error) {
            if (!jwksUri || !shouldRefreshJwks(error) || !this.canForceRefresh(jwksUri)) {
                throw error;
            }
        }

        jwks = await this.getRemoteJwks(jwksUri!, true);
        await this.verifyWithJwks(client, assertion, jwks);
    }

    private async verifyWithJwks(
        client: OAuthClientInformationFull,
        assertion: string,
        jwks: JSONWebKeySet,
    ): Promise<void> {
        const acceptedAudiences = this.acceptedAudiences();
        const result = await jwtVerify(assertion, createLocalJWKSet(jwks), {
            algorithms: [...PRIVATE_KEY_JWT_ALGORITHMS],
            issuer: client.client_id,
            subject: client.client_id,
            audience: acceptedAudiences,
            clockTolerance: ASSERTION_CLOCK_TOLERANCE_SECONDS,
            requiredClaims: ["iss", "sub", "aud", "exp", "jti"],
        });
        this.validateClaims(client.client_id, result.payload, acceptedAudiences);
    }

    private acceptedAudiences(): string[] {
        return [this.issuerUrl.href, new URL("/token", this.issuerUrl).href];
    }

    private validateClaims(
        clientId: string,
        payload: JWTPayload,
        acceptedAudiences: readonly string[],
    ): void {
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (!hasOnlyAllowedAudiences(payload.aud, acceptedAudiences)) {
            throw new Error("client assertion audience must identify this authorization server");
        }
        if (typeof payload.exp !== "number") {
            throw new Error("client assertion exp is required");
        }
        if (payload.exp > nowSeconds + ASSERTION_MAX_LIFETIME_SECONDS + ASSERTION_CLOCK_TOLERANCE_SECONDS) {
            throw new Error("client assertion lifetime is too long");
        }
        if (payload.iat !== undefined) {
            if (typeof payload.iat !== "number") throw new Error("client assertion iat must be numeric");
            if (payload.iat > nowSeconds + ASSERTION_CLOCK_TOLERANCE_SECONDS) {
                throw new Error("client assertion iat is in the future");
            }
            if (payload.iat < nowSeconds - ASSERTION_MAX_LIFETIME_SECONDS - ASSERTION_CLOCK_TOLERANCE_SECONDS) {
                throw new Error("client assertion iat is too old");
            }
            if (payload.exp < payload.iat) {
                throw new Error("client assertion exp precedes iat");
            }
        }
        if (typeof payload.jti !== "string" || payload.jti.length === 0 || payload.jti.length > 512) {
            throw new Error("client assertion jti is invalid");
        }

        this.pruneReplayCache();
        const replayKey = `${clientId}\u0000${payload.jti}`;
        const existingExpiry = this.replayCache.get(replayKey);
        if (existingExpiry && existingExpiry > Date.now()) {
            throw new Error("client assertion replay detected");
        }
        if (this.replayCache.size >= MAX_REPLAY_ENTRIES) {
            throw new Error("client assertion replay cache is at capacity");
        }
        this.replayCache.set(
            replayKey,
            (payload.exp + ASSERTION_CLOCK_TOLERANCE_SECONDS) * 1000,
        );
    }

    private async getRemoteJwks(uri: string, forceRefresh: boolean): Promise<JSONWebKeySet> {
        const url = new URL(uri);
        if (url.protocol !== "https:" || url.username || url.password || url.hash) {
            throw new Error("jwks_uri must be an HTTPS URL without credentials or fragment");
        }
        const now = Date.now();
        this.pruneJwksCache(now);
        const cached = this.jwksCache.get(url.href);
        if (!forceRefresh && cached && cached.expiresAt > now) {
            this.jwksCache.delete(url.href);
            this.jwksCache.set(url.href, cached);
            return structuredClone(cached.jwks);
        }

        const response = await safeHttpGet(url, {
            httpsOnly: true,
            maxBytes: JWKS_MAX_BYTES,
            timeoutMs: 8_000,
            maxRedirects: 2,
            headers: { Accept: "application/json" },
        });
        if (response.status !== 200) {
            throw new Error(`jwks_uri returned HTTP ${response.status}`);
        }
        const jwks = parsePublicJwks(JSON.parse(response.body.toString("utf8")) as unknown);
        const previous = this.jwksCache.get(url.href);
        const ttlMs = resolveCacheTtl(response.headers);
        this.setJwksCache(url.href, {
            jwks,
            expiresAt: Date.now() + ttlMs,
            lastForcedRefreshAt: forceRefresh ? Date.now() : (previous?.lastForcedRefreshAt ?? 0),
        });
        return structuredClone(jwks);
    }

    private canForceRefresh(uri: string): boolean {
        const now = Date.now();
        this.pruneJwksCache(now);
        const cacheKey = new URL(uri).href;
        const cached = this.jwksCache.get(cacheKey);
        if (!cached) return true;
        return now - cached.lastForcedRefreshAt >= JWKS_FORCE_REFRESH_COOLDOWN_MS;
    }

    private setJwksCache(key: string, value: CachedJwks): void {
        this.pruneJwksCache(Date.now());
        if (!this.jwksCache.has(key) && this.jwksCache.size >= JWKS_MAX_CACHE_ENTRIES) {
            const oldest = this.jwksCache.keys().next().value as string | undefined;
            if (oldest !== undefined) this.jwksCache.delete(oldest);
        }
        this.jwksCache.delete(key);
        this.jwksCache.set(key, value);
    }

    private pruneJwksCache(now: number): void {
        for (const [key, value] of this.jwksCache) {
            const forceRefreshCooldownActive =
                value.lastForcedRefreshAt > 0 &&
                now - value.lastForcedRefreshAt < JWKS_FORCE_REFRESH_COOLDOWN_MS;
            if (value.expiresAt <= now && !forceRefreshCooldownActive) {
                this.jwksCache.delete(key);
            }
        }
    }

    private pruneReplayCache(): void {
        const now = Date.now();
        for (const [key, expiresAt] of this.replayCache) {
            if (expiresAt <= now) this.replayCache.delete(key);
        }
    }
}

export function validatePrivateKeyJwtClientMetadata(
    document: Record<string, unknown>,
): string | undefined {
    if (document.token_endpoint_auth_method !== "private_key_jwt") return undefined;
    const signingAlg = document.token_endpoint_auth_signing_alg;
    if (signingAlg !== undefined && signingAlg !== "RS256") {
        return "private_key_jwt clients must use RS256";
    }
    const hasJwks = document.jwks !== undefined;
    const hasJwksUri = typeof document.jwks_uri === "string" && document.jwks_uri.length > 0;
    if ((hasJwks ? 1 : 0) + (hasJwksUri ? 1 : 0) !== 1) {
        return "private_key_jwt clients must publish exactly one of jwks or jwks_uri";
    }
    try {
        if (hasJwks) parsePublicJwks(document.jwks);
        if (hasJwksUri) {
            const url = new URL(document.jwks_uri as string);
            if (url.protocol !== "https:" || url.username || url.password || url.hash) {
                return "jwks_uri must be an HTTPS URL without credentials or fragment";
            }
        }
    } catch (error) {
        return error instanceof Error ? error.message : "Invalid private_key_jwt metadata";
    }
    return undefined;
}

function parsePublicJwks(raw: unknown): JSONWebKeySet {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("JWKS must be an object");
    }
    const keys = (raw as { keys?: unknown }).keys;
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_JWKS_KEYS) {
        throw new Error(`JWKS must contain between 1 and ${MAX_JWKS_KEYS} keys`);
    }

    let usableRsaKeys = 0;
    for (const key of keys) {
        if (!key || typeof key !== "object" || Array.isArray(key)) {
            throw new Error("JWKS contains an invalid key");
        }
        const jwk = key as Record<string, unknown>;
        if (
            "d" in jwk ||
            "p" in jwk ||
            "q" in jwk ||
            "dp" in jwk ||
            "dq" in jwk ||
            "qi" in jwk ||
            "oth" in jwk ||
            "k" in jwk
        ) {
            throw new Error("JWKS must not publish private or symmetric key material");
        }
        if (jwk.kty !== "RSA") continue;
        if (jwk.alg !== undefined && jwk.alg !== "RS256") continue;
        if (jwk.use !== undefined && jwk.use !== "sig") continue;
        if (Array.isArray(jwk.key_ops) && !jwk.key_ops.includes("verify")) continue;
        if (typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
        let modulus: Buffer;
        try {
            modulus = Buffer.from(jwk.n, "base64url");
        } catch {
            continue;
        }
        if (modulus.byteLength < MIN_RSA_MODULUS_BYTES) {
            throw new Error("RSA signing keys must be at least 2048 bits");
        }
        usableRsaKeys += 1;
    }
    if (usableRsaKeys === 0) {
        throw new Error("JWKS has no usable RS256 verification key");
    }
    return structuredClone(raw) as JSONWebKeySet;
}

function hasOnlyAllowedAudiences(
    aud: JWTPayload["aud"],
    allowedAudiences: readonly string[],
): boolean {
    const allowed = new Set(allowedAudiences);
    if (typeof aud === "string") return allowed.has(aud);
    return Array.isArray(aud) && aud.length > 0 && aud.every((value) => allowed.has(value));
}

function shouldRefreshJwks(error: unknown): boolean {
    const code =
        error && typeof error === "object" && "code" in error
            ? String((error as { code?: unknown }).code ?? "")
            : "";
    return code === "ERR_JWKS_NO_MATCHING_KEY" || code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
}

function resolveCacheTtl(headers: Record<string, string>): number {
    const cacheControl = headers["cache-control"] ?? "";
    if (/\bno-store\b/i.test(cacheControl)) return 0;
    const match = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(cacheControl);
    if (match) {
        const seconds = Number(match[1]);
        if (Number.isFinite(seconds)) return Math.min(seconds * 1000, JWKS_MAX_TTL_MS);
    }
    return JWKS_DEFAULT_TTL_MS;
}

import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { OAuthClientMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
    OAuthClientInformationFull,
    OAuthTokenRevocationRequest,
    OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
    AuthorizationParams,
    OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
    InvalidClientError,
    InvalidClientMetadataError,
    InvalidRequestError,
    InvalidScopeError,
    InvalidTargetError,
    InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { writeRuntimeLog } from "../lib/runtime-log.js";
import { safeHttpGet } from "../lib/safe-http.js";
import { printCompactLog } from "../lib/terminal.js";
import {
    JWT_BEARER_ASSERTION_TYPE,
    PrivateKeyJwtVerifier,
    validatePrivateKeyJwtClientMetadata,
} from "./private-key-jwt.js";
import {
    getAdminCredentialGeneration,
    verifyAdminPasswordWithGeneration,
} from "./password-store.js";
import { OAuthStateStore } from "./oauth-state.js";

const CIMD_MAX_BYTES = 128 * 1024;
const CIMD_CACHE_TTL_MS = 10 * 60 * 1000;
const CIMD_MAX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CIMD_MAX_CACHE_ENTRIES = 512;
const DCR_PROTECT_RECENT_MS = 10 * 60 * 1000;
const MAX_REGISTERED_CLIENTS = 256;
export const OAUTH_SCOPES = ["mcp:tools", "offline_access"] as const;

function logOAuthWarning(
    event: string,
    message: string,
    fields: Record<string, string | number> = {},
): void {
    printCompactLog("warning", message);
    writeRuntimeLog("warn", event, fields);
}

interface CachedClient {
    client: OAuthClientInformationFull;
    expiresAt: number;
}

export class CodexClientsStore implements OAuthRegisteredClientsStore {
    private readonly cimdCache = new Map<string, CachedClient>();

    constructor(
        private readonly state: OAuthStateStore,
        private readonly issuerUrl: URL,
    ) {}

    async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
        const registered = this.state.getClient(clientId, this.issuerUrl.href);
        if (registered) return registered;

        const now = Date.now();
        this.pruneCimdCache(now);
        const cached = this.cimdCache.get(clientId);
        if (cached && cached.expiresAt > now) {
            // Refresh insertion order on hits so capacity eviction approximates LRU.
            this.cimdCache.delete(clientId);
            this.cimdCache.set(clientId, cached);
            return structuredClone(cached.client);
        }

        const cimd = await this.fetchCimdClient(clientId);
        if (!cimd) return undefined;
        if (cimd.expiresAt > Date.now()) {
            this.setCimdCache(clientId, cimd);
        }
        return structuredClone(cimd.client);
    }

    async registerClient(
        input: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
    ): Promise<OAuthClientInformationFull> {
        if (input.token_endpoint_auth_method !== "none" || input.client_secret) {
            throw new InvalidClientMetadataError(
                'codex-mcp only supports public OAuth clients with token_endpoint_auth_method="none" and PKCE',
            );
        }
        try {
            assertSecureRedirectUris(input.redirect_uris);
        } catch (error) {
            throw new InvalidClientMetadataError(
                error instanceof Error ? error.message : "Invalid redirect_uris",
            );
        }
        const client: OAuthClientInformationFull = {
            ...input,
            client_secret: undefined,
            client_secret_expires_at: undefined,
            client_id: randomUUID(),
            client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        try {
            return await this.state.registerClient(client, this.issuerUrl.href, {
                maxClients: MAX_REGISTERED_CLIENTS,
                protectRecentMs: DCR_PROTECT_RECENT_MS,
            });
        } catch (error) {
            if (error instanceof Error && /capacity reached/i.test(error.message)) {
                throw new InvalidRequestError(error.message);
            }
            throw error;
        }
    }

    private setCimdCache(clientId: string, value: CachedClient): void {
        this.pruneCimdCache(Date.now());
        if (!this.cimdCache.has(clientId) && this.cimdCache.size >= CIMD_MAX_CACHE_ENTRIES) {
            const oldest = this.cimdCache.keys().next().value as string | undefined;
            if (oldest !== undefined) this.cimdCache.delete(oldest);
        }
        this.cimdCache.delete(clientId);
        this.cimdCache.set(clientId, value);
    }

    private pruneCimdCache(now: number): void {
        for (const [key, value] of this.cimdCache) {
            if (value.expiresAt <= now) this.cimdCache.delete(key);
        }
    }

    private async fetchCimdClient(clientId: string): Promise<CachedClient | undefined> {
        let url: URL;
        try {
            url = new URL(clientId);
        } catch {
            return undefined;
        }
        if (url.protocol !== "https:" || url.pathname === "/" || url.search || url.hash) {
            return undefined;
        }

        try {
            const response = await safeHttpGet(url, {
                httpsOnly: true,
                maxBytes: CIMD_MAX_BYTES,
                timeoutMs: 8_000,
                maxRedirects: 2,
                headers: { Accept: "application/json" },
            });
            if (response.status !== 200) {
                logOAuthWarning(
                    "oauth_cimd_http_error",
                    `OAuth 客户端元数据请求返回 HTTP ${response.status}：${url.origin}${url.pathname}`,
                    { status: response.status },
                );
                return undefined;
            }
            const client = parseCimdClientDocument(
                clientId,
                JSON.parse(response.body.toString("utf8")) as unknown,
            );
            if (!client) {
                logOAuthWarning(
                    "oauth_cimd_invalid_metadata",
                    `OAuth 客户端元数据校验失败：${url.origin}${url.pathname}`,
                );
                return undefined;
            }
            return {
                client,
                expiresAt: Date.now() + resolveCimdCacheTtl(response.headers),
            };
        } catch (error) {
            logOAuthWarning(
                "oauth_cimd_fetch_failed",
                `OAuth 客户端元数据请求失败：${url.origin}${url.pathname} · ${
                    error instanceof Error ? error.message : "unknown error"
                }`,
                { reason: error instanceof Error ? error.name : "unknown" },
            );
            return undefined;
        }
    }
}

export class CodexOAuthProvider implements OAuthServerProvider {
    readonly clientsStore: CodexClientsStore;
    private readonly privateKeyJwt: PrivateKeyJwtVerifier;

    constructor(
        private readonly state: OAuthStateStore,
        private readonly issuerUrl: URL,
        private readonly resourceUrl: URL,
    ) {
        this.clientsStore = new CodexClientsStore(state, issuerUrl);
        this.privateKeyJwt = new PrivateKeyJwtVerifier(issuerUrl);
    }

    async authenticateClient(input: Record<string, unknown>): Promise<OAuthClientInformationFull> {
        const explicitClientId = typeof input.client_id === "string" ? input.client_id : undefined;
        const assertion = typeof input.client_assertion === "string" ? input.client_assertion : undefined;
        const assertionType =
            typeof input.client_assertion_type === "string" ? input.client_assertion_type : undefined;
        const candidateClientId = explicitClientId ?? (assertion ? this.privateKeyJwt.identifyClient(assertion) : undefined);
        if (!candidateClientId) throw new InvalidClientError("Invalid client authentication");

        const client = await this.clientsStore.getClient(candidateClientId);
        if (!client) throw new InvalidClientError("Invalid client authentication");
        const method = client.token_endpoint_auth_method ?? "none";

        if (method === "none") {
            if (
                !explicitClientId ||
                input.client_secret !== undefined ||
                assertion !== undefined ||
                assertionType !== undefined
            ) {
                throw new InvalidClientError("Invalid client authentication");
            }
            return client;
        }

        if (method !== "private_key_jwt") {
            throw new InvalidClientError("Unsupported client authentication method");
        }
        if (
            input.client_secret !== undefined ||
            assertionType !== JWT_BEARER_ASSERTION_TYPE ||
            !assertion ||
            (explicitClientId !== undefined && explicitClientId !== client.client_id) ||
            this.privateKeyJwt.identifyClient(assertion) !== client.client_id
        ) {
            throw new InvalidClientError("Invalid client authentication");
        }

        try {
            await this.privateKeyJwt.verify(client, assertion);
        } catch (error) {
            logOAuthWarning(
                "oauth_private_key_jwt_rejected",
                `OAuth private_key_jwt 已拒绝：${client.client_id} · ${
                    error instanceof Error ? error.message : "unknown error"
                }`,
                { reason: error instanceof Error ? error.name : "unknown" },
            );
            throw new InvalidClientError("Invalid client authentication");
        }
        return client;
    }

    async authorize(
        client: OAuthClientInformationFull,
        params: AuthorizationParams,
        res: Response,
    ): Promise<void> {
        const scopes = normalizeScopes(params.scopes);
        if (!params.resource) {
            throw new InvalidTargetError("The resource parameter is required for MCP authorization");
        }
        const resource = params.resource;
        if (resource.href !== this.resourceUrl.href) {
            throw new InvalidTargetError("The requested resource does not match this MCP server");
        }

        const form = {
            clientId: client.client_id,
            clientName: client.client_name || client.client_id,
            redirectUri: params.redirectUri,
            codeChallenge: params.codeChallenge,
            scopes,
            state: params.state,
            resource,
        };

        if (res.req.method !== "POST") {
            setLoginPageHeaders(res);
            res.status(200).send(renderLoginPage(form));
            return;
        }

        const password = typeof res.req.body?.password === "string" ? res.req.body.password : "";
        if (!password || password.length > 1024) {
            setLoginPageHeaders(res);
            res.status(400).send(renderLoginPage({
                ...form,
                error: "连接信息有问题，请重新输入连接密码。",
            }));
            return;
        }

        const credentialGeneration = await verifyAdminPasswordWithGeneration(password);
        if (!credentialGeneration) {
            setLoginPageHeaders(res);
            res.status(401).send(renderLoginPage({
                ...form,
                error: "连接密码不正确，请再试一次。",
            }));
            return;
        }

        const code = await this.state.createAuthorizationCode({
            clientId: client.client_id,
            redirectUri: params.redirectUri,
            codeChallenge: params.codeChallenge,
            scopes,
            resource,
            credentialGeneration,
        });
        const redirect = new URL(params.redirectUri);
        redirect.searchParams.set("code", code);
        if (params.state !== undefined) {
            redirect.searchParams.set("state", params.state);
        }
        redirect.searchParams.set("iss", this.issuerUrl.href);
        res.locals.oauthApprovalSucceeded = true;
        res.redirect(302, redirect.href);
    }

    async challengeForAuthorizationCode(
        client: OAuthClientInformationFull,
        authorizationCode: string,
    ): Promise<string> {
        return this.state.challengeForAuthorizationCode(client.client_id, authorizationCode);
    }

    async exchangeAuthorizationCode(
        client: OAuthClientInformationFull,
        authorizationCode: string,
        _codeVerifier?: string,
        redirectUri?: string,
        resource?: URL,
    ): Promise<OAuthTokens> {
        const credentialGeneration = await requireCredentialGeneration();
        return this.state.exchangeAuthorizationCode({
            clientId: client.client_id,
            code: authorizationCode,
            redirectUri,
            resource,
            credentialGeneration,
        });
    }

    async exchangeRefreshToken(
        client: OAuthClientInformationFull,
        refreshToken: string,
        scopes?: string[],
        resource?: URL,
    ): Promise<OAuthTokens> {
        const normalizedScopes = scopes ? normalizeScopes(scopes) : undefined;
        const credentialGeneration = await requireCredentialGeneration();
        return this.state.exchangeRefreshToken({
            clientId: client.client_id,
            refreshToken,
            scopes: normalizedScopes,
            resource,
            credentialGeneration,
        });
    }

    async verifyAccessToken(token: string): Promise<AuthInfo> {
        const credentialGeneration = await getAdminCredentialGeneration();
        if (!credentialGeneration) {
            throw new InvalidTokenError("Administrator credential is not configured");
        }
        const info = await this.state.verifyAccessToken(token, credentialGeneration);
        if (info.resource?.href !== this.resourceUrl.href) {
            throw new InvalidTargetError("Access token is not valid for this MCP resource");
        }
        if (!info.scopes.includes("mcp:tools")) {
            throw new InvalidScopeError("Access token is missing mcp:tools scope");
        }
        return info;
    }

    async revokeToken(
        client: OAuthClientInformationFull,
        request: OAuthTokenRevocationRequest,
    ): Promise<void> {
        await this.state.revokeToken(request.token, client.client_id);
    }

}

async function requireCredentialGeneration(): Promise<string> {
    const generation = await getAdminCredentialGeneration();
    if (!generation) {
        throw new InvalidRequestError("Administrator credential is not configured");
    }
    return generation;
}

function normalizeScopes(scopes: string[] | undefined): string[] {
    const requested = scopes && scopes.length > 0 ? scopes : [...OAUTH_SCOPES];
    const allowed = new Set<string>(OAUTH_SCOPES);
    for (const scope of requested) {
        if (!allowed.has(scope)) {
            throw new InvalidScopeError(`Unsupported scope: ${scope}`);
        }
    }
    const normalized = [...new Set(requested)];
    if (!normalized.includes("mcp:tools")) {
        throw new InvalidScopeError("The mcp:tools scope is required");
    }
    return normalized;
}

function setLoginPageHeaders(res: Response): void {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    );
}

function renderLoginPage(input: {
    clientId: string;
    clientName: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
    state?: string;
    resource: URL;
    error?: string;
}): string {
    const clientName = escapeHtml(input.clientName);
    const scopes = escapeHtml(input.scopes.join(" "));
    const redirect = new URL(input.redirectUri);
    const redirectHost = escapeHtml(redirect.host);
    const redirectUri = escapeHtml(redirect.href);
    const error = input.error
        ? `<p class="warning">${escapeHtml(input.error)}</p>`
        : "";
    const hiddenFields = [
        ["response_type", "code"],
        ["client_id", input.clientId],
        ["redirect_uri", input.redirectUri],
        ["code_challenge", input.codeChallenge],
        ["code_challenge_method", "S256"],
        ["scope", input.scopes.join(" ")],
        ["state", input.state],
        ["resource", input.resource.href],
    ]
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`)
        .join("\n");
    const loopbackWarning = isLoopbackHost(redirect.hostname)
        ? '<p class="warning">这个连接会回到当前电脑。请确认是你刚刚在 ChatGPT 里发起的连接。</p>'
        : "";
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>连接 codex-mcp</title>
<style>
body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:#f6f7f9;color:#18181b}
main{max-width:420px;margin:10vh auto;padding:28px;background:#fff;border:1px solid #e4e4e7;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.06)}
h1{font-size:20px;margin:0 0 10px}p{color:#52525b;line-height:1.5}.meta{font-size:13px;background:#f4f4f5;padding:10px;border-radius:8px;overflow-wrap:anywhere}
label{display:block;font-weight:600;margin:18px 0 7px}input[type=password]{box-sizing:border-box;width:100%;padding:11px 12px;border:1px solid #d4d4d8;border-radius:8px;font:inherit}
button{width:100%;margin-top:18px;padding:11px 14px;border:0;border-radius:8px;background:#18181b;color:#fff;font-weight:650;cursor:pointer}.warning{color:#9a3412;background:#fff7ed;padding:10px;border-radius:8px}
</style>
</head>
<body><main>
<h1>连接到 codex-mcp</h1>
<p><strong>${clientName}</strong> 想连接这台电脑上的 codex-mcp。确认是你本人操作后，输入连接密码。</p>
<div class="meta">权限：${scopes}</div>
<div class="meta">连接返回到：<strong>${redirectHost}</strong><br>${redirectUri}</div>
${loopbackWarning}
${error}
<form method="post" action="/authorize" autocomplete="off">
${hiddenFields}
<label for="password">连接密码</label>
<input id="password" name="password" type="password" required autofocus autocomplete="current-password" maxlength="1024" />
<button type="submit">确认连接</button>
</form>
</main></body></html>`;
}

function resolveCimdCacheTtl(headers: Record<string, string>): number {
    const cacheControl = headers["cache-control"]?.toLowerCase() ?? "";
    if (/\bno-store\b/.test(cacheControl)) return 0;
    const maxAgeRaw = /(?:^|,)\s*max-age=(\d+)/.exec(cacheControl)?.[1];
    if (maxAgeRaw !== undefined) {
        const maxAgeMs = Number.parseInt(maxAgeRaw, 10) * 1000;
        const ageMs = Number.parseInt(headers.age ?? "0", 10) * 1000;
        if (Number.isFinite(maxAgeMs) && Number.isFinite(ageMs)) {
            return Math.max(0, Math.min(maxAgeMs - ageMs, CIMD_MAX_CACHE_TTL_MS));
        }
    }
    return CIMD_CACHE_TTL_MS;
}

export function parseCimdClientDocument(
    clientId: string,
    raw: unknown,
): OAuthClientInformationFull | undefined {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const document = raw as Record<string, unknown>;
    if (document.client_id !== clientId) return undefined;
    if (typeof document.client_name !== "string" || !document.client_name.trim()) {
        return undefined;
    }
    if (document.client_secret !== undefined || document.client_secret_expires_at !== undefined) {
        return undefined;
    }
    const parsed = OAuthClientMetadataSchema.safeParse(document);
    if (!parsed.success) return undefined;
    const authMethod = parsed.data.token_endpoint_auth_method;
    if (authMethod !== "none" && authMethod !== "private_key_jwt") return undefined;
    if (authMethod === "private_key_jwt") {
        const metadataError = validatePrivateKeyJwtClientMetadata(document);
        if (metadataError) return undefined;
    }
    try {
        assertSecureRedirectUris(parsed.data.redirect_uris);
    } catch {
        return undefined;
    }
    return {
        ...parsed.data,
        client_name: document.client_name.trim(),
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
    };
}

function assertSecureRedirectUris(redirectUris: string[]): void {
    if (redirectUris.length === 0) {
        throw new Error("At least one redirect URI is required");
    }
    for (const value of redirectUris) {
        const url = new URL(value);
        if (url.username || url.password || url.hash) {
            throw new Error(`Redirect URI is not allowed: ${value}`);
        }
        if (url.protocol === "https:") continue;
        if (url.protocol === "http:" && isLoopbackHost(url.hostname)) continue;
        throw new Error(`Redirect URI must use HTTPS or loopback HTTP: ${value}`);
    }
}

function isLoopbackHost(hostname: string): boolean {
    const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

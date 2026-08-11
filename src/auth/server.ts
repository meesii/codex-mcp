import express, { type RequestHandler } from "express";
import {
    createOAuthMetadata,
    getOAuthProtectedResourceMetadataUrl,
    mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { OAuthMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { requestClientKey } from "../lib/http/request-ip.js";
import { createRevocationEndpoint, createTokenEndpoint } from "./endpoints.js";
import { OAuthStateStore } from "./oauth-state.js";
import { PRIVATE_KEY_JWT_ALGORITHMS } from "./private-key-jwt.js";
import { CodexOAuthProvider, OAUTH_SCOPES } from "./provider.js";

const APPROVE_WINDOW_MS = 15 * 60 * 1000;
const APPROVE_MAX_ATTEMPTS = 12;
const APPROVE_GLOBAL_MAX_ATTEMPTS = 60;
const APPROVE_MAX_CONCURRENT = 2;

export interface OAuthRuntime {
    provider: CodexOAuthProvider;
    router: RequestHandler;
    bearerAuth: RequestHandler;
    metadata: OAuthMetadata;
    resourceMetadataUrl: string;
}

export async function createOAuthRuntime(resourceUrl: URL): Promise<OAuthRuntime> {
    const issuerUrl = new URL("/", resourceUrl);
    const state = await OAuthStateStore.open();
    const provider = new CodexOAuthProvider(state, issuerUrl, resourceUrl);
    const metadata = OAuthMetadataSchema.parse({
        ...createOAuthMetadata({
            provider,
            issuerUrl,
            scopesSupported: [...OAUTH_SCOPES],
        }),
        token_endpoint_auth_methods_supported: ["private_key_jwt", "none"],
        token_endpoint_auth_signing_alg_values_supported: [...PRIVATE_KEY_JWT_ALGORITHMS],
        revocation_endpoint_auth_methods_supported: ["private_key_jwt", "none"],
        revocation_endpoint_auth_signing_alg_values_supported: [...PRIVATE_KEY_JWT_ALGORITHMS],
        client_id_metadata_document_supported: true,
    });
    const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);

    const router = express.Router();
    const registrationGlobalLimiter = new FixedWindowLimiter(24 * 60 * 60 * 1000, 100);
    const endpointLimits = [
        {
            method: "GET",
            path: "/authorize",
            limiter: new FixedWindowLimiter(15 * 60 * 1000, 30),
            retryAfterSeconds: 15 * 60,
        },
        {
            method: "POST",
            path: "/token",
            limiter: new FixedWindowLimiter(15 * 60 * 1000, 60),
            retryAfterSeconds: 15 * 60,
        },
        {
            method: "POST",
            path: "/register",
            limiter: new FixedWindowLimiter(60 * 60 * 1000, 10),
            retryAfterSeconds: 60 * 60,
        },
        {
            method: "POST",
            path: "/revoke",
            limiter: new FixedWindowLimiter(15 * 60 * 1000, 60),
            retryAfterSeconds: 15 * 60,
        },
    ] as const;
    router.use((req, res, next) => {
        if (
            req.method === "POST" &&
            req.path === "/register" &&
            !registrationGlobalLimiter.take("global")
        ) {
            res.setHeader("Retry-After", String(24 * 60 * 60));
            res.status(429).json({
                error: "temporarily_unavailable",
                error_description: "连接请求太频繁，请稍后再试。",
            });
            return;
        }
        const rule = endpointLimits.find(
            (item) => item.method === req.method && item.path === req.path,
        );
        if (!rule || rule.limiter.take(requestClientKey(req))) {
            next();
            return;
        }
        res.setHeader("Retry-After", String(rule.retryAfterSeconds));
        res.status(429).json({
            error: "temporarily_unavailable",
            error_description: "连接请求太频繁，请稍后再试。",
        });
    });

    // SDK 1.30 schema supports CIMD but createOAuthMetadata() does not advertise it yet.
    // Register our metadata route first so it wins before mcpAuthRouter's fallback route.
    router.get("/.well-known/oauth-authorization-server", (_req, res) => {
        res.setHeader("Cache-Control", "public, max-age=300");
        res.json(metadata);
    });

    const approveLimiter = new FixedWindowLimiter(APPROVE_WINDOW_MS, APPROVE_MAX_ATTEMPTS);
    const approveGlobalLimiter = new FixedWindowLimiter(
        APPROVE_WINDOW_MS,
        APPROVE_GLOBAL_MAX_ATTEMPTS,
    );
    let activeApprovals = 0;
    router.use(
        "/authorize",
        express.urlencoded({ extended: false, limit: "8kb" }),
        (req, res, next) => {
            if (req.method !== "POST") {
                next();
                return;
            }

            setNoStore(res);
            const key = requestClientKey(req);
            if (!approveGlobalLimiter.take("global") || !approveLimiter.take(key)) {
                res.setHeader("Retry-After", String(Math.ceil(APPROVE_WINDOW_MS / 1000)));
                res.status(429).send(renderMessagePage("尝试过于频繁", "请稍后重新发起授权。"));
                return;
            }
            if (activeApprovals >= APPROVE_MAX_CONCURRENT) {
                res.setHeader("Retry-After", "2");
                res.status(429).send(renderMessagePage("授权繁忙", "请稍后重试。"));
                return;
            }

            activeApprovals += 1;
            let released = false;
            const release = (): void => {
                if (released) return;
                released = true;
                activeApprovals -= 1;
                if (res.locals.oauthApprovalSucceeded === true) {
                    approveLimiter.clear(key);
                }
            };
            res.once("finish", release);
            res.once("close", release);
            next();
        },
    );

    // SDK 1.x does not implement server-side private_key_jwt client authentication.
    // Install standards-compliant token/revocation handlers first. The SDK router owns
    // GET/POST /authorize, registration, PRM metadata, and method fallbacks.
    router.use("/token", createTokenEndpoint(provider));
    router.use("/revoke", createRevocationEndpoint(provider));

    router.use(
        mcpAuthRouter({
            provider,
            issuerUrl,
            resourceServerUrl: resourceUrl,
            scopesSupported: [...OAUTH_SCOPES],
            resourceName: "codex-mcp",
            authorizationOptions: { rateLimit: false },
            tokenOptions: { rateLimit: false },
            clientRegistrationOptions: {
                clientIdGeneration: false,
                rateLimit: false,
            },
            revocationOptions: { rateLimit: false },
        }),
    );

    return {
        provider,
        router,
        bearerAuth: requireBearerAuth({
            verifier: provider,
            requiredScopes: ["mcp:tools"],
            resourceMetadataUrl,
        }),
        metadata,
        resourceMetadataUrl,
    };
}

class FixedWindowLimiter {
    private readonly entries = new Map<string, { count: number; resetAt: number }>();

    constructor(
        private readonly windowMs: number,
        private readonly max: number,
    ) {}

    take(key: string): boolean {
        const now = Date.now();
        const current = this.entries.get(key);
        if (!current || current.resetAt <= now) {
            this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
            this.prune(now);
            return true;
        }
        current.count += 1;
        return current.count <= this.max;
    }

    clear(key: string): void {
        this.entries.delete(key);
    }

    private prune(now: number): void {
        if (this.entries.size < 256) return;
        for (const [key, value] of this.entries) {
            if (value.resetAt <= now) this.entries.delete(key);
        }
    }
}

function setNoStore(res: express.Response): void {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    );
}

function renderMessagePage(title: string, message: string): string {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:#f6f7f9;color:#18181b;margin:0}main{max-width:420px;margin:12vh auto;padding:28px;background:#fff;border:1px solid #e4e4e7;border-radius:14px}h1{font-size:20px}p{color:#52525b;line-height:1.5}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

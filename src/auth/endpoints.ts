import { createHash, timingSafeEqual } from "node:crypto";
import express, { type RequestHandler } from "express";
import { z } from "zod";
import type { OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
    InvalidGrantError,
    InvalidRequestError,
    OAuthError,
    ServerError,
    UnsupportedGrantTypeError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { writeRuntimeLog } from "../lib/runtime-log.js";
import { printCompactLog } from "../lib/util/terminal.js";
import type { CodexOAuthProvider } from "./provider.js";

const TokenBaseSchema = z.object({ grant_type: z.string().min(1) });
const AuthorizationCodeSchema = z.object({
    grant_type: z.literal("authorization_code"),
    code: z.string().min(1),
    code_verifier: z.string().min(1),
    redirect_uri: z.string().optional(),
    resource: z.string().url().optional(),
});
const RefreshTokenSchema = z.object({
    grant_type: z.literal("refresh_token"),
    refresh_token: z.string().min(1),
    scope: z.string().optional(),
    resource: z.string().url().optional(),
});
const RevocationSchema = z.object({
    token: z.string().min(1),
    token_type_hint: z.string().optional(),
});
const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function createTokenEndpoint(provider: CodexOAuthProvider): RequestHandler {
    const router = express.Router();
    router.use(oauthCors);
    router.use(express.urlencoded({ extended: false, limit: "32kb" }));
    router.post("/", async (req, res) => {
        setNoStore(res);
        try {
            const base = TokenBaseSchema.safeParse(req.body);
            if (!base.success) throw new InvalidRequestError(base.error.message);
            const client = await provider.authenticateClient(asRecord(req.body));

            switch (base.data.grant_type) {
                case "authorization_code": {
                    const parsed = AuthorizationCodeSchema.safeParse(req.body);
                    if (!parsed.success) throw new InvalidRequestError(parsed.error.message);
                    const { code, code_verifier, redirect_uri, resource } = parsed.data;
                    if (!PKCE_VERIFIER_RE.test(code_verifier)) {
                        throw new InvalidGrantError("Invalid PKCE code_verifier");
                    }
                    const challenge = await provider.challengeForAuthorizationCode(client, code);
                    if (!verifyPkceS256(code_verifier, challenge)) {
                        throw new InvalidGrantError("code_verifier does not match the challenge");
                    }
                    const tokens = await provider.exchangeAuthorizationCode(
                        client,
                        code,
                        undefined,
                        redirect_uri,
                        resource ? new URL(resource) : undefined,
                    );
                    res.status(200).json(tokens);
                    return;
                }
                case "refresh_token": {
                    const parsed = RefreshTokenSchema.safeParse(req.body);
                    if (!parsed.success) throw new InvalidRequestError(parsed.error.message);
                    const { refresh_token, scope, resource } = parsed.data;
                    const scopes = scope?.split(/\s+/).filter(Boolean);
                    const tokens = await provider.exchangeRefreshToken(
                        client,
                        refresh_token,
                        scopes,
                        resource ? new URL(resource) : undefined,
                    );
                    res.status(200).json(tokens);
                    return;
                }
                default:
                    throw new UnsupportedGrantTypeError(
                        "The grant type is not supported by this authorization server.",
                    );
            }
        } catch (error) {
            sendOAuthError(res, error);
        }
    });
    return router;
}

export function createRevocationEndpoint(provider: CodexOAuthProvider): RequestHandler {
    const router = express.Router();
    router.use(oauthCors);
    router.use(express.urlencoded({ extended: false, limit: "32kb" }));
    router.post("/", async (req, res) => {
        setNoStore(res);
        try {
            const parsed = RevocationSchema.safeParse(req.body);
            if (!parsed.success) throw new InvalidRequestError(parsed.error.message);
            const client = await provider.authenticateClient(asRecord(req.body));
            const request: OAuthTokenRevocationRequest = {
                token: parsed.data.token,
                token_type_hint: parsed.data.token_type_hint,
            };
            await provider.revokeToken(client, request);
            res.status(200).end();
        } catch (error) {
            sendOAuthError(res, error);
        }
    });
    return router;
}

function oauthCors(req: express.Request, res: express.Response, next: express.NextFunction): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
    }
    next();
}

function verifyPkceS256(verifier: string, expectedChallenge: string): boolean {
    const actual = createHash("sha256").update(verifier, "ascii").digest("base64url");
    const left = Buffer.from(actual, "ascii");
    const right = Buffer.from(expectedChallenge, "ascii");
    return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
}

function setNoStore(res: express.Response): void {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
}

function sendOAuthError(res: express.Response, error: unknown): void {
    if (error instanceof OAuthError) {
        const status = error instanceof ServerError ? 500 : 400;
        res.status(status).json(error.toResponseObject());
        return;
    }
    const detail = error instanceof Error ? error.message : "unknown error";
    printCompactLog("error", `OAuth 端点发生内部错误：${detail}`);
    writeRuntimeLog("error", "oauth_endpoint_failed", {
        reason: error instanceof Error ? error.name : "unknown",
    });
    const serverError = new ServerError("Internal Server Error");
    res.status(500).json(serverError.toResponseObject());
}

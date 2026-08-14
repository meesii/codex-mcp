import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import {
    connectMcp,
    createProject,
    createTestEnvironment,
    expectToolOk,
    issueOAuthSession,
    refreshOAuthSession,
    startDaemonHarness,
} from "./harness.js";

test("OAuth contract: metadata is discoverable, MCP is protected, and tokens enable only authenticated access", async () => {
    const env = await createTestEnvironment("codex-mcp-oauth-contract-");
    const projectPath = await createProject("oauth", { files: { "identity.txt": "OAUTH\n" } });
    const password = "correct horse contract staple";
    const daemon = await startDaemonHarness({
        home: env.home,
        bootstrapRoot: projectPath,
        oauthRequired: true,
        password,
    });
    const project = await daemon.registerProject(projectPath, "oauth-project");

    try {
        const protectedMetadataResponse = await fetch(
            new URL("/.well-known/oauth-protected-resource/mcp", daemon.baseUrl),
        );
        assert.equal(protectedMetadataResponse.status, 200);
        const protectedMetadata = await protectedMetadataResponse.json() as {
            resource?: string;
            authorization_servers?: string[];
        };
        assert.equal(protectedMetadata.resource, daemon.mcpUrl);
        assert.deepEqual(
            protectedMetadata.authorization_servers?.map((value) => new URL(value).origin),
            [new URL(daemon.baseUrl).origin],
        );

        const authMetadataResponse = await fetch(
            new URL("/.well-known/oauth-authorization-server", daemon.baseUrl),
        );
        assert.equal(authMetadataResponse.status, 200);
        const authMetadata = await authMetadataResponse.json() as {
            issuer?: string;
            authorization_endpoint?: string;
            token_endpoint?: string;
            registration_endpoint?: string;
            revocation_endpoint?: string;
            code_challenge_methods_supported?: string[];
        };
        assert.equal(new URL(authMetadata.issuer ?? "").origin, new URL(daemon.baseUrl).origin);
        assert.equal(new URL(authMetadata.authorization_endpoint ?? "").pathname, "/authorize");
        assert.equal(new URL(authMetadata.token_endpoint ?? "").pathname, "/token");
        assert.equal(new URL(authMetadata.registration_endpoint ?? "").pathname, "/register");
        assert.equal(new URL(authMetadata.revocation_endpoint ?? "").pathname, "/revoke");
        assert.equal(authMetadata.code_challenge_methods_supported?.includes("S256"), true);

        const unauthenticatedMcp = await fetch(daemon.mcpUrl, { method: "GET" });
        assert.equal(unauthenticatedMcp.status, 401);
        assert.match(unauthenticatedMcp.headers.get("www-authenticate") ?? "", /Bearer/i);

        const token = await issueOAuthSession({
            baseUrl: daemon.baseUrl,
            mcpUrl: daemon.mcpUrl,
            password,
            clientName: "oauth-contract-client",
            redirectPort: 55201,
        });
        const mcp = await connectMcp(daemon.mcpUrl, { bearerToken: token.accessToken });
        try {
            const session = { "openai/session": "oauth-contract-conversation" };
            expectToolOk(await mcp.call("project_select", { project_id: project.id }, session));
            const read = expectToolOk<{ content?: string }>(await mcp.call("read", { path: "identity.txt" }, session));
            assert.equal(read.content, "OAUTH\n");
        } finally {
            await mcp.close();
        }

        const oauthStateText = await readFile(join(env.home, ".codex-mcp", "oauth-state.json"), "utf8");
        assert.equal(oauthStateText.includes(token.accessToken), false);
        assert.equal(oauthStateText.includes(token.refreshToken), false);
        const authText = await readFile(join(env.home, ".codex-mcp", "auth.json"), "utf8");
        assert.equal(authText.includes(password), false);
        assert.match(authText, /argon2id/);
    } finally {
        await daemon.close().catch(() => undefined);
        await env.cleanup();
    }
});

test("OAuth contract: refresh rotation rejects replay and revocation invalidates access", async () => {
    const env = await createTestEnvironment("codex-mcp-oauth-rotation-contract-");
    const projectPath = await createProject("oauth-rotation");
    const password = "rotation-password";
    const daemon = await startDaemonHarness({
        home: env.home,
        bootstrapRoot: projectPath,
        oauthRequired: true,
        password,
    });

    try {
        const session = await issueOAuthSession({
            baseUrl: daemon.baseUrl,
            mcpUrl: daemon.mcpUrl,
            password,
            clientName: "rotation-client",
            redirectPort: 55202,
        });
        const rotated = await refreshOAuthSession({
            baseUrl: daemon.baseUrl,
            mcpUrl: daemon.mcpUrl,
            clientId: session.clientId,
            refreshToken: session.refreshToken,
        });
        assert.notEqual(rotated.refreshToken, session.refreshToken, "refresh tokens must rotate");

        // The newly rotated access token is valid before any replay attempt.
        const currentAccessWorks = await connectMcp(daemon.mcpUrl, { bearerToken: rotated.accessToken });
        await currentAccessWorks.close();

        // Replaying an already-rotated refresh token is rejected and invalidates
        // the token family, including the access token minted by the rotation.
        const replay = await fetch(new URL("/token", daemon.baseUrl), {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "refresh_token",
                client_id: session.clientId,
                refresh_token: session.refreshToken,
                scope: "mcp:tools offline_access",
                resource: daemon.mcpUrl,
            }),
        });
        assert.equal(replay.status, 400);
        assert.equal((await replay.json() as { error?: string }).error, "invalid_grant");
        const familyRevoked = await fetch(daemon.mcpUrl, {
            method: "GET",
            headers: { Authorization: `Bearer ${rotated.accessToken}` },
        });
        assert.equal(familyRevoked.status, 401);

        // Explicit access-token revocation is tested on a fresh token family so
        // replay protection and revocation are independent contracts.
        const second = await issueOAuthSession({
            baseUrl: daemon.baseUrl,
            mcpUrl: daemon.mcpUrl,
            password,
            clientName: "revoke-client",
            redirectPort: 55203,
        });
        const revoke = await fetch(new URL("/revoke", daemon.baseUrl), {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: second.clientId,
                token: second.accessToken,
                token_type_hint: "access_token",
            }),
        });
        assert.equal(revoke.status, 200, await revoke.clone().text());

        const revoked = await fetch(daemon.mcpUrl, {
            method: "GET",
            headers: { Authorization: `Bearer ${second.accessToken}` },
        });
        assert.equal(revoked.status, 401);
    } finally {
        await daemon.close().catch(() => undefined);
        await env.cleanup();
    }
});

test("HTTP security contract: daemon controls require token and hostile Host headers fail closed", async () => {
    const env = await createTestEnvironment("codex-mcp-http-security-contract-");
    const projectPath = await createProject("http-security");
    const daemon = await startDaemonHarness({ home: env.home, bootstrapRoot: projectPath });

    try {
        const missingToken = await fetch(new URL("/daemon/status", daemon.baseUrl));
        assert.equal(missingToken.status, 401);

        const wrongToken = await fetch(new URL("/daemon/status", daemon.baseUrl), {
            headers: { "x-codex-control-token": "wrong-token" },
        });
        assert.equal(wrongToken.status, 401);

        const hostileHostStatus = await rawHostRequest(daemon.mcpUrl, "evil.example");
        assert.equal(hostileHostStatus, 403);
    } finally {
        await daemon.close().catch(() => undefined);
        await env.cleanup();
    }
});

function rawHostRequest(urlValue: string, hostHeader: string): Promise<number> {
    const url = new URL(urlValue);
    const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "host-contract", version: "1.0.0" },
        },
    });
    return new Promise<number>((resolveStatus, rejectStatus) => {
        const req = request({
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: "POST",
            headers: {
                Host: hostHeader,
                Accept: "application/json, text/event-stream",
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
            },
        }, (res) => {
            res.resume();
            res.once("end", () => resolveStatus(res.statusCode ?? 0));
        });
        req.once("error", rejectStatus);
        req.end(body);
    });
}

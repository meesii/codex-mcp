import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../src/config/loader.js";
import { setAdminPassword } from "../src/auth/password-store.js";
import { parseCimdClientDocument } from "../src/auth/provider.js";
import { createHttpServer } from "../src/server/http-server.js";
import { connectMcpClient } from "./helpers/mcp-client.js";

async function main(): Promise<void> {
    process.env.CODING_MCP_LOG_TOOLS = "0";
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const home = await mkdtemp(join(tmpdir(), "codex-mcp-oauth-home-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    await mkdir(join(home, ".codex-mcp"), { recursive: true });

    const cimdClientId = "https://client.example/oauth/client.json";
    assert.equal(
        parseCimdClientDocument(cimdClientId, {
            client_id: "https://attacker.example/oauth/client.json",
            client_name: "Mismatched client",
            redirect_uris: ["https://client.example/callback"],
            token_endpoint_auth_method: "none",
        }),
        undefined,
        "CIMD client_id must match the metadata document URL exactly",
    );
    assert.equal(
        parseCimdClientDocument(cimdClientId, {
            client_id: cimdClientId,
            client_name: "Insecure redirect client",
            redirect_uris: ["http://example.com/callback"],
            token_endpoint_auth_method: "none",
        }),
        undefined,
        "CIMD must reject non-loopback HTTP redirects",
    );
    assert.equal(
        parseCimdClientDocument(cimdClientId, {
            client_id: cimdClientId,
            client_name: "Unsupported client auth",
            redirect_uris: ["https://client.example/callback"],
            token_endpoint_auth_method: "private_key_jwt",
        }),
        undefined,
        "private_key_jwt CIMD must publish verification keys",
    );
    assert.equal(
        parseCimdClientDocument(cimdClientId, {
            client_id: cimdClientId,
            client_name: "Valid client",
            redirect_uris: ["http://127.0.0.1:43123/callback"],
            token_endpoint_auth_method: "none",
        })?.client_id,
        cimdClientId,
    );

    const projectRoot = await mkdtemp(join(tmpdir(), "codex-mcp-oauth-project-"));
    await writeFile(join(projectRoot, "hello.txt"), "hello oauth\n", "utf8");
    const password = "correct horse battery staple";
    await setAdminPassword(password);

    const config: ServerConfig = {
        host: "127.0.0.1",
        port: 0,
        local: false,
        oauthRequired: true,
        projectRoot,
        allowedHosts: [],
        widgetDomain: "http://127.0.0.1",
    };
    const server = createHttpServer(config);
    await server.listen();
    const mcpUrl = server.getMcpUrl();
    const baseUrl = new URL("/", mcpUrl).href;

    try {
        const unauthenticated = await fetch(mcpUrl, { redirect: "manual" });
        assert.equal(unauthenticated.status, 401);
        assert.match(
            unauthenticated.headers.get("www-authenticate") ?? "",
            /resource_metadata=/,
        );

        const protectedMetadata = await fetch(
            new URL("/.well-known/oauth-protected-resource/mcp", baseUrl),
        ).then((response) => response.json()) as {
            resource?: string;
            authorization_servers?: string[];
        };
        assert.equal(protectedMetadata.resource, mcpUrl);
        assert.deepEqual(protectedMetadata.authorization_servers, [baseUrl]);

        const authorizationMetadata = await fetch(
            new URL("/.well-known/oauth-authorization-server", baseUrl),
        ).then((response) => response.json()) as {
            issuer?: string;
            authorization_endpoint?: string;
            token_endpoint?: string;
            registration_endpoint?: string;
            token_endpoint_auth_methods_supported?: string[];
            token_endpoint_auth_signing_alg_values_supported?: string[];
            revocation_endpoint_auth_methods_supported?: string[];
            revocation_endpoint_auth_signing_alg_values_supported?: string[];
            client_id_metadata_document_supported?: boolean;
        };
        assert.equal(authorizationMetadata.issuer, baseUrl);
        assert.equal(authorizationMetadata.client_id_metadata_document_supported, true);
        assert.equal(authorizationMetadata.authorization_endpoint, new URL("/authorize", baseUrl).href);
        assert.equal(authorizationMetadata.token_endpoint, new URL("/token", baseUrl).href);
        assert.equal(authorizationMetadata.registration_endpoint, new URL("/register", baseUrl).href);
        assert.deepEqual(authorizationMetadata.token_endpoint_auth_methods_supported, [
            "private_key_jwt",
            "none",
        ]);
        assert.deepEqual(authorizationMetadata.token_endpoint_auth_signing_alg_values_supported, [
            "RS256",
        ]);
        assert.deepEqual(authorizationMetadata.revocation_endpoint_auth_methods_supported, [
            "private_key_jwt",
            "none",
        ]);
        assert.deepEqual(
            authorizationMetadata.revocation_endpoint_auth_signing_alg_values_supported,
            ["RS256"],
        );

        const insecureRegistration = await fetch(new URL("/register", baseUrl), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                redirect_uris: ["http://example.com/oauth/callback"],
                token_endpoint_auth_method: "none",
                grant_types: ["authorization_code"],
                response_types: ["code"],
                client_name: "insecure redirect",
            }),
        });
        assert.equal(insecureRegistration.status, 400);

        const redirectUri = "http://127.0.0.1:54321/oauth/callback";
        const confidentialRegistration = await fetch(new URL("/register", baseUrl), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                redirect_uris: [redirectUri],
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
                client_name: "unsupported confidential client",
                scope: "mcp:tools offline_access",
            }),
        });
        assert.equal(confidentialRegistration.status, 400);
        assert.equal(
            (await confidentialRegistration.json() as { error?: string }).error,
            "invalid_client_metadata",
        );

        const registrationResponse = await fetch(new URL("/register", baseUrl), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                redirect_uris: [redirectUri],
                token_endpoint_auth_method: "none",
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
                client_name: "codex-mcp OAuth E2E",
                scope: "mcp:tools offline_access",
            }),
        });
        assert.equal(registrationResponse.status, 201, await registrationResponse.clone().text());
        const registration = await registrationResponse.json() as { client_id: string };
        assert.ok(registration.client_id);

        const verifier = randomBytes(32).toString("base64url");
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        const insufficientScopeUrl = new URL("/authorize", baseUrl);
        insufficientScopeUrl.searchParams.set("client_id", registration.client_id);
        insufficientScopeUrl.searchParams.set("redirect_uri", redirectUri);
        insufficientScopeUrl.searchParams.set("response_type", "code");
        insufficientScopeUrl.searchParams.set("code_challenge", challenge);
        insufficientScopeUrl.searchParams.set("code_challenge_method", "S256");
        insufficientScopeUrl.searchParams.set("scope", "offline_access");
        insufficientScopeUrl.searchParams.set("resource", mcpUrl);
        const insufficientScopeResponse = await fetch(insufficientScopeUrl, {
            redirect: "manual",
        });
        assert.equal(insufficientScopeResponse.status, 302);
        const insufficientScopeLocation = insufficientScopeResponse.headers.get("location");
        assert.ok(insufficientScopeLocation);
        assert.equal(new URL(insufficientScopeLocation).searchParams.get("error"), "invalid_scope");

        const authorizeUrl = new URL("/authorize", baseUrl);
        authorizeUrl.searchParams.set("client_id", registration.client_id);
        authorizeUrl.searchParams.set("redirect_uri", redirectUri);
        authorizeUrl.searchParams.set("response_type", "code");
        authorizeUrl.searchParams.set("code_challenge", challenge);
        authorizeUrl.searchParams.set("code_challenge_method", "S256");
        authorizeUrl.searchParams.set("scope", "mcp:tools offline_access");
        authorizeUrl.searchParams.set("state", "oauth-e2e-state");
        authorizeUrl.searchParams.set("resource", mcpUrl);

        const missingResourceAuthorize = new URL(authorizeUrl);
        missingResourceAuthorize.searchParams.delete("resource");
        const missingResourceAuthorizeResponse = await fetch(missingResourceAuthorize, {
            redirect: "manual",
        });
        assert.equal(missingResourceAuthorizeResponse.status, 302);
        const missingResourceLocation = missingResourceAuthorizeResponse.headers.get("location");
        assert.ok(missingResourceLocation);
        assert.equal(new URL(missingResourceLocation).searchParams.get("error"), "invalid_target");

        const authorizeResponse = await fetch(authorizeUrl, { redirect: "manual" });
        assert.equal(authorizeResponse.status, 200);
        const loginCsp = authorizeResponse.headers.get("content-security-policy") ?? "";
        assert.match(loginCsp, /default-src 'none'/);
        assert.doesNotMatch(loginCsp, /form-action/);
        const loginHtml = await authorizeResponse.text();
        assert.doesNotMatch(loginHtml, /pending_id/);
        assert.doesNotMatch(loginHtml, /\/oauth\/approve/);
        assert.match(loginHtml, /<form method="post" action="\/authorize"/);
        assert.match(loginHtml, /name="client_id"/);
        assert.match(loginHtml, /name="redirect_uri"/);
        assert.match(loginHtml, /name="code_challenge"/);
        assert.match(loginHtml, /name="resource"/);
        assert.doesNotMatch(loginHtml, new RegExp(password));
        assert.match(loginHtml, /连接返回到：/);
        assert.match(loginHtml, /127\.0\.0\.1:54321/);
        assert.match(loginHtml, /这个连接会回到当前电脑/);

        const approvalBody = (approvalPassword: string): URLSearchParams => {
            const body = new URLSearchParams(authorizeUrl.searchParams);
            body.set("password", approvalPassword);
            return body;
        };
        const authorizePostUrl = new URL("/authorize", baseUrl);

        const removedApproveEndpoint = await fetch(new URL("/oauth/approve", baseUrl), {
            method: "POST",
            redirect: "manual",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ password: "unused" }),
        });
        assert.equal(removedApproveEndpoint.status, 404);

        const badApproval = await fetch(authorizePostUrl, {
            method: "POST",
            redirect: "manual",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: approvalBody("wrong password"),
        });
        assert.equal(badApproval.status, 401);
        assert.match(await badApproval.text(), /连接密码不正确/);

        const concurrentApprovals = await Promise.all(
            Array.from({ length: 5 }, () =>
                fetch(authorizePostUrl, {
                    method: "POST",
                    redirect: "manual",
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: approvalBody("still wrong"),
                }),
            ),
        );
        assert.ok(
            concurrentApprovals.some((response) => response.status === 429),
            `expected concurrent approval throttling, got ${concurrentApprovals.map((response) => response.status).join(",")}`,
        );

        const approvalResponse = await fetch(authorizePostUrl, {
            method: "POST",
            redirect: "manual",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: approvalBody(password),
        });
        assert.equal(approvalResponse.status, 302, await approvalResponse.clone().text());
        const approvalLocation = approvalResponse.headers.get("location");
        assert.ok(approvalLocation);
        const callback = new URL(approvalLocation);
        const authorizationCode = callback.searchParams.get("code");
        assert.ok(authorizationCode);
        assert.equal(callback.searchParams.get("state"), "oauth-e2e-state");
        assert.equal(callback.searchParams.get("iss"), baseUrl);

        const badVerifierResponse = await fetch(new URL("/token", baseUrl), {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                client_id: registration.client_id,
                code: authorizationCode,
                code_verifier: `${verifier}-wrong`,
                redirect_uri: redirectUri,
                resource: mcpUrl,
            }),
        });
        assert.equal(badVerifierResponse.status, 400);
        assert.equal(
            (await badVerifierResponse.json() as { error?: string }).error,
            "invalid_grant",
        );

        const missingResourceToken = await fetch(new URL("/token", baseUrl), {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                client_id: registration.client_id,
                code: authorizationCode,
                code_verifier: verifier,
                redirect_uri: redirectUri,
            }),
        });
        assert.equal(missingResourceToken.status, 400);
        assert.equal(
            (await missingResourceToken.json() as { error?: string }).error,
            "invalid_grant",
        );

        const tokenResponse = await fetch(new URL("/token", baseUrl), {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                client_id: registration.client_id,
                code: authorizationCode,
                code_verifier: verifier,
                redirect_uri: redirectUri,
                resource: mcpUrl,
            }),
        });
        assert.equal(tokenResponse.status, 200, await tokenResponse.clone().text());
        const tokens = await tokenResponse.json() as {
            access_token: string;
            refresh_token: string;
            token_type: string;
            expires_in: number;
        };
        assert.ok(tokens.access_token);
        assert.ok(tokens.refresh_token);
        assert.match(tokens.token_type, /bearer/i);
        assert.ok(tokens.expires_in > 0 && tokens.expires_in <= 15 * 60);

        const oauthStateText = await readFile(
            join(home, ".codex-mcp", "oauth-state.json"),
            "utf8",
        );
        assert.ok(!oauthStateText.includes(tokens.access_token));
        assert.ok(!oauthStateText.includes(tokens.refresh_token));
        assert.ok(!oauthStateText.includes(authorizationCode));
        assert.ok(!oauthStateText.includes("client_secret"));
        const authFileText = await readFile(join(home, ".codex-mcp", "auth.json"), "utf8");
        assert.ok(!authFileText.includes(password));
        assert.match(authFileText, /argon2id/);

        const mcp = await connectMcpClient(mcpUrl, {
            Authorization: `Bearer ${tokens.access_token}`,
        });
        const reconnectMcp = await connectMcpClient(mcpUrl, {
            Authorization: `Bearer ${tokens.access_token}`,
        });
        try {
            const toolNames = await mcp.listToolNames();
            assert.ok(toolNames.includes("read"));
            const readTool = (await mcp.client.listTools()).tools.find(
                (tool) => tool.name === "read",
            );
            const securitySchemes = (readTool?._meta as
                | { securitySchemes?: Array<{ type?: string; scopes?: string[] }> }
                | undefined)?.securitySchemes;
            assert.equal(securitySchemes?.[0]?.type, "oauth2");
            assert.deepEqual(securitySchemes?.[0]?.scopes, ["mcp:tools"]);

            const runtimeStatus = await mcp.callTool("runtime_status", {});
            assert.notEqual(runtimeStatus.isError, true);
            assert.ok(
                ((runtimeStatus.structuredContent as {
                    http?: { status4xx?: number; requests?: number };
                }).http?.status4xx ?? 0) >= 1,
                "runtime HTTP telemetry must include unauthenticated /mcp 401 responses",
            );

            const longRunning = await mcp.callTool("exec_command", {
                command:
                    process.platform === "win32"
                        ? "Start-Sleep -Seconds 60"
                        : "sleep 60",
                yield_time_ms: 0,
            });
            assert.notEqual(longRunning.isError, true);
            const processId = (longRunning.structuredContent as { processId?: number }).processId;
            assert.ok(processId);

            const reconnectPoll = await reconnectMcp.callTool("write_stdin", {
                processId,
                yield_time_ms: 0,
            });
            assert.notEqual(
                reconnectPoll.isError,
                true,
                "same OAuth client must retain process ownership across MCP sessions",
            );
            assert.equal(
                (reconnectPoll.structuredContent as { running?: boolean }).running,
                true,
            );

            const reconnectKill = await reconnectMcp.callTool("process_kill", { processId });
            assert.notEqual(reconnectKill.isError, true);
        } finally {
            await reconnectMcp.close();
            await mcp.close();
        }

        const missingResourceRefresh = await fetch(new URL("/token", baseUrl), {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "refresh_token",
                client_id: registration.client_id,
                refresh_token: tokens.refresh_token,
            }),
        });
        assert.equal(missingResourceRefresh.status, 400);
        assert.equal(
            (await missingResourceRefresh.json() as { error?: string }).error,
            "invalid_grant",
        );

        const revokeResponse = await fetch(new URL("/revoke", baseUrl), {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: registration.client_id,
                token: tokens.access_token,
                token_type_hint: "access_token",
            }),
        });
        assert.equal(revokeResponse.status, 200, await revokeResponse.clone().text());
        const revokedAccessRequest = await fetch(mcpUrl, {
            redirect: "manual",
            headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        assert.equal(revokedAccessRequest.status, 401);

        const invalidRefreshScope = await fetch(new URL("/token", baseUrl), {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "refresh_token",
                client_id: registration.client_id,
                refresh_token: tokens.refresh_token,
                scope: "offline_access",
                resource: mcpUrl,
            }),
        });
        assert.equal(invalidRefreshScope.status, 400);
        assert.equal(
            (await invalidRefreshScope.json() as { error?: string }).error,
            "invalid_scope",
        );

        const refreshResponse = await fetch(new URL("/token", baseUrl), {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "refresh_token",
                client_id: registration.client_id,
                refresh_token: tokens.refresh_token,
                resource: mcpUrl,
            }),
        });
        assert.equal(refreshResponse.status, 200, await refreshResponse.clone().text());
        const rotated = await refreshResponse.json() as {
            access_token: string;
            refresh_token: string;
        };
        assert.notEqual(rotated.refresh_token, tokens.refresh_token);

        const secondRegistrationResponse = await fetch(new URL("/register", baseUrl), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                redirect_uris: [redirectUri],
                token_endpoint_auth_method: "none",
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
                client_name: "second OAuth client",
            }),
        });
        assert.equal(secondRegistrationResponse.status, 201);
        const secondRegistration = await secondRegistrationResponse.json() as {
            client_id: string;
        };

        const crossClientRevoke = await fetch(new URL("/revoke", baseUrl), {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: secondRegistration.client_id,
                token: rotated.refresh_token,
                token_type_hint: "refresh_token",
            }),
        });
        assert.equal(crossClientRevoke.status, 200);
        const stillValidAfterCrossClientRevoke = await connectMcpClient(mcpUrl, {
            Authorization: `Bearer ${rotated.access_token}`,
        });
        await stillValidAfterCrossClientRevoke.close();

        const replayResponse = await fetch(new URL("/token", baseUrl), {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "refresh_token",
                client_id: registration.client_id,
                refresh_token: tokens.refresh_token,
                resource: mcpUrl,
            }),
        });
        assert.equal(replayResponse.status, 400);
        assert.equal((await replayResponse.json() as { error?: string }).error, "invalid_grant");

        const revokedFamilyRequest = await fetch(mcpUrl, {
            redirect: "manual",
            headers: { Authorization: `Bearer ${rotated.access_token}` },
        });
        assert.equal(revokedFamilyRequest.status, 401);

        // Resetting the administrator password is a credential epoch change:
        // grants issued before the reset must stop working immediately, even
        // while this server process remains running.
        const resetVerifier = randomBytes(32).toString("base64url");
        const resetChallenge = createHash("sha256").update(resetVerifier).digest("base64url");
        const resetAuthorizeUrl = new URL("/authorize", baseUrl);
        resetAuthorizeUrl.searchParams.set("client_id", registration.client_id);
        resetAuthorizeUrl.searchParams.set("redirect_uri", redirectUri);
        resetAuthorizeUrl.searchParams.set("response_type", "code");
        resetAuthorizeUrl.searchParams.set("code_challenge", resetChallenge);
        resetAuthorizeUrl.searchParams.set("code_challenge_method", "S256");
        resetAuthorizeUrl.searchParams.set("scope", "mcp:tools offline_access");
        resetAuthorizeUrl.searchParams.set("resource", mcpUrl);
        const resetAuthorizeResponse = await fetch(resetAuthorizeUrl, { redirect: "manual" });
        assert.equal(resetAuthorizeResponse.status, 200);
        assert.doesNotMatch(await resetAuthorizeResponse.text(), /pending_id|\/oauth\/approve/);
        const resetApprovalBody = new URLSearchParams(resetAuthorizeUrl.searchParams);
        resetApprovalBody.set("password", password);
        const resetApproval = await fetch(new URL("/authorize", baseUrl), {
            method: "POST",
            redirect: "manual",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: resetApprovalBody,
        });
        assert.equal(resetApproval.status, 302);
        const resetLocation = resetApproval.headers.get("location");
        assert.ok(resetLocation);
        const resetCode = new URL(resetLocation).searchParams.get("code");
        assert.ok(resetCode);
        const resetTokenResponse = await fetch(new URL("/token", baseUrl), {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                client_id: registration.client_id,
                code: resetCode,
                code_verifier: resetVerifier,
                redirect_uri: redirectUri,
                resource: mcpUrl,
            }),
        });
        assert.equal(resetTokenResponse.status, 200);
        const resetTokens = await resetTokenResponse.json() as {
            access_token: string;
            refresh_token: string;
        };
        const validBeforePasswordReset = await connectMcpClient(mcpUrl, {
            Authorization: `Bearer ${resetTokens.access_token}`,
        });
        await validBeforePasswordReset.close();

        const replacementPassword = "replacement administrator password";
        await setAdminPassword(replacementPassword);
        const invalidAfterPasswordReset = await fetch(mcpUrl, {
            redirect: "manual",
            headers: { Authorization: `Bearer ${resetTokens.access_token}` },
        });
        assert.equal(invalidAfterPasswordReset.status, 401);
        const invalidRefreshAfterPasswordReset = await fetch(new URL("/token", baseUrl), {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "refresh_token",
                client_id: registration.client_id,
                refresh_token: resetTokens.refresh_token,
                resource: mcpUrl,
            }),
        });
        assert.equal(invalidRefreshAfterPasswordReset.status, 400);
        assert.equal(
            (await invalidRefreshAfterPasswordReset.json() as { error?: string }).error,
            "invalid_grant",
        );
        const resetAuthFileText = await readFile(join(home, ".codex-mcp", "auth.json"), "utf8");
        assert.ok(!resetAuthFileText.includes(password));
        assert.ok(!resetAuthFileText.includes(replacementPassword));
    } finally {
        await server.close().catch(() => undefined);
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previousUserProfile;
    }

    console.log("oauth.e2e.test.ts: ok");
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});

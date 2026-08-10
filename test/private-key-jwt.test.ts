import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { createRevocationEndpoint, createTokenEndpoint } from "../src/auth/endpoints.js";
import { OAuthStateStore } from "../src/auth/oauth-state.js";
import {
    getAdminCredentialGeneration,
    setAdminPassword,
} from "../src/auth/password-store.js";
import {
    JWT_BEARER_ASSERTION_TYPE,
    PRIVATE_KEY_JWT_ALGORITHMS,
} from "../src/auth/private-key-jwt.js";
import {
    CodexOAuthProvider,
    parseCimdClientDocument,
} from "../src/auth/provider.js";

async function main(): Promise<void> {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const home = await mkdtemp(join(tmpdir(), "codex-mcp-pkjwt-home-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    try {
        const issuerUrl = new URL("https://mcp.example.test/");
        const resourceUrl = new URL("https://mcp.example.test/mcp");
        const clientId = "https://chatgpt.example/oauth/client.json";
        const redirectUri = "https://chatgpt.example/connector/oauth/callback";
        const { publicKey, privateKey } = await generateKeyPair("RS256", {
            modulusLength: 2048,
            extractable: true,
        });
        const publicJwk = await exportJWK(publicKey);
        Object.assign(publicJwk, { kid: "chatgpt-test-key", alg: "RS256", use: "sig" });
        const jwks = { keys: [publicJwk] };

        const parsedClient = parseCimdClientDocument(clientId, {
            client_id: clientId,
            client_name: "ChatGPT-style client",
            client_uri: "https://chatgpt.example/",
            redirect_uris: [redirectUri],
            token_endpoint_auth_method: "private_key_jwt",
            token_endpoint_auth_signing_alg: "RS256",
            jwks,
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
        });
        assert.ok(parsedClient, "private_key_jwt CIMD with a valid public JWKS must be accepted");
        assert.equal(parsedClient.token_endpoint_auth_method, "private_key_jwt");
        assert.deepEqual(PRIVATE_KEY_JWT_ALGORITHMS, ["RS256"]);

        assert.equal(
            parseCimdClientDocument(clientId, {
                client_id: clientId,
                client_name: "Missing keys",
                redirect_uris: [redirectUri],
                token_endpoint_auth_method: "private_key_jwt",
            }),
            undefined,
            "private_key_jwt CIMD without jwks/jwks_uri must be rejected",
        );
        assert.equal(
            parseCimdClientDocument(clientId, {
                client_id: clientId,
                client_name: "Wrong algorithm",
                redirect_uris: [redirectUri],
                token_endpoint_auth_method: "private_key_jwt",
                token_endpoint_auth_signing_alg: "HS256",
                jwks,
            }),
            undefined,
            "symmetric/unsupported client assertion algorithms must be rejected",
        );
        assert.equal(
            parseCimdClientDocument(clientId, {
                client_id: clientId,
                client_name: "JWKS with secret material",
                redirect_uris: [redirectUri],
                token_endpoint_auth_method: "private_key_jwt",
                token_endpoint_auth_signing_alg: "RS256",
                jwks: {
                    keys: [
                        publicJwk,
                        { kty: "oct", k: "c2VjcmV0LWtleS1tYXRlcmlhbA", alg: "HS256" },
                    ],
                },
            }),
            undefined,
            "CIMD JWKS must not contain symmetric/private key material",
        );

        await setAdminPassword("private key jwt integration password");
        const generation = await getAdminCredentialGeneration();
        assert.ok(generation);

        const state = await OAuthStateStore.open(join(home, "oauth-state-test.json"));
        await state.registerClient(
            {
                ...parsedClient,
                client_id_issued_at: Math.floor(Date.now() / 1000),
            },
            issuerUrl.href,
        );
        const provider = new CodexOAuthProvider(state, issuerUrl, resourceUrl);

        const firstAssertion = await signClientAssertion(
            clientId,
            issuerUrl.href,
            privateKey,
            randomUUID(),
        );
        const assertionWithoutJti = await signClientAssertion(
            clientId,
            issuerUrl.href,
            privateKey,
        );
        await assert.rejects(
            provider.authenticateClient({
                client_id: clientId,
                client_assertion_type: JWT_BEARER_ASSERTION_TYPE,
                client_assertion: assertionWithoutJti,
            }),
            /Invalid client authentication/,
            "OpenID Connect private_key_jwt requires a jti claim",
        );
        const authenticated = await provider.authenticateClient({
            client_id: clientId,
            client_assertion_type: JWT_BEARER_ASSERTION_TYPE,
            client_assertion: firstAssertion,
        });
        assert.equal(authenticated.client_id, clientId);

        const shortUniqueJtiAssertion = await signClientAssertion(
            clientId,
            issuerUrl.href,
            privateKey,
            "1",
        );
        assert.equal(
            (await provider.authenticateClient({
                client_id: clientId,
                client_assertion_type: JWT_BEARER_ASSERTION_TYPE,
                client_assertion: shortUniqueJtiAssertion,
            })).client_id,
            clientId,
            "jti uniqueness/replay protection must not impose a non-standard entropy length",
        );

        await assert.rejects(
            provider.authenticateClient({
                client_id: clientId,
                client_assertion_type: JWT_BEARER_ASSERTION_TYPE,
                client_assertion: firstAssertion,
            }),
            /Invalid client authentication/,
            "client assertions must be one-time and replay-protected",
        );

        const tokenEndpointAudience = new URL("/token", issuerUrl).href;
        const tokenEndpointAssertion = await signClientAssertion(
            clientId,
            tokenEndpointAudience,
            privateKey,
            randomUUID(),
        );
        assert.equal(
            (await provider.authenticateClient({
                client_id: clientId,
                client_assertion_type: JWT_BEARER_ASSERTION_TYPE,
                client_assertion: tokenEndpointAssertion,
            })).client_id,
            clientId,
            "RFC 7523/OpenID private_key_jwt must accept the exact token endpoint URL as audience",
        );

        const dualAudienceAssertion = await signClientAssertion(
            clientId,
            [issuerUrl.href, tokenEndpointAudience],
            privateKey,
            randomUUID(),
        );
        assert.equal(
            (await provider.authenticateClient({
                client_id: clientId,
                client_assertion_type: JWT_BEARER_ASSERTION_TYPE,
                client_assertion: dualAudienceAssertion,
            })).client_id,
            clientId,
            "issuer + token endpoint audiences are both identities of this authorization server",
        );

        const wrongAudience = await signClientAssertion(
            clientId,
            "https://unrelated.example/token",
            privateKey,
            randomUUID(),
        );
        await assert.rejects(
            provider.authenticateClient({
                client_id: clientId,
                client_assertion_type: JWT_BEARER_ASSERTION_TYPE,
                client_assertion: wrongAudience,
            }),
            /Invalid client authentication/,
            "unrelated audiences must still be rejected",
        );

        const mixedAudience = await signClientAssertion(
            clientId,
            [tokenEndpointAudience, "https://unrelated.example/token"],
            privateKey,
            randomUUID(),
        );
        await assert.rejects(
            provider.authenticateClient({
                client_id: clientId,
                client_assertion_type: JWT_BEARER_ASSERTION_TYPE,
                client_assertion: mixedAudience,
            }),
            /Invalid client authentication/,
            "an otherwise valid audience list must not smuggle unrelated audiences",
        );

        const verifier = "A".repeat(43);
        const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
        const code = await state.createAuthorizationCode({
            clientId,
            redirectUri,
            codeChallenge: challenge,
            scopes: ["mcp:tools", "offline_access"],
            resource: resourceUrl,
            credentialGeneration: generation,
        });

        const app = express();
        app.use("/token", createTokenEndpoint(provider));
        app.use("/revoke", createRevocationEndpoint(provider));
        const server = app.listen(0, "127.0.0.1");
        await new Promise<void>((resolve, reject) => {
            server.once("listening", resolve);
            server.once("error", reject);
        });
        const address = server.address();
        assert.ok(address && typeof address === "object");
        const localBase = `http://127.0.0.1:${address.port}`;

        try {
            const tokenAssertion = await signClientAssertion(
                clientId,
                tokenEndpointAudience,
                privateKey,
                randomUUID(),
            );
            const tokenResponse = await fetch(`${localBase}/token`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    grant_type: "authorization_code",
                    client_id: clientId,
                    client_assertion_type: JWT_BEARER_ASSERTION_TYPE,
                    client_assertion: tokenAssertion,
                    code,
                    code_verifier: verifier,
                    redirect_uri: redirectUri,
                    resource: resourceUrl.href,
                }),
            });
            assert.equal(tokenResponse.status, 200, await tokenResponse.clone().text());
            const tokens = await tokenResponse.json() as {
                access_token: string;
                refresh_token: string;
            };
            assert.ok(tokens.access_token);
            assert.ok(tokens.refresh_token);

            const refreshAssertion = await signClientAssertion(
                clientId,
                tokenEndpointAudience,
                privateKey,
                randomUUID(),
            );
            const refreshResponse = await fetch(`${localBase}/token`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    grant_type: "refresh_token",
                    client_id: clientId,
                    client_assertion_type: JWT_BEARER_ASSERTION_TYPE,
                    client_assertion: refreshAssertion,
                    refresh_token: tokens.refresh_token,
                    resource: resourceUrl.href,
                }),
            });
            assert.equal(refreshResponse.status, 200, await refreshResponse.clone().text());
            const rotated = await refreshResponse.json() as {
                access_token: string;
                refresh_token: string;
            };
            assert.notEqual(rotated.refresh_token, tokens.refresh_token);

            const revokeAssertion = await signClientAssertion(
                clientId,
                tokenEndpointAudience,
                privateKey,
                randomUUID(),
            );
            const revokeResponse = await fetch(`${localBase}/revoke`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    client_id: clientId,
                    client_assertion_type: JWT_BEARER_ASSERTION_TYPE,
                    client_assertion: revokeAssertion,
                    token: rotated.access_token,
                    token_type_hint: "access_token",
                }),
            });
            assert.equal(revokeResponse.status, 200, await revokeResponse.clone().text());
            await assert.rejects(
                provider.verifyAccessToken(rotated.access_token),
                /Invalid or expired access token/,
            );
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previousUserProfile;
    }
}

async function signClientAssertion(
    clientId: string,
    audience: string | string[],
    privateKey: CryptoKey,
    jti?: string,
): Promise<string> {
    let jwt = new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "chatgpt-test-key", typ: "client-authentication+jwt" })
        .setIssuer(clientId)
        .setSubject(clientId)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime("2m");
    if (jti !== undefined) jwt = jwt.setJti(jti);
    return jwt.sign(privateKey);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

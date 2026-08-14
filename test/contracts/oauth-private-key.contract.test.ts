import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { PrivateKeyJwtVerifier } from "../../src/auth/private-key-jwt.js";
import {
    createProject,
    createTestEnvironment,
    startDaemonHarness,
} from "./harness.js";

test("private_key_jwt external contract: metadata advertises CIMD/RS256 while DCR remains public-PKCE only", async () => {
    const env = await createTestEnvironment("codex-mcp-pkjwt-http-contract-");
    const project = await createProject("pkjwt-http");
    const daemon = await startDaemonHarness({
        home: env.home,
        bootstrapRoot: project,
        oauthRequired: true,
        password: "private-key-contract-password",
    });

    try {
        const metadataResponse = await fetch(new URL("/.well-known/oauth-authorization-server", daemon.baseUrl));
        assert.equal(metadataResponse.status, 200);
        const metadata = await metadataResponse.json() as {
            token_endpoint_auth_methods_supported?: string[];
            token_endpoint_auth_signing_alg_values_supported?: string[];
            revocation_endpoint_auth_methods_supported?: string[];
            client_id_metadata_document_supported?: boolean;
        };
        assert.equal(metadata.token_endpoint_auth_methods_supported?.includes("private_key_jwt"), true);
        assert.deepEqual(metadata.token_endpoint_auth_signing_alg_values_supported, ["RS256"]);
        assert.equal(metadata.revocation_endpoint_auth_methods_supported?.includes("private_key_jwt"), true);
        assert.equal(metadata.client_id_metadata_document_supported, true);

        const dcrAttempt = await fetch(new URL("/register", daemon.baseUrl), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                redirect_uris: ["http://127.0.0.1:55301/callback"],
                token_endpoint_auth_method: "private_key_jwt",
                token_endpoint_auth_signing_alg: "RS256",
                jwks: { keys: [] },
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
            }),
        });
        assert.equal(dcrAttempt.status, 400);
        const dcrError = await dcrAttempt.json() as { error?: string; error_description?: string };
        assert.equal(dcrError.error, "invalid_client_metadata");
        assert.match(dcrError.error_description ?? "", /public OAuth clients|token_endpoint_auth_method="none"|PKCE/i);
    } finally {
        await daemon.close().catch(() => undefined);
        await env.cleanup();
    }
});

test("private_key_jwt cryptographic contract: independent RSA assertions enforce jti, audience and replay protection", async () => {
    const issuer = new URL("https://mcp.example.test/");
    const tokenEndpoint = new URL("/token", issuer).href;
    const clientId = "https://chatgpt.example/oauth/client.json";
    const { publicKey, privateKey } = await generateKeyPair("RS256", {
        modulusLength: 2048,
        extractable: true,
    });
    const publicJwk = await exportJWK(publicKey);
    Object.assign(publicJwk, { kid: "contract-key", alg: "RS256", use: "sig" });
    const client: OAuthClientInformationFull = {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1_000),
        client_name: "independent assertion fixture",
        redirect_uris: ["https://chatgpt.example/connector/oauth/callback"],
        token_endpoint_auth_method: "private_key_jwt",
        jwks: { keys: [publicJwk] },
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
    };
    const verifier = new PrivateKeyJwtVerifier(issuer);

    const valid = await signAssertion({
        clientId,
        audience: tokenEndpoint,
        privateKey,
        jti: randomUUID(),
    });
    await verifier.verify(client, valid);

    await assert.rejects(
        verifier.verify(client, valid),
        /replay|already used|jti/i,
        "the same signed assertion must be one-time",
    );

    const noJti = await signAssertion({ clientId, audience: issuer.href, privateKey });
    await assert.rejects(verifier.verify(client, noJti), /jti|required/i);

    const wrongAudience = await signAssertion({
        clientId,
        audience: "https://unrelated.example/token",
        privateKey,
        jti: randomUUID(),
    });
    await assert.rejects(verifier.verify(client, wrongAudience), /aud|audience/i);

    const mixedAudience = await signAssertion({
        clientId,
        audience: [tokenEndpoint, "https://unrelated.example/token"],
        privateKey,
        jti: randomUUID(),
    });
    await assert.rejects(verifier.verify(client, mixedAudience), /aud|audience/i);

    const shortButUniqueJti = await signAssertion({
        clientId,
        audience: issuer.href,
        privateKey,
        jti: "1",
    });
    await verifier.verify(client, shortButUniqueJti);
});

async function signAssertion(options: {
    clientId: string;
    audience: string | string[];
    privateKey: CryptoKey;
    jti?: string;
}): Promise<string> {
    let jwt = new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "contract-key", typ: "client-authentication+jwt" })
        .setIssuer(options.clientId)
        .setSubject(options.clientId)
        .setAudience(options.audience)
        .setIssuedAt()
        .setExpirationTime("2m");
    if (options.jti !== undefined) jwt = jwt.setJti(options.jti);
    return await jwt.sign(options.privateKey);
}

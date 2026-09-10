import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, renameSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SignJWT, generateKeyPair, exportJWK } from "jose";

const home = mkdtempSync(join(tmpdir(), "codex-mcp-oauth-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { OAuthStateStore } = await import("../dist/auth/oauth-state.js");
const { PrivateKeyJwtVerifier } = await import("../dist/auth/private-key-jwt.js");
const resource = new URL("https://mcp.example.com/mcp");
const issuer = new URL("/", resource);
const client = { client_id: "client-a", client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: ["https://chatgpt.com/callback"], token_endpoint_auth_method: "none" };
const grant = { clientId: client.client_id, redirectUri: client.redirect_uris[0], codeChallenge: "challenge", scopes: ["mcp:tools", "offline_access"], resource, credentialGeneration: "generation-1" };
const exchange = code => ({ ...grant, code });

function fixture() {
    const path = join(mkdtempSync(join(home, "state-")), "oauth.json");
    return { path, block() {
        renameSync(path, `${path}.saved`);
        mkdirSync(path);
        return () => { rmSync(path, { recursive: true, force: true }); renameSync(`${path}.saved`, path); };
    } };
}

test("OAuth writes commit before publishing; failed registration and exchange remain retryable", async () => {
    const files = fixture();
    const store = await OAuthStateStore.open(files.path);
    let restore = files.block();
    try {
        await assert.rejects(store.registerClient(client, issuer.href));
        assert.equal(store.getClient(client.client_id, issuer.href), undefined);
    } finally { restore(); }
    await store.registerClient(client, issuer.href);
    const code = await store.createAuthorizationCode(grant);
    restore = files.block();
    try {
        await assert.rejects(store.exchangeAuthorizationCode(exchange(code)));
        assert.equal(await store.challengeForAuthorizationCode(client.client_id, code), grant.codeChallenge);
    } finally { restore(); }
    const tokens = await store.exchangeAuthorizationCode(exchange(code));
    const reopened = await OAuthStateStore.open(files.path);
    assert.equal((await reopened.verifyAccessToken(tokens.access_token, grant.credentialGeneration)).clientId, client.client_id);
    assert.equal(readFileSync(files.path, "utf8").includes(tokens.access_token), false);
    assert.equal(readFileSync(files.path, "utf8").includes(tokens.refresh_token), false);
    restore = files.block();
    try {
        await assert.rejects(store.exchangeRefreshToken({ ...grant, refreshToken: tokens.refresh_token }));
    } finally { restore(); }
    await store.exchangeRefreshToken({ ...grant, refreshToken: tokens.refresh_token });
});

test("OAuth codes are single use and bind resource, redirect, generation; refresh reuse revokes its family", async () => {
    const store = await OAuthStateStore.open(fixture().path);
    await store.registerClient(client, issuer.href);
    assert.equal(store.getClient(client.client_id, "https://other.example/"), undefined);
    const code = await store.createAuthorizationCode(grant);
    await assert.rejects(store.exchangeAuthorizationCode({ ...exchange(code), resource: new URL("https://other.example/mcp") }), /resource/);
    await assert.rejects(store.exchangeAuthorizationCode({ ...exchange(code), redirectUri: "https://other.example/callback" }), /redirect_uri/);
    const attempts = await Promise.allSettled([store.exchangeAuthorizationCode(exchange(code)), store.exchangeAuthorizationCode(exchange(code))]);
    assert.equal(attempts.filter(x => x.status === "fulfilled").length, 1);
    const tokens = attempts.find(x => x.status === "fulfilled").value;
    await assert.rejects(store.verifyAccessToken(tokens.access_token, "generation-2"), /Invalid/);
    await assert.rejects(store.exchangeRefreshToken({ ...grant, refreshToken: tokens.refresh_token, scopes: ["admin"] }), /scope/i);
    const rotated = await store.exchangeRefreshToken({ ...grant, refreshToken: tokens.refresh_token });
    assert.notEqual(tokens.refresh_token, rotated.refresh_token);
    await assert.rejects(store.exchangeRefreshToken({ ...grant, refreshToken: tokens.refresh_token }), /reuse/);
    await assert.rejects(store.verifyAccessToken(rotated.access_token, grant.credentialGeneration), /Invalid|revoked/);
    await assert.rejects(store.exchangeRefreshToken({ ...grant, refreshToken: rotated.refresh_token }), /reuse/);
});

test("private_key_jwt verifies signatures, audience, expiry and rejects replay", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...await exportJWK(publicKey), kid: "key-1", alg: "RS256" };
    const signedClient = { ...client, client_id: "https://client.example/metadata", token_endpoint_auth_method: "private_key_jwt", jwks: { keys: [jwk] } };
    const verifier = new PrivateKeyJwtVerifier(issuer);
    const sign = (audience = new URL("/token", issuer).href, expires = "2m", key = privateKey) => new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "key-1" }).setIssuer(signedClient.client_id).setSubject(signedClient.client_id)
        .setAudience(audience).setIssuedAt().setExpirationTime(expires).setJti(randomUUID()).sign(key);
    const valid = await sign();
    await verifier.verify(signedClient, valid);
    await assert.rejects(verifier.verify(signedClient, valid), /replay|reused/i);
    await assert.rejects(verifier.verify(signedClient, await sign("https://wrong.example/token")));
    await assert.rejects(verifier.verify(signedClient, await sign(issuer.href, "-5m")));
    const wrongKey = await generateKeyPair("RS256");
    await assert.rejects(verifier.verify(signedClient, await sign(issuer.href, "2m", wrongKey.privateKey)));
});

test("HTTP OAuth authorization, PKCE, refresh, revocation and credential rotation", async t => {
    const { setAdminPassword } = await import("../dist/auth/password-store.js");
    const { createHttpServer } = await import("../dist/server/http-server.js");
    const { loadConfig } = await import("../dist/config/loader.js");
    const password = "test-only-strong-password-123!";
    await setAdminPassword(password);
    const server = createHttpServer(loadConfig({ projectRoot: home, userConfig: { port: 0, publicAccess: { kind: "external", domain: "mcp.example.com" } } }));
    await server.listen();
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.getPort()}`;
    const request = (path, body, headers = {}) => fetch(`${base}${path}`, {
        redirect: "manual", signal: AbortSignal.timeout(5000),
        ...(body ? { method: "POST", body: new URLSearchParams(body), headers: { "content-type": "application/x-www-form-urlencoded", ...headers } } : { headers }),
    });
    const protectedResponse = await request("/mcp");
    assert.equal(protectedResponse.status, 401);
    assert.match(protectedResponse.headers.get("www-authenticate"), /resource_metadata/);
    const metadata = await (await request("/.well-known/oauth-authorization-server")).json();
    assert.equal(metadata.issuer, issuer.href);
    const registration = await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: client.redirect_uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
    assert.equal(registration.status, 201);
    const registered = await registration.json();
    const verifier = "v".repeat(48);
    const form = { response_type: "code", client_id: registered.client_id, redirect_uri: client.redirect_uris[0], code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: resource.href, scope: "mcp:tools offline_access", state: "csrf-state" };
    const page = await request(`/authorize?${new URLSearchParams(form)}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal((await request("/authorize", { ...form, password: "incorrect" })).status, 401);
    const approve = async () => {
        const response = await request("/authorize", { ...form, password });
        assert.equal(response.status, 302, await response.text());
        const redirect = new URL(response.headers.get("location"));
        assert.equal(redirect.searchParams.get("state"), form.state);
        return redirect.searchParams.get("code");
    };
    const code = await approve();
    const tokenForm = { grant_type: "authorization_code", client_id: registered.client_id, code, code_verifier: verifier, redirect_uri: form.redirect_uri, resource: resource.href };
    assert.equal((await request("/token", { ...tokenForm, code_verifier: "x".repeat(48) })).status, 400);
    assert.equal((await request("/token", { ...tokenForm, resource: "https://wrong.example/mcp" })).status, 400);
    const issued = await request("/token", tokenForm);
    assert.equal(issued.status, 200, await issued.clone().text());
    const tokens = await issued.json();
    const rpc = token => fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    assert.equal((await rpc(tokens.access_token)).status, 200);
    assert.equal((await request("/token", tokenForm)).status, 400);
    const refreshed = await request("/token", { grant_type: "refresh_token", client_id: registered.client_id, refresh_token: tokens.refresh_token, resource: resource.href });
    assert.equal(refreshed.status, 200);
    const rotated = await refreshed.json();
    assert.equal((await request("/revoke", { client_id: registered.client_id, token: rotated.refresh_token })).status, 200);
    assert.equal((await rpc(rotated.access_token)).status, 401);
    const second = await request("/token", { ...tokenForm, code: await approve() });
    const secondTokens = await second.json();
    await setAdminPassword("a-new-test-only-password-456!");
    assert.equal((await rpc(secondTokens.access_token)).status, 401);
});

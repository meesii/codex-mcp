import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, symlinkSync, statSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { safeHttpGet, safeHttpRequest, assertPublicAddress } from "../dist/lib/http/safe-http.js";
import { assertAllowedPath } from "../dist/lib/fs/path-guard.js";
import { writePrivateFileAtomic } from "../dist/lib/fs/atomic-file.js";
import { verifyTunnelRoute } from "../dist/tunnel/verify.js";
import { ProcessSessionManager } from "../dist/lib/process/sessions.js";

async function listen(t, handler) {
    const server = createServer(handler);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    return `http://127.0.0.1:${server.address().port}`;
}

test("SSRF blocks private, mapped, link-local and reserved addresses", async () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "100.64.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "64:ff9b::7f00:1"]) {
        assert.throws(() => assertPublicAddress(address));
        const host = address.includes(":") ? `[${address}]` : address;
        await assert.rejects(safeHttpGet(`http://${host}/`, { useProxy: false, timeoutMs: 500 }));
    }
    assert.doesNotThrow(() => assertPublicAddress("1.1.1.1"));
    for (const url of ["file:///etc/passwd", "http://user:password@example.com/", "http://2130706433/"]) {
        await assert.rejects(safeHttpGet(url, { useProxy: false, timeoutMs: 500 }));
    }
});

test("socket DNS lookup rejects a rebinding response containing any private address", async t => {
    let lookups = 0;
    t.mock.method(dns, "lookup", async () => { lookups++; return [{ address: "1.1.1.1", family: 4 }, { address: "127.0.0.1", family: 4 }]; });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    await assert.rejects(safeHttpGet("http://rebind.example/", { useProxy: false, timeoutMs: 1000 }), /private|blocked|public/i);
    assert.equal(lookups, 1);
});

test("HTTP enforces redirect, response, request-size and total timeout budgets", async t => {
    const base = await listen(t, (req, res) => {
        if (req.url === "/large") { res.end("x".repeat(4096)); return; }
        if (req.url === "/slow") return;
        if (req.url === "/redirect") { res.writeHead(302, { location: "/redirect" }); res.end(); return; }
        if (req.url === "/unsafe") { res.writeHead(302, { location: "file:///etc/passwd" }); res.end(); return; }
        res.end("ok");
    });
    const options = { allowPrivate: true, useProxy: false, timeoutMs: 300 };
    assert.equal((await safeHttpGet(base, options)).body.toString(), "ok");
    await assert.rejects(safeHttpGet(`${base}/large`, { ...options, maxBytes: 100 }), /exceed|large|limit/i);
    await assert.rejects(safeHttpGet(`${base}/redirect`, { ...options, maxRedirects: 1 }), /redirect/i);
    await assert.rejects(safeHttpGet(`${base}/unsafe`, options), /HTTP|protocol/i);
    await assert.rejects(safeHttpRequest(`${base}/redirect`, { ...options, method: "POST", body: "secret" }), /Non-GET redirects/);
    await assert.rejects(safeHttpRequest(base, { ...options, method: "POST", body: "12345", maxRequestBytes: 4 }), /Request body/);
    const started = Date.now();
    await assert.rejects(safeHttpGet(`${base}/slow`, options), /timeout|timed out/i);
    assert.ok(Date.now() - started < 2000);
    await assert.rejects(safeHttpGet(`${base}/slow`, { ...options, timeoutMs: 5000, signal: AbortSignal.timeout(50) }));
});

test("Tunnel probe verifies exact instance, rejects redirects and honors one deadline/cancellation", async t => {
    const probe = { path: "/.well-known/codex-mcp-tunnel-check/test", expectedBody: "instance-".repeat(8) };
    let mode = "correct";
    const base = await listen(t, (_req, res) => {
        if (mode === "redirect") { res.writeHead(302, { location: probe.path }); res.end(); return; }
        res.end(mode === "correct" ? probe.expectedBody : "a different instance");
    });
    const options = { allowPrivate: true, totalTimeoutMs: 1000, retryDelayMs: 30 };
    await verifyTunnelRoute(`${base}/mcp`, probe, options);
    mode = "wrong";
    const started = Date.now();
    await assert.rejects(verifyTunnelRoute(`${base}/mcp`, probe, options), /不是当前|当前 codex-mcp/);
    assert.ok(Date.now() - started < 2500);
    mode = "redirect";
    await assert.rejects(verifyTunnelRoute(`${base}/mcp`, probe, { ...options, signal: AbortSignal.timeout(60) }));
});

test("path containment rejects traversal, sibling-prefix and symlink escapes, including nonexistent children", () => {
    const base = mkdtempSync(join(tmpdir(), "codex-mcp-path-"));
    const outside = mkdtempSync(`${base}-sibling-`);
    writeFileSync(join(outside, "secret"), "private");
    symlinkSync(outside, join(base, "escape"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => assertAllowedPath(join(base, "..", "unbound"), [base]));
    assert.throws(() => assertAllowedPath(join(outside, "secret"), [base]));
    assert.throws(() => assertAllowedPath(join(base, "escape", "secret"), [base]));
    assert.throws(() => assertAllowedPath(join(base, "escape", "new", "file"), [base]));
    const path = assertAllowedPath(join(base, "valid-new-file"), [base]);
    writePrivateFileAtomic(path, "secret");
    assert.equal(readFileSync(path, "utf8"), "secret");
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("process scopes isolate handles, cap output, and shutdown terminates descendants", async t => {
    const project = mkdtempSync(join(tmpdir(), "codex-mcp-process-"));
    const script = join(project, "tree.cjs");
    const heartbeat = join(project, "heartbeat");
    writeFileSync(script, `const {spawn}=require('node:child_process');\nif(process.argv[2]==='child'){setInterval(()=>require('node:fs').writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),30);}else{spawn(process.execPath,[__filename,'child'],{stdio:'inherit'});process.stdout.write('x'.repeat(2_000_000));setInterval(()=>{},1000);}`);
    const quote = value => `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
    const command = `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} ${quote(script)}`;
    const manager = new ProcessSessionManager();
    t.after(() => manager.shutdown());
    const ownerA = manager.scope("a"), ownerB = manager.scope("b");
    const launched = await ownerA.start({ command, cwd: project, yieldTimeMs: 500, maxOutputChars: 1000 });
    assert.equal(launched.running, true);
    assert.equal(ownerA.peek(launched.processId, 0).output.length, 0);
    assert.ok(launched.output.length <= 1000);
    await assert.rejects(ownerB.poll({ processId: launched.processId, yieldTimeMs: 0 }));
    assert.deepEqual(ownerB.list(), []);
    const deadline = Date.now() + 3000;
    while (!existsSync(heartbeat) && Date.now() < deadline) await delay(20);
    assert.ok(existsSync(heartbeat));
    assert.ok(manager.runtimeStats().bufferedChars <= 1_000_000);
    await manager.shutdown();
    const stopped = readFileSync(heartbeat, "utf8");
    await delay(120);
    assert.equal(readFileSync(heartbeat, "utf8"), stopped);
    assert.equal(manager.runtimeStats().running, 0);
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { OAuthStateStore } from "../src/auth/oauth-state.js";
import { CodexClientsStore } from "../src/auth/provider.js";
import { createHttpServer } from "../src/http-server.js";
import {
    assertPublicAddress,
    isRetryableProxyConnectionError,
    safeHttpGet,
} from "../src/lib/safe-http.js";
import { ProcessOwnerPool } from "../src/lib/process-owner-pool.js";
import { ProcessSessionManager } from "../src/lib/process-sessions.js";
import { RollingTextBuffer } from "../src/lib/rolling-text-buffer.js";
import { RuntimeTelemetry } from "../src/lib/runtime-telemetry.js";
import { commandShell } from "../src/lib/shell-command.js";
import { terminateChildProcess } from "../src/lib/process-tree.js";
import { runRipgrep } from "../src/lib/ripgrep.js";
import { runSubprocess } from "../src/lib/subprocess.js";
import { McpSessionRegistry } from "../src/mcp-sessions.js";
import { runFallbackRegexGrep } from "../src/tools/grep.js";
import { buildUiCard } from "../src/ui/ui-card.js";
import { summarizeToolCall } from "../src/ui/tool-summary.js";
import {
    requireDnsOverwriteConfirmation,
    requireTunnelDeleteConfirmation,
} from "../src/tunnel/confirm.js";
import { runCloudflared } from "../src/tunnel/exec.js";
import {
    cloudflaredRunArgs,
    tunnelReadinessTimeoutMessage,
} from "../src/tunnel/sidecar.js";
import { findTunnelIdInListText } from "../src/tunnel/setup.js";
import { verifyTunnelRoute } from "../src/tunnel/verify.js";
import {
    getCloudflaredConfigPath,
    readCloudflaredYml,
    writeCloudflaredYml,
} from "../src/tunnel/yml.js";
import { connectMcpClient, type McpTestClient } from "./helpers/mcp-client.js";
import { startTestServer } from "./helpers/start-server.js";

async function main(): Promise<void> {
    process.env.CODING_MCP_LOG_TOOLS = "0";

    const shell = commandShell("echo ok");
    if (process.platform === "win32") {
        assert.deepEqual(shell.args, ["-NoProfile", "-Command", "echo ok"]);
    } else {
        assert.equal(shell.file, "/bin/bash");
        assert.deepEqual(shell.args, ["-c", "echo ok"]);
    }

    const rolling = new RollingTextBuffer(10);
    assert.equal(rolling.append("1234"), false);
    assert.equal(rolling.append("567890"), false);
    assert.equal(rolling.toString(), "1234567890");
    assert.equal(rolling.append("ABCD"), true);
    assert.equal(rolling.toString(), "567890ABCD");
    assert.equal(rolling.length, 10);
    assert.equal(rolling.trimTo(4), true);
    assert.equal(rolling.toString(), "ABCD");
    rolling.clear();
    assert.equal(rolling.length, 0);
    assert.equal(rolling.toString(), "");

    const telemetry = new RuntimeTelemetry();
    for (let duration = 1; duration <= 300; duration += 1) {
        telemetry.recordTool("bounded", duration, duration % 10 === 0, 100);
    }
    for (let index = 0; index < 200; index += 1) {
        telemetry.recordDownstream(`server-${index}`, index + 1, false);
    }
    telemetry.recordDownstreamCache(false);
    telemetry.recordDownstreamCache(true);
    telemetry.recordDownstreamReconnect();
    const telemetrySnapshot = telemetry.snapshot({
        running: 0,
        retained: 0,
        bufferedChars: 0,
        starts: 0,
        completions: 0,
        outputTruncations: 0,
    });
    const boundedMetric = telemetrySnapshot.tools.find((metric) => metric.tool === "bounded");
    assert.equal(telemetrySnapshot.sampleWindow, 256);
    assert.equal(boundedMetric?.calls, 300);
    assert.equal(boundedMetric?.errors, 30);
    assert.equal(boundedMetric?.p50Ms, 172);
    assert.equal(boundedMetric?.p95Ms, 288);
    assert.equal(boundedMetric?.responseBytes.total, 30_000);
    assert.ok(telemetrySnapshot.downstream.byServer.length <= 128);
    assert.equal(telemetrySnapshot.downstream.cacheHits, 1);
    assert.equal(telemetrySnapshot.downstream.cacheMisses, 1);
    assert.equal(telemetrySnapshot.downstream.reconnects, 1);

    const projectRoot = await mkdtemp(join(tmpdir(), "codex-mcp-security-project-"));
    const secretCommand = "curl -H 'Authorization: Bearer super-secret-token' https://example.com";
    const commandSummary = summarizeToolCall("bash", { command: secretCommand });
    assert.ok(!JSON.stringify(commandSummary).includes("super-secret-token"));
    const urlCard = buildUiCard(
        "webfetch",
        true,
        { url: "https://example.com/path?access_token=super-secret-token#fragment" },
        { bytes: 1 },
        "ok",
    );
    assert.ok(!JSON.stringify(urlCard).includes("super-secret-token"));
    assert.match(urlCard.title, /^https:\/\/example\.com\/path$/);
    const localConfig = loadConfig({
        projectRoot,
        local: true,
        userConfig: {
            host: "0.0.0.0",
            port: 0,
            domain: "mcp.example.com",
        },
    });
    assert.equal(localConfig.host, "127.0.0.1");
    assert.equal(localConfig.local, true);
    assert.equal(localConfig.oauthRequired, false);
    assert.deepEqual(localConfig.allowedHosts, []);
    assert.equal(localConfig.publicMcpUrl, undefined);

    await assert.rejects(
        safeHttpGet("http://127.0.0.1:1/private", { timeoutMs: 1000 }),
        /Private or reserved network address/,
    );
    await assert.rejects(
        safeHttpGet("http://[::1]:1/private", { timeoutMs: 1000 }),
        /Private or reserved network address/,
    );
    await assert.rejects(
        safeHttpGet("http://10.0.0.1/private", { timeoutMs: 1000 }),
        /Private or reserved network address/,
    );
    assert.doesNotThrow(
        () => assertPublicAddress("172.64.155.209"),
        "public IPv4 addresses must not be misclassified by IPv6 block rules",
    );
    assert.equal(
        isRetryableProxyConnectionError(new Error("Request timed out after 2000ms")),
        true,
        "safe-http's own bounded proxy timeout must advance to the next validated target",
    );
    assert.equal(
        isRetryableProxyConnectionError(new Error("certificate verification failed")),
        false,
        "TLS/authentication failures must remain fail-closed rather than retrying destinations",
    );
    for (const address of [
        "64:ff9b::7f00:1",
        "100::1",
        "2001::1",
        "2002:7f00:1::",
        "fec0::1",
    ]) {
        assert.throws(
            () => assertPublicAddress(address),
            /Private or reserved network address/,
            `special IPv6 address must be blocked: ${address}`,
        );
    }

    const oauthState = await OAuthStateStore.open(join(projectRoot, "issuer-test-state.json"));
    const issuerA = new CodexClientsStore(oauthState, new URL("https://issuer-a.example/"));
    const registered = await issuerA.registerClient({
        redirect_uris: ["http://127.0.0.1:54321/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "issuer-binding-test",
    });
    assert.ok(await issuerA.getClient(registered.client_id));
    const issuerB = new CodexClientsStore(oauthState, new URL("https://issuer-b.example/"));
    assert.equal(await issuerB.getClient(registered.client_id), undefined);
    assert.equal(
        await issuerA.getClient("https://127.0.0.1/client-metadata.json"),
        undefined,
        "CIMD must not fetch loopback metadata",
    );

    const boundedState = await OAuthStateStore.open(join(projectRoot, "bounded-client-state.json"));
    const boundedIssuer = "https://bounded.example/";
    const clientTemplate = {
        redirect_uris: ["http://127.0.0.1:54321/callback"],
        token_endpoint_auth_method: "none" as const,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
    };
    await boundedState.registerClient(
        { ...clientTemplate, client_id: "oldest", client_id_issued_at: 1 },
        boundedIssuer,
        { maxClients: 2, protectRecentMs: 0 },
    );
    await boundedState.registerClient(
        { ...clientTemplate, client_id: "middle", client_id_issued_at: 2 },
        boundedIssuer,
        { maxClients: 2, protectRecentMs: 0 },
    );
    await boundedState.registerClient(
        { ...clientTemplate, client_id: "newest", client_id_issued_at: 3 },
        boundedIssuer,
        { maxClients: 2, protectRecentMs: 0 },
    );
    assert.equal(boundedState.getClient("oldest", boundedIssuer), undefined);
    assert.ok(boundedState.getClient("middle", boundedIssuer));
    assert.ok(boundedState.getClient("newest", boundedIssuer));

    const oversizedServer = createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.write(Buffer.alloc(2048, 1));
        res.end(Buffer.alloc(2048, 2));
    });
    await new Promise<void>((resolve) => oversizedServer.listen(0, "127.0.0.1", resolve));
    const oversizedAddress = oversizedServer.address();
    assert.ok(oversizedAddress && typeof oversizedAddress === "object");
    try {
        await assert.rejects(
            safeHttpGet(`http://127.0.0.1:${oversizedAddress.port}/big`, {
                allowPrivate: true,
                maxBytes: 1024,
                timeoutMs: 2_000,
            }),
            /Response exceeds 1024 bytes/,
        );
    } finally {
        await new Promise<void>((resolve) => oversizedServer.close(() => resolve()));
    }

    const tunnelProbePath = "/.well-known/codex-mcp-tunnel-check/test-probe-token";
    const tunnelProbeBody = "expected-current-instance-response-0123456789";
    const tunnelProbeServer = createServer((req, res) => {
        if (req.url === tunnelProbePath) {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end(tunnelProbeBody);
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise<void>((resolve) => tunnelProbeServer.listen(0, "127.0.0.1", resolve));
    const tunnelProbeAddress = tunnelProbeServer.address();
    assert.ok(tunnelProbeAddress && typeof tunnelProbeAddress === "object");
    try {
        const localPublicUrl = `http://127.0.0.1:${tunnelProbeAddress.port}/mcp`;
        await verifyTunnelRoute(
            localPublicUrl,
            { path: tunnelProbePath, expectedBody: tunnelProbeBody },
            { allowPrivate: true, attempts: 1, retryDelayMs: 0, requestTimeoutMs: 1_000 },
        );
        await assert.rejects(
            verifyTunnelRoute(
                localPublicUrl,
                { path: tunnelProbePath, expectedBody: `${tunnelProbeBody}-wrong` },
                { allowPrivate: true, attempts: 1, retryDelayMs: 0, requestTimeoutMs: 1_000 },
            ),
            /无法通过公网地址访问当前 codex-mcp/,
            "tunnel postcondition must reject a hostname that reaches the wrong instance",
        );
    } finally {
        await new Promise<void>((resolve) => tunnelProbeServer.close(() => resolve()));
    }

    const sessionRegistry = new McpSessionRegistry<{ close: () => Promise<void> }>();
    const ownedTransport = { close: async (): Promise<void> => undefined };
    sessionRegistry.register("owned-session", ownedTransport, "client-a");
    assert.equal(sessionRegistry.get("owned-session", "client-a"), ownedTransport);
    assert.equal(
        sessionRegistry.get("owned-session", "client-b"),
        undefined,
        "MCP sessions must not cross OAuth client boundaries",
    );
    assert.equal(sessionRegistry.get("owned-session"), undefined);
    await sessionRegistry.closeAll();

    const sleepCommand = process.platform === "win32" ? "Start-Sleep -Seconds 60" : "sleep 60";
    const scopedProcesses = new ProcessSessionManager(2);
    const processScopeA = scopedProcesses.scope("mcp-session-a");
    const processScopeB = scopedProcesses.scope("mcp-session-b");
    const scoped = await processScopeA.start({
        command: sleepCommand,
        cwd: projectRoot,
        yieldTimeMs: 0,
    });
    assert.ok(scoped.processId);
    await assert.rejects(
        processScopeB.poll({ processId: scoped.processId! }),
        /Unknown processId/,
    );
    await assert.rejects(processScopeB.kill(scoped.processId!), /Unknown processId/);
    await processScopeA.shutdown();
    await scopedProcesses.shutdown();

    const pooledRoot = new ProcessSessionManager(2);
    const ownerPool = new ProcessOwnerPool(pooledRoot, 25);
    const firstLease = ownerPool.acquire("oauth:client-a");
    const pooled = await firstLease.processes.start({
        command: sleepCommand,
        cwd: projectRoot,
        yieldTimeMs: 0,
    });
    assert.ok(pooled.processId);
    firstLease.release();

    const reconnectLease = ownerPool.acquire("oauth:client-a");
    await new Promise((resolve) => setTimeout(resolve, 40));
    const reconnected = await reconnectLease.processes.poll({
        processId: pooled.processId!,
        yieldTimeMs: 0,
    });
    assert.equal(reconnected.running, true, "same owner must survive transport reconnects");

    const otherOwnerLease = ownerPool.acquire("oauth:client-b");
    await assert.rejects(
        otherOwnerLease.processes.poll({ processId: pooled.processId!, yieldTimeMs: 0 }),
        /Unknown processId/,
    );
    otherOwnerLease.release();
    await reconnectLease.processes.kill(pooled.processId!);

    const orphaned = await reconnectLease.processes.start({
        command: sleepCommand,
        cwd: projectRoot,
        yieldTimeMs: 0,
    });
    assert.ok(orphaned.processId);
    reconnectLease.release();
    let orphanReaped = false;
    for (let attempt = 0; attempt < 400; attempt += 1) {
        try {
            pooledRoot.scope("oauth:client-a").status(orphaned.processId!);
        } catch (error) {
            if (error instanceof Error && /Unknown processId/.test(error.message)) {
                orphanReaped = true;
                break;
            }
            throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(
        orphanReaped,
        true,
        "owner processes must be reaped after the reconnect grace expires",
    );
    await ownerPool.shutdown();

    const processes = new ProcessSessionManager(2);
    const first = await processes.start({ command: sleepCommand, cwd: projectRoot, yieldTimeMs: 0 });
    const second = await processes.start({ command: sleepCommand, cwd: projectRoot, yieldTimeMs: 0 });
    assert.equal(first.running, true);
    assert.equal(second.running, true);
    await assert.rejects(
        processes.start({ command: sleepCommand, cwd: projectRoot, yieldTimeMs: 0 }),
        /Process capacity reached/,
    );
    await processes.shutdown();
    if (first.processId) {
        await assert.rejects(processes.poll({ processId: first.processId }), /Unknown processId/);
    }

    // Completed process history is useful for reconnect recovery, but it must be
    // separately bounded from running capacity. Exercise both the per-owner
    // retained-count and retained-buffer budgets with short 150KB commands.
    const retainedRoot = new ProcessSessionManager(8);
    const retainedScope = retainedRoot.scope("retention-owner");
    const nodeCommand = process.platform === "win32"
        ? `& "${process.execPath}" -e "setTimeout(()=>process.stdout.write('x'.repeat(150000)),50)"`
        : `${JSON.stringify(process.execPath)} -e "setTimeout(()=>process.stdout.write('x'.repeat(150000)),50)"`;
    for (let index = 0; index < 20; index += 1) {
        const started = await retainedScope.start({
            command: nodeCommand,
            cwd: projectRoot,
            yieldTimeMs: 0,
        });
        assert.ok(started.processId, "retention fixture should return a processId before completion");
        let stopped = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
            if (!retainedScope.status(started.processId!).running) {
                stopped = true;
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(stopped, true, "retention fixture process should complete without consuming it");
    }
    const retained = retainedScope.list().filter((item) => !item.running);
    assert.ok(retained.length <= 16, `expected <=16 retained sessions, got ${retained.length}`);
    assert.ok(
        retained.reduce((total, item) => total + item.bufferedChars, 0) <= 2_000_000,
        "retained process buffers must stay within the per-owner budget",
    );
    await retainedRoot.shutdown();

    const ignoreTermScript = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
    const stubborn = spawn(process.execPath, ["-e", ignoreTermScript], {
        stdio: "ignore",
        detached: process.platform !== "win32",
    });
    const terminateStartedAt = Date.now();
    await terminateChildProcess(stubborn, 100, 1_000);
    assert.ok(Date.now() - terminateStartedAt < 3_000, "TERM→KILL helper must be bounded");

    const rgStartedAt = Date.now();
    await assert.rejects(
        runRipgrep(
            process.execPath,
            ["-e", ignoreTermScript],
            projectRoot,
            10_000,
            100,
        ),
        /ripgrep timed out/i,
    );
    assert.ok(Date.now() - rgStartedAt < 4_000, "ripgrep timeout must be bounded");

    const boundedSubprocess = await runSubprocess(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(100000))"],
        {
            maxStdoutBytes: 4_096,
            maxStderrBytes: 1_024,
            maxTotalBytes: 5_120,
            timeoutMs: 5_000,
        },
    );
    assert.equal(boundedSubprocess.truncated, true);
    assert.ok(Buffer.byteLength(boundedSubprocess.stdout, "utf8") <= 4_096);

    const subprocessTimeoutStartedAt = Date.now();
    await assert.rejects(
        runSubprocess(process.execPath, ["-e", ignoreTermScript], { timeoutMs: 100 }),
        /timed out after 100ms/i,
    );
    assert.ok(
        Date.now() - subprocessTimeoutStartedAt < 4_000,
        "shared subprocess timeout must use bounded TERM→KILL shutdown",
    );

    const cloudflaredStartedAt = Date.now();
    await assert.rejects(
        runCloudflared(process.execPath, ["-e", ignoreTermScript], { timeoutMs: 100 }),
        /cloudflared 运行超时/,
    );
    assert.ok(Date.now() - cloudflaredStartedAt < 4_000, "cloudflared timeout must be bounded");

    const regexFixture = join(projectRoot, "regex-redos.txt");
    await writeFile(regexFixture, `${"a".repeat(50_000)}!\n`, "utf8");
    const regexStartedAt = Date.now();
    await assert.rejects(
        runFallbackRegexGrep(projectRoot, regexFixture, "(a+)+$", false, 100),
        /Fallback regex search timed out/i,
    );
    assert.ok(Date.now() - regexStartedAt < 3_000, "fallback regex ReDoS must be isolated");

    await assert.rejects(
        requireTunnelDeleteConfirmation("shared-tunnel", async (_question, defaultValue) => {
            assert.equal(defaultValue, false);
            return false;
        }),
        /已取消。没有删除现有 Tunnel/,
    );
    await requireTunnelDeleteConfirmation("shared-tunnel", async () => true);
    const exactTunnelId = "11111111-1111-4111-8111-111111111111";
    const similarTunnelId = "22222222-2222-4222-8222-222222222222";
    const tunnelListText = `${similarTunnelId} codex-mcp-prod 2026-08-07\n${exactTunnelId} codex-mcp 2026-08-07`;
    assert.equal(findTunnelIdInListText(tunnelListText, "codex-mcp"), exactTunnelId);
    assert.equal(findTunnelIdInListText(tunnelListText, "missing"), undefined);
    await assert.rejects(
        requireDnsOverwriteConfirmation("mcp.example.com", async (_question, defaultValue) => {
            assert.equal(defaultValue, false);
            return false;
        }),
        /已取消。没有修改现有 DNS 记录/,
    );
    await requireDnsOverwriteConfirmation("mcp.example.com", async () => true);

    const windowsInstaller = await readFile("scripts/install.ps1", "utf8");
    assert.match(windowsInstaller, /npm install --global --prefix \$installRoot \$Package/);
    assert.match(windowsInstaller, /\.codex-mcp\\npm/);
    assert.doesNotMatch(
        windowsInstaller,
        /dist\\cli\.js/,
        "distributed installer must not depend on the source checkout",
    );
    const unixInstaller = await readFile("scripts/install.sh", "utf8");
    assert.match(unixInstaller, /npm install --global --prefix "\$INSTALL_ROOT" "\$PACKAGE"/);
    assert.match(unixInstaller, /\.codex-mcp\/npm\/bin/);
    const windowsUninstaller = await readFile("scripts/uninstall.ps1", "utf8");
    assert.match(windowsUninstaller, /\.codex-mcp\\npm/);
    assert.doesNotMatch(windowsUninstaller, /Remove-Item[^\n]*\.codex-mcp["']/);
    const unixUninstaller = await readFile("scripts/uninstall.sh", "utf8");
    assert.match(unixUninstaller, /INSTALL_ROOT="\$\{HOME\}\/\.codex-mcp\/npm"/);
    assert.doesNotMatch(unixUninstaller, /rm -rf "\$\{HOME\}\/\.codex-mcp"/);

    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const emptyHome = await mkdtemp(join(tmpdir(), "codex-mcp-security-home-"));
    process.env.HOME = emptyHome;
    process.env.USERPROFILE = emptyHome;
    await mkdir(join(emptyHome, ".codex-mcp"), { recursive: true });
    try {
        assert.equal(
            getCloudflaredConfigPath(),
            join(emptyHome, ".codex-mcp", "cloudflared.yml"),
        );
        const apostropheConfig = join(emptyHome, ".codex-mcp", "apostrophe-cloudflared.yml");
        const apostropheCredentials = join(emptyHome, "user's tunnel", "credentials.json");
        writeCloudflaredYml(
            {
                tunnelId: "33333333-3333-4333-8333-333333333333",
                credentialsFile: apostropheCredentials,
                hostname: "mcp.example.com",
                serviceUrl: "http://127.0.0.1:3920",
            },
            apostropheConfig,
        );
        const parsedCloudflared = readCloudflaredYml(apostropheConfig);
        assert.equal(parsedCloudflared.credentialsFile, apostropheCredentials);
        assert.match(parsedCloudflared.raw, /^protocol: http2$/m);
        assert.match(parsedCloudflared.raw, /^edge-ip-version: 4$/m);
        assert.deepEqual(
            cloudflaredRunArgs(apostropheConfig, "33333333-3333-4333-8333-333333333333"),
            [
                "tunnel",
                "--config",
                apostropheConfig,
                "--protocol",
                "http2",
                "--edge-ip-version",
                "4",
                "run",
                "33333333-3333-4333-8333-333333333333",
            ],
        );
        const ipv6TunnelTimeout = tunnelReadinessTimeoutMessage(
            45_000,
            "ERR Unable to establish connection with Cloudflare edge error=\"TLS handshake with edge error: read tcp [2409:8a5c::1]:54477->[2606:4700:a0::3]:7844: i/o timeout\"",
            "/tmp/tunnel.log",
        );
        assert.match(ipv6TunnelTimeout, /IPv6 连接超时/);
        assert.match(ipv6TunnelTimeout, /IPv4/);
        assert.match(ipv6TunnelTimeout, /TCP 7844/);

        const oauthRequiredConfig: ServerConfig = {
            host: "127.0.0.1",
            port: 0,
            local: false,
            oauthRequired: true,
            projectRoot,
            allowedHosts: [],
            widgetDomain: "http://127.0.0.1",
        };
        const protectedServer = createHttpServer(oauthRequiredConfig);
        await assert.rejects(
            protectedServer.listen(),
            /还没有设置连接密码/,
        );
        await protectedServer.close().catch(() => undefined);
    } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previousUserProfile;
    }

    const healthCtx = await startTestServer();
    try {
        const healthUrl = new URL("/healthz", healthCtx.mcpUrl);
        const health = await fetch(healthUrl).then((response) => response.json());
        assert.deepEqual(health, { ok: true });
    } finally {
        await healthCtx.server.close();
    }

    // A loopback-bound server behind a public reverse proxy must allow the
    // configured public hostname as an Origin as well as a Host. Without an
    // explicit allowedOrigins list, the MCP Express SDK falls back to its
    // localhost-only Origin middleware because config.host is 127.0.0.1.
    const publicOriginConfig: ServerConfig = {
        host: "127.0.0.1",
        port: 0,
        local: false,
        oauthRequired: false,
        projectRoot,
        allowedHosts: ["mcp.example.com"],
        widgetDomain: "https://codex-mcp.mcp.example.com",
    };
    const publicOriginServer = createHttpServer(publicOriginConfig);
    await publicOriginServer.listen();
    try {
        const healthUrl = new URL("/healthz", publicOriginServer.getMcpUrl());
        const allowedOriginResponse = await fetch(healthUrl, {
            headers: { Origin: "https://mcp.example.com" },
        });
        assert.equal(allowedOriginResponse.status, 200);
        assert.deepEqual(await allowedOriginResponse.json(), { ok: true });

        const rejectedOriginResponse = await fetch(healthUrl, {
            headers: { Origin: "https://attacker.example" },
        });
        assert.equal(rejectedOriginResponse.status, 403);
        const rejectedOriginBody = (await rejectedOriginResponse.json()) as {
            error?: { code?: number; message?: string };
        };
        assert.equal(rejectedOriginBody.error?.code, -32000);
        assert.match(rejectedOriginBody.error?.message ?? "", /Invalid Origin/);
    } finally {
        await publicOriginServer.close();
    }

    // A dangling symlink must not be treated as a safe new-file path. Otherwise
    // writeFile would follow it once the external target is created.
    if (process.platform !== "win32") {
        const symlinkCtx = await startTestServer();
        const mcp = await connectMcpClient(symlinkCtx.mcpUrl);
        const outside = await mkdtemp(join(tmpdir(), "codex-mcp-symlink-outside-"));
        const externalTarget = join(outside, "created-through-link.txt");
        const linkPath = join(symlinkCtx.fixtureRoot, "dangling.txt");
        await symlink(externalTarget, linkPath);
        try {
            const result = await mcp.callTool("write", {
                path: "dangling.txt",
                content: "must-not-escape\n",
            });
            assert.equal(result.isError, true, "dangling symlink write must be rejected");
            await assert.rejects(access(externalTarget));
        } finally {
            await mcp.close().catch(() => undefined);
            await symlinkCtx.server.close().catch(() => undefined);
        }
    }

    // Stateless HTTP serving must not accumulate transport sessions. More than
    // the old 32-session ceiling can initialize independently without a 503.
    const sessionCtx = await startTestServer();
    const clients: McpTestClient[] = [];
    try {
        for (let index = 0; index < 40; index += 1) {
            clients.push(await connectMcpClient(sessionCtx.mcpUrl));
        }
        assert.equal(clients.length, 40);
    } finally {
        await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
        await sessionCtx.server.close().catch(() => undefined);
    }

    console.log("security-regressions.test.ts: ok");
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});

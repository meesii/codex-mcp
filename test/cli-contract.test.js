import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const cli = new URL("dist/cli.js", root);
const packageVersion = JSON.parse(readFileSync(fileURLToPath(new URL("package.json", root)), "utf8")).version;

function run(args, env = mkdtempSync(join(tmpdir(), "codex-mcp-cli-")), cwd = process.cwd(), extraEnv = {}) {
    try {
        return {
            code: 0,
            output: execFileSync(process.execPath, [fileURLToPath(cli), ...args], {
                encoding: "utf8",
                stdio: "pipe",
                cwd,
                timeout: 120_000,
                ...(env ? { env: { ...process.env, HOME: env, USERPROFILE: env, npm_config_cache: join(env, ".npm"), ...extraEnv } } : {}),
            }),
        };
    } catch (error) {
        return { code: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
    }
}

function request(url, options = {}) {
    const parsed = new URL(url);
    return new Promise((resolve, reject) => {
        const req = httpRequest({
            hostname: parsed.hostname,
            port: parsed.port,
            path: `${parsed.pathname}${parsed.search}`,
            method: options.method ?? "GET",
            headers: options.headers ?? {},
        }, (response) => {
            const chunks = [];
            response.setEncoding("utf8");
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                text: chunks.join(""),
            }));
        });
        req.on("error", reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

async function shutdownIsolatedController(home) {
    try {
        const state = JSON.parse(readFileSync(join(home, ".codex-mcp", "controller.json"), "utf8"));
        await fetch(`http://127.0.0.1:${state.port}/api/controller/shutdown`, {
            method: "POST",
            headers: { "x-codex-controller-token": state.controlToken },
        });
    } catch {
        // best-effort cleanup for isolated test homes
    }
}

test("1.0 exposes the explicit start command and rejects removed commands", () => {
    const help = run(["help"]);
    assert.equal(help.code, 0);
    assert.match(help.output, /codex-mcp start/);
    const bare = run([]);
    assert.equal(bare.code, 0);
    assert.match(bare.output, /codex-mcp start/);
    for (const removed of ["tunnel", "exit", "serve"]) {
        const result = run([removed]);
        assert.notEqual(result.code, 0);
        assert.match(result.output, /不认识/);
    }
});

test("1.0 rejects removed flags and keeps -f scoped to logs", () => {
    for (const args of [["start", "--foreground"], ["start", "--all"], ["--foreground"]]) {
        const result = run(args);
        assert.notEqual(result.code, 0);
        assert.match(result.output, /不认识这个选项|不认识这个命令/);
    }
    const invalidFollow = run(["status", "-f"]);
    assert.notEqual(invalidFollow.code, 0);
    assert.match(invalidFollow.output, /只适用于 `logs`/);
    const conflictingMode = run(["start", "--local", "--public"]);
    assert.notEqual(conflictingMode.code, 0);
    assert.match(conflictingMode.output, /不能同时/);
    const projectMode = run(["project", "add", ".", "--local"]);
    assert.notEqual(projectMode.code, 0);
    assert.match(projectMode.output, /不适用于/);
});

test("Web Console keeps Element Plus component-scoped imports and a focused information architecture", () => {
    const mainSource = readFileSync(fileURLToPath(new URL("src/ui/console/main.ts", root)), "utf8");
    const viteSource = readFileSync(fileURLToPath(new URL("vite.console.config.mjs", root)), "utf8");
    const stylesSource = readFileSync(fileURLToPath(new URL("src/ui/console/styles.css", root)), "utf8");
    const connectSource = readFileSync(fileURLToPath(new URL("src/ui/console/views/ConnectView.vue", root)), "utf8");
    const systemSource = readFileSync(fileURLToPath(new URL("src/ui/console/views/MaintenanceView.vue", root)), "utf8");
    const homeSource = readFileSync(fileURLToPath(new URL("src/ui/console/views/HomeView.vue", root)), "utf8");
    const projectsSource = readFileSync(fileURLToPath(new URL("src/ui/console/views/ProjectsView.vue", root)), "utf8");
    assert.doesNotMatch(mainSource, /import\s+ElementPlus\s+from\s+["']element-plus["']/);
    assert.doesNotMatch(mainSource, /element-plus\/dist\/index\.css/);
    assert.doesNotMatch(mainSource, /\.use\(ElementPlus/);
    assert.match(viteSource, /ElementPlusResolver/);
    assert.match(viteSource, /importStyle:\s*["']css["']/);
    assert.match(stylesSource, /\.console-mobile-nav\s*\{[^}]*display:\s*none\s*!important/s);
    assert.match(stylesSource, /\.console-sidebar\s*\{[^}]*width:\s*228px/s);
    assert.match(stylesSource, /\.is-sidebar-collapsed \.console-sidebar\s*\{\s*width:\s*64px/s);
    assert.match(stylesSource, /\.console-topbar\s*\{[^}]*height:\s*64px/s);
    assert.match(stylesSource, /\.console-content\s*\{[^}]*width:\s*100%[^}]*padding:\s*var\(--space-xl\)/s);
    assert.match(stylesSource, /\.page-heading h1\s*\{\s*display:\s*none/s);
    assert.match(connectSource, /1\. 公网地址/);
    assert.match(connectSource, /2\. 连接密码/);
    assert.match(connectSource, /3\. 检查连接/);
    assert.doesNotMatch(connectSource, /工具与技能/);
    assert.match(systemSource, /CapabilitiesPanel/);
    const capabilitySource = readFileSync(fileURLToPath(new URL("src/ui/console/components/CapabilitiesPanel.vue", root)), "utf8");
    assert.doesNotMatch(capabilitySource, /structuredClone\(value\)/);
    assert.match(capabilitySource, /const dirty = ref\(false\)/);
    assert.match(capabilitySource, /放弃修改/);
    const appSource = readFileSync(fileURLToPath(new URL("src/ui/console/App.vue", root)), "utf8");
    assert.match(appSource, /cloudflare\/discover[^\n]*forceLogin:\s*false/);
    assert.match(appSource, /\/api\/console\/snapshot/);
    assert.match(appSource, /LIVE_SYNC_MS\s*=\s*2_000/);
    assert.match(appSource, /visibilitychange/);
    assert.match(appSource, /busyOwners/);
    assert.match(appSource, /sidebarCollapsed/);
    assert.match(appSource, /收起导航/);
    assert.match(projectsSource, /重新启用/);
    assert.match(homeSource, /还有检查项需要处理/);
    assert.doesNotMatch(homeSource, /还有项目要处理/);
    assert.match(systemSource, /实时日志连接暂时中断，正在自动重连/);
    assert.match(systemSource, /logs\/stream\?lines=/);
});

test("Cloudflare tunnel identity canonicalizes equivalent home path spellings and symlink aliases", async () => {
    const { defaultTunnelName } = await import(new URL("dist/tunnel/setup.js", root).href);
    const host = "e2e-host";
    assert.equal(
        defaultTunnelName(host, "/tmp/codex-home"),
        defaultTunnelName(host, "/tmp//codex-home/./"),
    );
    if (process.platform === "win32") return;
    const physical = mkdtempSync(join(tmpdir(), "codex-mcp-tunnel-home-"));
    const alias = `${physical}-alias`;
    symlinkSync(physical, alias, "dir");
    assert.equal(defaultTunnelName(host, physical), defaultTunnelName(host, alias));
});

test("PowerShell installer is UTF-8 without BOM for irm pipe execution", () => {
    const bytes = readFileSync(fileURLToPath(new URL("scripts/install.ps1", root)));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.ok(bytes.toString("utf8").startsWith("$ErrorActionPreference"));
});

test("ripgrep lookup revalidates same-process repairs and later binary removal", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-mcp-rg-cache-"));
    const script = `
        process.env.HOME = ${JSON.stringify(home)};
        process.env.USERPROFILE = ${JSON.stringify(home)};
        process.env.PATH = "";
        const fs = await import("node:fs");
        const path = await import("node:path");
        const { findRipgrep } = await import(${JSON.stringify(new URL("dist/lib/search/ripgrep.js", root).href)});
        const { getManagedToolPath } = await import(${JSON.stringify(new URL("dist/managed-tools/paths.js", root).href)});
        if (await findRipgrep() !== null) process.exit(2);
        const target = getManagedToolPath("ripgrep");
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(process.execPath, target);
        if (process.platform !== "win32") fs.chmodSync(target, 0o755);
        if (await findRipgrep() !== target) process.exit(3);
        fs.unlinkSync(target);
        if (await findRipgrep() !== null) process.exit(4);
        fs.copyFileSync(process.execPath, target);
        if (process.platform !== "win32") fs.chmodSync(target, 0o755);
        if (await findRipgrep() !== target) process.exit(5);
    `;
    execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" });
});

test("Controller lifecycle requests use Runtime deadlines instead of the probe timeout", async t => {
    const { LocalControllerClient } = await import(new URL("dist/control/control.js", root).href);
    const server = createServer((req, res) => {
        const reply = () => {
            res.setHeader("content-type", "application/json");
            if (req.url === "/api/runtime/stop") {
                res.end(JSON.stringify({ ok: true, stopped: true, status: { running: false, projects: [] } }));
                return;
            }
            res.end(JSON.stringify({ ok: true, status: { running: true, projects: [] } }));
        };
        setTimeout(reply, 60);
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const client = new LocalControllerClient({ host: "127.0.0.1", port: address.port, controlToken: "test" }, 10);
    assert.equal((await client.start({ local: true, noTunnel: true, tunnelLogs: false })).ok, true);
    assert.equal((await client.stop()).stopped, true);
    assert.equal((await client.restart()).ok, true);
});

test("read-only commands work from a clean home", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-mcp-cli-"));
    const version = run(["version"], home);
    assert.equal(version.code, 0);
    assert.equal(version.output.trim(), packageVersion);

    const status = run(["status", "--json"], home);
    assert.equal(status.code, 0);
    const parsed = JSON.parse(status.output);
    assert.equal(parsed.running, false);
    assert.deepEqual(parsed.projects, []);

    const projects = run(["project", "list"], home);
    assert.equal(projects.code, 0);
    assert.match(projects.output, /还没有注册项目/);
});

test("project add changes durable project state without starting Controller or Runtime", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-mcp-project-only-"));
    const project = mkdtempSync(join(tmpdir(), "codex-mcp-project-only-root-"));
    const result = run(["project", "add", project], home, project);
    assert.equal(result.code, 0, result.output);
    const configDir = join(home, ".codex-mcp");
    assert.equal(existsSync(join(configDir, "controller.json")), false);
    assert.equal(existsSync(join(configDir, "daemon.json")), false);
    const projects = JSON.parse(readFileSync(join(configDir, "projects.json"), "utf8"));
    assert.equal(projects.projects.length, 1);
    assert.equal(projects.projects[0].path, realpathSync(project));
});

test("plain start defaults to local mode, persists the actual intent, and reuses it", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-mcp-start-intent-"));
    const project = mkdtempSync(join(tmpdir(), "codex-mcp-start-intent-root-"));
    const configDir = join(home, ".codex-mcp");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({
        port: 0,
        capabilities: { sources: { codex: { enabled: false }, agents: { enabled: false }, claude: { enabled: false } } },
    }));
    try {
        const first = run(["start"], home, project);
        assert.equal(first.code, 0, first.output);
        let status = JSON.parse(run(["status", "--json"], home, project).output);
        assert.equal(status.daemon.mode, "local");
        const saved = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
        assert.deepEqual(saved.runtime, { mode: "local", noTunnel: true, tunnelLogs: false });

        assert.equal(run(["stop"], home, project).code, 0);
        const second = run(["start"], home, project);
        assert.equal(second.code, 0, second.output);
        status = JSON.parse(run(["status", "--json"], home, project).output);
        assert.equal(status.daemon.mode, "local");
        assert.equal(run(["stop"], home, project).code, 0);
    } finally {
        await shutdownIsolatedController(home);
    }
});

test("explicit public start persists the requested mode even when prerequisites are missing", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-mcp-public-intent-"));
    const project = mkdtempSync(join(tmpdir(), "codex-mcp-public-intent-root-"));
    const configDir = join(home, ".codex-mcp");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ port: 0 }));
    try {
        const result = run(["start", "--public"], home, project);
        assert.notEqual(result.code, 0, result.output);
        assert.match(result.output, /Web Console|连接.*页面/);
        const saved = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
        assert.deepEqual(saved.runtime, { mode: "public", noTunnel: false, tunnelLogs: false });
        const status = JSON.parse(run(["status", "--json"], home, project).output);
        assert.equal(status.preferredRuntimeIntent.local, false);
    } finally {
        await shutdownIsolatedController(home);
    }
});

test("open starts only the local control plane and exposes the Web Console", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-mcp-open-"));
    try {
        const result = run(["open"], home, home, { CODEX_MCP_NO_BROWSER: "1" });
        assert.equal(result.code, 0, result.output);
        const controller = JSON.parse(readFileSync(join(home, ".codex-mcp", "controller.json"), "utf8"));
        assert.equal(existsSync(join(home, ".codex-mcp", "daemon.json")), false);
        const panelUrl = `http://127.0.0.1:${controller.port}/`;
        assert.ok(result.output.includes(panelUrl), result.output);
        const panel = await fetch(panelUrl);
        assert.equal(panel.status, 200);
        assert.match(await panel.text(), /codex-mcp 本机工作区/);
        const cliProject = mkdtempSync(join(tmpdir(), "codex-mcp-open-cli-project-"));
        const webProject = mkdtempSync(join(tmpdir(), "codex-mcp-open-web-project-"));
        const snapshotHeaders = { "x-codex-controller-token": controller.controlToken };
        const initialSnapshot = await fetch(new URL("/api/console/snapshot", panelUrl), { headers: snapshotHeaders });
        assert.equal(initialSnapshot.status, 200, await initialSnapshot.clone().text());
        assert.deepEqual((await initialSnapshot.json()).status.runtime.projects, []);

        const cliAdd = run(["project", "add", cliProject], home, cliProject);
        assert.equal(cliAdd.code, 0, cliAdd.output);
        const afterCliAdd = await fetch(new URL("/api/console/snapshot", panelUrl), { headers: snapshotHeaders });
        const afterCliAddJson = await afterCliAdd.json();
        assert.equal(afterCliAddJson.status.runtime.projects.length, 1, "Web snapshot must observe CLI project changes without restarting Controller");
        assert.equal(afterCliAddJson.status.runtime.projects[0].path, realpathSync(cliProject));

        const generatedPassword = await fetch(new URL("/api/auth/generate", panelUrl), {
            method: "POST",
            headers: { ...snapshotHeaders, "content-type": "application/json" },
            body: "{}",
        });
        assert.equal(generatedPassword.status, 200, await generatedPassword.clone().text());
        const afterPassword = await fetch(new URL("/api/console/snapshot", panelUrl), { headers: snapshotHeaders });
        assert.equal((await afterPassword.json()).setup.passwordConfigured, true, "Web snapshot must observe password changes");

        const webAdd = await fetch(new URL("/api/projects", panelUrl), {
            method: "POST",
            headers: { "x-codex-controller-token": controller.controlToken, "content-type": "application/json" },
            body: JSON.stringify({ path: webProject }),
        });
        assert.equal(webAdd.status, 200, await webAdd.clone().text());
        assert.equal(existsSync(join(home, ".codex-mcp", "daemon.json")), false, "adding a project from Web must not start Runtime");
        const shutdown = run(["shutdown"], home, home);
        assert.equal(shutdown.code, 0, shutdown.output);
        assert.equal(existsSync(join(home, ".codex-mcp", "controller.json")), false);
    } finally {
        await shutdownIsolatedController(home);
    }
});

test("start registers the project before Runtime validation and leaves Web recovery available", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-mcp-start-recovery-"));
    const project = mkdtempSync(join(tmpdir(), "codex-mcp-start-recovery-root-"));
    const configDir = join(home, ".codex-mcp");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({
        port: 0,
        runtime: { mode: "public", noTunnel: false, tunnelLogs: false },
        capabilities: { sources: { codex: { enabled: false }, agents: { enabled: false }, claude: { enabled: false } } },
    }));
    try {
        const result = run(["start"], home, project);
        assert.notEqual(result.code, 0);
        assert.match(result.output, /还没有配置公网连接/);
        assert.match(result.output, /Web Console/);
        const projects = JSON.parse(readFileSync(join(configDir, "projects.json"), "utf8"));
        assert.equal(projects.projects.length, 1);
        assert.equal(projects.projects[0].path, realpathSync(project));
        assert.equal(existsSync(join(configDir, "controller.json")), true);
        assert.equal(existsSync(join(configDir, "daemon.json")), false);
    } finally {
        await shutdownIsolatedController(home);
    }
});

test("corrupt durable state fails closed", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-mcp-state-"));
    const dir = join(home, ".codex-mcp");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects: [] }));
    const result = run(["project", "list"], home);
    assert.notEqual(result.code, 0);
    assert.match(result.output, /无法读取有效的项目状态/);
});

test("invalid records are not silently discarded", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-mcp-record-"));
    const dir = join(home, ".codex-mcp");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "projects.json"), JSON.stringify({ schemaVersion: 1, projects: [{ id: "broken" }] }));
    const result = run(["project", "list"], home);
    assert.notEqual(result.code, 0);
    assert.match(result.output, /无法读取有效的项目状态/);
});

test("project identity is collision-resistant and durable state rejects duplicate routing keys", async () => {
    const { deriveProjectId } = await import(new URL("dist/projects/identity.js", root).href);
    const suffix = deriveProjectId("same-name", "/tmp/project-a").split("-").at(-1);
    assert.match(suffix, /^[0-9a-f]{16}$/);

    const home = mkdtempSync(join(tmpdir(), "codex-mcp-duplicates-"));
    const dir = join(home, ".codex-mcp");
    mkdirSync(dir, { recursive: true });
    const common = {
        name: "project",
        active: true,
        addedAt: "2026-09-09T00:00:00.000Z",
        lastSeenAt: "2026-09-09T00:00:00.000Z",
    };
    writeFileSync(join(dir, "projects.json"), JSON.stringify({
        schemaVersion: 1,
        projects: [
            { ...common, id: "duplicate-id", path: "/tmp/project-a" },
            { ...common, id: "duplicate-id", path: "/tmp/project-b" },
        ],
    }));
    const projects = run(["project", "list"], home);
    assert.notEqual(projects.code, 0);
    assert.match(projects.output, /duplicate id/);

    writeFileSync(join(dir, "projects.json"), JSON.stringify({ schemaVersion: 1, projects: [] }));
    writeFileSync(join(dir, "session-bindings.json"), JSON.stringify({
        schemaVersion: 1,
        bindings: [
            { ownerKey: "owner", projectId: "one", boundAt: common.addedAt, lastSeenAt: common.lastSeenAt },
            { ownerKey: "owner", projectId: "two", boundAt: common.addedAt, lastSeenAt: common.lastSeenAt },
        ],
    }));
    const bindingsScript = `process.env.HOME=${JSON.stringify(home)}; process.env.USERPROFILE=${JSON.stringify(home)}; const { loadBindingsFile } = await import(${JSON.stringify(new URL("dist/daemon/state.js", root).href)}); try { loadBindingsFile(); process.exit(2); } catch (error) { if (!String(error?.message).includes("duplicate owner")) process.exit(3); }`;
    execFileSync(process.execPath, ["--input-type=module", "-e", bindingsScript], { stdio: "pipe" });
});

test("1.0 rejects legacy config keys instead of silently migrating them", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-mcp-1-0-"));
    mkdirSync(join(home, ".codex-mcp"), { recursive: true });
    writeFileSync(join(home, ".codex-mcp", "config.json"), JSON.stringify({ domain: "legacy.example.com" }));
    const script = `process.env.HOME=${JSON.stringify(home)}; process.env.USERPROFILE=${JSON.stringify(home)}; const { loadUserConfig } = await import(${JSON.stringify(new URL("dist/config/user-config.js", root).href)}); try { loadUserConfig(); process.exit(2); } catch (error) { if (!String(error?.message).includes("不支持的字段")) process.exit(3); }`;
    execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" });
});

test("1.0 rejects incomplete Cloudflare config and old OAuth state", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-mcp-schema-"));
    const dir = join(home, ".codex-mcp");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({
        publicAccess: {
            kind: "cloudflare",
            domain: "mcp.example.com",
            cloudflaredBin: "/bin/cloudflared",
            tunnelName: "mcp",
            tunnelId: "00000000-0000-0000-0000-000000000000",
        },
    }));
    const configScript = `process.env.HOME=${JSON.stringify(home)}; process.env.USERPROFILE=${JSON.stringify(home)}; const { loadUserConfig } = await import(${JSON.stringify(new URL("dist/config/user-config.js", root).href)}); try { loadUserConfig(); process.exit(2); } catch (error) { if (!String(error?.message).includes("configRevision")) process.exit(3); }`;
    execFileSync(process.execPath, ["--input-type=module", "-e", configScript], { stdio: "pipe" });

    writeFileSync(join(dir, "oauth-state.json"), JSON.stringify({
        version: 1,
        clients: {},
        authorizationCodes: {},
        accessTokens: {},
        refreshTokens: {},
        revokedFamilies: {},
    }));
    const { OAuthStateStore } = await import(new URL("dist/auth/oauth-state.js", root).href);
    await assert.rejects(() => OAuthStateStore.open(join(dir, "oauth-state.json")), /Unsupported OAuth state version/);

    writeFileSync(join(dir, "oauth-state.json"), JSON.stringify({
        version: 2,
        clients: {},
        clientIssuers: {},
        authorizationCodes: {},
        accessTokens: { broken: { clientId: "client" } },
        refreshTokens: {},
        revokedFamilies: {},
    }));
    await assert.rejects(() => OAuthStateStore.open(join(dir, "oauth-state.json")), /Unsupported OAuth state version/);
});

test("persistent local Controller exposes writable Web Console and survives Runtime stop", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-mcp-controller-"));
    const project = mkdtempSync(join(tmpdir(), "codex-mcp-project-a-"));
    const secondProject = mkdtempSync(join(tmpdir(), "codex-mcp-project-b-"));
    const configDir = join(home, ".codex-mcp");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({
        port: 0,
        capabilities: { sources: { codex: { enabled: false }, agents: { enabled: false }, claude: { enabled: false } } },
    }));
    let runtimeStarted = false;
    try {
        const start = run(["start", "--local"], home, project);
        assert.equal(start.code, 0, start.output);
        runtimeStarted = true;

        const initialStatus = JSON.parse(run(["status", "--json"], home, project).output);
        assert.equal(initialStatus.running, true);
        assert.equal(initialStatus.daemon.mode, "local");
        assert.equal(initialStatus.daemon.controlApiVersion, 1);
        assert.equal(initialStatus.daemon.panelUrl, undefined);
        assert.equal(initialStatus.daemon.tunnel.state, "off");
        assert.equal(initialStatus.projects.length, 1);
        assert.match(initialStatus.controller.panelUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);

        const daemonState = JSON.parse(readFileSync(join(configDir, "daemon.json"), "utf8"));
        const controllerState = JSON.parse(readFileSync(join(configDir, "controller.json"), "utf8"));
        const panelUrl = initialStatus.controller.panelUrl;
        const panel = await fetch(panelUrl);
        const panelHtml = await panel.text();
        assert.equal(panel.status, 200);
        assert.match(panelHtml, /codex-mcp 本机工作区/);
        assert.match(panelHtml, /data-csrf-token="[A-Za-z0-9_-]+"/);
        assert.match(panelHtml, /src="\/console\/app\.js"/);
        assert.match(panelHtml, /href="\/console\/app\.css"/);
        assert.equal(panel.headers.get("cache-control"), "no-store");
        assert.equal(panel.headers.get("x-content-type-options"), "nosniff");
        assert.equal(panel.headers.get("referrer-policy"), "no-referrer");
        const csp = panel.headers.get("content-security-policy") ?? "";
        assert.match(csp, /script-src 'self' 'nonce-[^']+'/);
        assert.doesNotMatch(csp.match(/script-src[^;]*/)?.[0] ?? "", /unsafe-inline/);
        assert.match(csp, /style-src-attr 'unsafe-inline'/);
        assert.doesNotMatch(panelHtml, new RegExp(daemonState.controlToken));
        assert.doesNotMatch(panelHtml, new RegExp(controllerState.controlToken));
        const csrf = panelHtml.match(/data-csrf-token="([A-Za-z0-9_-]+)"/)?.[1];
        assert.ok(csrf);
        const scriptAsset = await fetch(new URL("/console/app.js", panelUrl));
        const styleAsset = await fetch(new URL("/console/app.css", panelUrl));
        assert.equal(scriptAsset.status, 200);
        assert.equal(styleAsset.status, 200);
        assert.match(scriptAsset.headers.get("content-type") ?? "", /javascript/);
        assert.match(styleAsset.headers.get("content-type") ?? "", /text\/css/);
        const setCookie = panel.headers.get("set-cookie") ?? "";
        assert.match(setCookie, /codex_console=[A-Za-z0-9_-]+/);
        const panelCookie = setCookie.split(";", 1)[0];
        const origin = new URL(panelUrl).origin;
        const browserHeaders = { cookie: panelCookie, origin, "x-csrf-token": csrf, "content-type": "application/json" };

        for (const path of ["/api/project-folder", "/api/connection-check"]) {
            assert.equal((await fetch(new URL(path, panelUrl), { method: "POST", headers: { cookie: panelCookie, "content-type": "application/json" }, body: "{}" })).status, 403);
        }
        const toolCheck = await fetch(new URL("/api/connection-check", panelUrl), { method: "POST", headers: browserHeaders, body: "{}" });
        assert.equal(toolCheck.status, 200);
        const checked = await toolCheck.json();
        assert.equal(checked.ready, false, "a local-only service must not claim ChatGPT readiness");
        assert.equal(checked.checks.find((item) => item.id === "tools")?.state, "passed", JSON.stringify(checked));
        const conversations = await fetch(new URL("/api/project-conversations", panelUrl), { headers: { cookie: panelCookie } });
        assert.deepEqual((await conversations.json()).conversations, [], "read-only check must not create a project binding");
        const invalidProject = await fetch(new URL("/api/projects", panelUrl), { method: "POST", headers: browserHeaders, body: JSON.stringify({ path: join(project, "missing") }) });
        assert.equal(invalidProject.status, 400);

        const statusUrl = new URL("/api/controller/status", panelUrl);
        assert.equal((await fetch(statusUrl)).status, 401);
        const browserStatus = await fetch(statusUrl, { headers: { cookie: panelCookie } });
        assert.equal(browserStatus.status, 200);
        const browserStatusJson = await browserStatus.json();
        assert.equal(browserStatusJson.runtime.running, true);
        assert.equal(browserStatusJson.pid, controllerState.pid);

        const missingCsrf = await fetch(new URL("/api/projects", panelUrl), {
            method: "POST",
            headers: { cookie: panelCookie, origin, "content-type": "application/json" },
            body: JSON.stringify({ path: secondProject, local: true, intentSpecified: true }),
        });
        assert.equal(missingCsrf.status, 403);
        const hostileHost = await request(panelUrl, { headers: { Host: "evil.example" } });
        assert.equal(hostileHost.status, 403);

        const webAdd = await fetch(new URL("/api/projects", panelUrl), {
            method: "POST",
            headers: browserHeaders,
            body: JSON.stringify({ path: secondProject, local: true, noTunnel: false, tunnelLogs: false, intentSpecified: true }),
        });
        const webAddText = await webAdd.text();
        assert.equal(webAdd.status, 200, webAddText);
        const webAddedProject = JSON.parse(webAddText).project;
        assert.ok(webAddedProject?.id);
        const listed = run(["project", "list"], home, project);
        assert.equal(listed.code, 0, listed.output);
        assert.match(listed.output, /2 个项目/);
        const info = run(["project", "info", secondProject], home, project);
        assert.equal(info.code, 0, info.output);
        assert.match(info.output, /项目详情/);

        const stopResponse = await fetch(new URL("/api/runtime/stop", panelUrl), {
            method: "POST",
            headers: browserHeaders,
            body: "{}",
        });
        assert.equal(stopResponse.status, 200, await stopResponse.text());
        runtimeStarted = false;
        assert.equal(existsSync(join(configDir, "daemon.json")), false);
        const stoppedStatus = await fetch(statusUrl, { headers: { cookie: panelCookie } });
        assert.equal(stoppedStatus.status, 200);
        assert.equal((await stoppedStatus.json()).runtime.running, false);
        assert.equal(JSON.parse(readFileSync(join(configDir, "controller.json"), "utf8")).pid, controllerState.pid);

        const primaryProject = initialStatus.projects[0];
        const now = "2026-09-15T00:00:00.000Z";
        writeFileSync(join(configDir, "session-bindings.json"), JSON.stringify({
            schemaVersion: 1,
            bindings: [{
                ownerKey: "oauth:web-test|openai-session:cleanup-me",
                projectId: primaryProject.id,
                boundAt: now,
                lastSeenAt: now,
            }],
        }));
        const conversationResponse = await fetch(new URL("/api/project-conversations", panelUrl), { headers: { cookie: panelCookie } });
        const conversationPayload = await conversationResponse.json();
        assert.equal(conversationPayload.conversations.length, 1);
        assert.doesNotMatch(JSON.stringify(conversationPayload), /cleanup-me|ownerKey/);
        const cleanupResponse = await fetch(new URL(`/api/projects/${encodeURIComponent(primaryProject.id)}/conversations/cleanup`, panelUrl), {
            method: "POST",
            headers: browserHeaders,
            body: JSON.stringify({ conversationIds: [conversationPayload.conversations[0].id] }),
        });
        assert.equal(cleanupResponse.status, 200, await cleanupResponse.clone().text());
        const cleanupPayload = await cleanupResponse.json();
        assert.equal(cleanupPayload.removed, 1);
        assert.deepEqual(cleanupPayload.conversations, []);
        assert.deepEqual(JSON.parse(readFileSync(join(configDir, "session-bindings.json"), "utf8")).bindings, []);

        const restartFromWeb = await fetch(new URL("/api/runtime/start", panelUrl), {
            method: "POST",
            headers: browserHeaders,
            body: JSON.stringify({ local: true, noTunnel: false, tunnelLogs: false, intentSpecified: true, projectPath: project }),
        });
        assert.equal(restartFromWeb.status, 200, await restartFromWeb.text());
        runtimeStarted = true;
        const afterWebStart = JSON.parse(run(["status", "--json"], home, project).output);
        assert.equal(afterWebStart.running, true);
        assert.equal(afterWebStart.controller.pid, controllerState.pid);

        const removeResponse = await fetch(new URL(`/api/projects/${encodeURIComponent(webAddedProject.id)}`, panelUrl), {
            method: "DELETE",
            headers: browserHeaders,
            body: "{}",
        });
        assert.equal(removeResponse.status, 200, await removeResponse.text());
        const afterRemove = JSON.parse(run(["status", "--json"], home, project).output);
        assert.equal(afterRemove.projects.length, 2);
        assert.equal(afterRemove.projects.filter((item) => item.active).length, 1);

        const reactivateResponse = await fetch(new URL("/api/projects", panelUrl), {
            method: "POST",
            headers: browserHeaders,
            body: JSON.stringify({ path: secondProject }),
        });
        assert.equal(reactivateResponse.status, 200, await reactivateResponse.clone().text());
        const afterReactivate = await fetch(new URL("/api/console/snapshot", panelUrl), { headers: { cookie: panelCookie } });
        const afterReactivateJson = await afterReactivate.json();
        assert.equal(afterReactivateJson.status.runtime.projects.find((item) => item.id === webAddedProject.id)?.active, true);

        const logs = await fetch(new URL("/api/logs?lines=20", panelUrl), { headers: { cookie: panelCookie } });
        assert.equal(logs.status, 200);
        assert.match((await logs.json()).text, /daemon_started/);

        const browserShutdown = await fetch(new URL("/api/controller/shutdown", panelUrl), {
            method: "POST",
            headers: browserHeaders,
            body: "{}",
        });
        assert.equal(browserShutdown.status, 200, await browserShutdown.clone().text());
        runtimeStarted = false;
        for (let attempt = 0; attempt < 100 && existsSync(join(configDir, "controller.json")); attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(existsSync(join(configDir, "controller.json")), false, "browser shutdown should stop the Controller");
    } finally {
        if (runtimeStarted) run(["stop"], home, project);
        try {
            const state = JSON.parse(readFileSync(join(configDir, "controller.json"), "utf8"));
            await fetch(`http://127.0.0.1:${state.port}/api/controller/shutdown`, {
                method: "POST",
                headers: { "x-codex-controller-token": state.controlToken },
            });
        } catch {
            // best-effort isolated Controller cleanup
        }
    }
});

test("daemon control protocol is versioned and tolerates additive same-version fields", async () => {
    const { normalizeDaemonStatusPayload } = await import(new URL("dist/daemon/control.js", root).href);
    const payload = {
        controlApiVersion: 1,
        ok: true,
        version: "1.0.0",
        mode: "local",
        pid: 123,
        startedAt: "2026-09-09T00:00:00.000Z",
        uptimeMs: 100,
        localUrl: "http://127.0.0.1:3920/mcp",
        auth: { required: false, configured: false, futureField: true },
        runtimeIntent: { local: true, noTunnel: false, tunnelLogs: false, futureField: true },
        tunnel: { running: false, state: "off", futureField: true },
        projects: [{
            id: "project-1",
            name: "project",
            path: "/tmp/project",
            active: true,
            addedAt: "2026-09-09T00:00:00.000Z",
            lastSeenAt: "2026-09-09T00:00:00.000Z",
            boundSessions: 0,
            futureField: true,
        }],
        futureTopLevelField: true,
    };
    assert.equal(normalizeDaemonStatusPayload(payload).pid, 123);
    assert.throws(
        () => normalizeDaemonStatusPayload({ ...payload, controlApiVersion: 2 }),
        /控制协议版本不兼容/,
    );
});

test("state stores publish changes only after persistence succeeds", async () => {
    const { ProjectRegistry } = await import(new URL("dist/projects/registry.js", root).href);
    const { BindingStore } = await import(new URL("dist/projects/bindings.js", root).href);
    const projectRoot = mkdtempSync(join(tmpdir(), "codex-mcp-project-"));

    const registry = new ProjectRegistry({
        projects: [],
        save: async () => { throw new Error("disk full"); },
    });
    await assert.rejects(() => registry.register({ path: projectRoot, name: "broken" }), /disk full/);
    assert.deepEqual(registry.list(), []);

    const stale = {
        ownerKey: "local:test",
        projectId: "project-1",
        boundAt: "2020-01-01T00:00:00.000Z",
        lastSeenAt: "2020-01-01T00:00:00.000Z",
    };
    const bindings = new BindingStore({
        bindings: [stale],
        save: async () => { throw new Error("disk full"); },
    });
    await assert.rejects(() => bindings.pruneStale(1, Date.parse("2021-01-01T00:00:00.000Z")), /disk full/);
    assert.deepEqual(bindings.list(), [stale]);
    await assert.rejects(() => bindings.removeFromProject("project-1", [stale.ownerKey]), /disk full/);
    assert.deepEqual(bindings.list(), [stale]);
});

test("binding touch persists at most once per coarse activity interval", async () => {
    const { BindingStore } = await import(new URL("dist/projects/bindings.js", root).href);
    const base = Date.parse("2026-09-09T00:00:00.000Z");
    const binding = {
        ownerKey: "oauth:client|openai-session:one",
        projectId: "project-1",
        boundAt: new Date(base).toISOString(),
        lastSeenAt: new Date(base).toISOString(),
    };
    const snapshots = [];
    const bindings = new BindingStore({
        bindings: [binding],
        save: async (items) => { snapshots.push(items.map((item) => ({ ...item }))); },
    });
    await bindings.touch(binding.ownerKey, base + 5 * 60 * 1_000);
    assert.equal(snapshots.length, 0);
    await bindings.touch(binding.ownerKey, base + 11 * 60 * 1_000);
    assert.equal(snapshots.length, 1);
    assert.equal(bindings.resolve(binding.ownerKey).lastSeenAt, new Date(base + 11 * 60 * 1_000).toISOString());
    await bindings.touch(binding.ownerKey, base + 15 * 60 * 1_000);
    assert.equal(snapshots.length, 1);
});

test("offline project removal clears durable conversation bindings", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-mcp-offline-remove-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "codex-mcp-offline-project-"));
    const dir = join(home, ".codex-mcp");
    mkdirSync(dir, { recursive: true });
    const project = {
        id: "offline-project",
        name: "offline-project",
        path: projectRoot,
        active: true,
        addedAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
    };
    writeFileSync(join(dir, "projects.json"), JSON.stringify({ schemaVersion: 1, projects: [project] }));
    writeFileSync(join(dir, "session-bindings.json"), JSON.stringify({
        schemaVersion: 1,
        bindings: [{
            ownerKey: "oauth:client|mcp-session:one",
            projectId: project.id,
            boundAt: project.addedAt,
            lastSeenAt: project.lastSeenAt,
        }],
    }));

    const result = run(["project", "remove", project.id], home, projectRoot);
    assert.equal(result.code, 0, result.output);
    const projects = JSON.parse(readFileSync(join(dir, "projects.json"), "utf8"));
    assert.equal(projects.projects[0].active, false);
    const bindings = JSON.parse(readFileSync(join(dir, "session-bindings.json"), "utf8"));
    assert.deepEqual(bindings.bindings, []);
});


test("interactive commands fail clearly without a terminal; internal daemon entry is private", () => {
    for (const command of ["setup", "auth"]) {
        const result = run([command]);
        assert.notEqual(result.code, 0, result.output);
        assert.match(result.output, /终端/);
    }
    const bindings = run(["bindings", "clean"]);
    assert.notEqual(bindings.code, 0);
    assert.match(bindings.output, /终端/);
    const daemon = run(["daemon", "--local"]);
    assert.notEqual(daemon.code, 0);
    assert.match(daemon.output, /内部入口/);
    const controller = run(["controller"]);
    assert.notEqual(controller.code, 0);
    assert.match(controller.output, /内部入口/);
    assert.notEqual(run(["project", "list", "unexpected"]).code, 0);
    const doctor = run(["doctor"]);
    assert.equal(doctor.code, 0, doctor.output);
    assert.match(doctor.output, /可以正常使用|安装和配置看起来都正常/);
    const stopped = run(["stop"]);
    assert.equal(stopped.code, 0, stopped.output);
    assert.notEqual(run(["restart"]).code, 0);
});


test("update reports local installer failure and preserves existing configuration", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-mcp-update-"));
    mkdirSync(join(home, ".codex-mcp"), { recursive: true });
    const config = join(home, ".codex-mcp", "config.json");
    const original = JSON.stringify({ port: 4321 });
    writeFileSync(config, original);
    const result = run(["update"], home, home, { CODEX_MCP_PACKAGE: join(home, "missing-release.tgz"), npm_config_offline: "true" });
    assert.notEqual(result.code, 0);
    assert.match(result.output, /更新没有完成/);
    assert.equal(readFileSync(config, "utf8"), original);
});

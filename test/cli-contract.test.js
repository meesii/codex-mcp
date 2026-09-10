import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
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
        assert.match(panelHtml, /codex-mcp 本机控制台/);
        assert.equal(panel.headers.get("cache-control"), "no-store");
        assert.equal(panel.headers.get("x-content-type-options"), "nosniff");
        assert.equal(panel.headers.get("referrer-policy"), "no-referrer");
        assert.match(panel.headers.get("content-security-policy") ?? "", /script-src 'nonce-[^']+'/);
        assert.doesNotMatch(panel.headers.get("content-security-policy") ?? "", /unsafe-inline/);
        assert.doesNotMatch(panelHtml, new RegExp(daemonState.controlToken));
        assert.doesNotMatch(panelHtml, new RegExp(controllerState.controlToken));
        const csrf = panelHtml.match(/const CSRF="([A-Za-z0-9_-]+)"/)?.[1];
        assert.ok(csrf);
        const setCookie = panel.headers.get("set-cookie") ?? "";
        assert.match(setCookie, /codex_console=[A-Za-z0-9_-]+/);
        const panelCookie = setCookie.split(";", 1)[0];
        const origin = new URL(panelUrl).origin;
        const browserHeaders = { cookie: panelCookie, origin, "x-csrf-token": csrf, "content-type": "application/json" };

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

        const logs = await fetch(new URL("/api/logs?lines=20", panelUrl), { headers: { cookie: panelCookie } });
        assert.equal(logs.status, 200);
        assert.match((await logs.json()).text, /daemon_started/);
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
    const daemon = run(["daemon", "--local"]);
    assert.notEqual(daemon.code, 0);
    assert.match(daemon.output, /内部入口/);
    const controller = run(["controller"]);
    assert.notEqual(controller.code, 0);
    assert.match(controller.output, /内部入口/);
    assert.notEqual(run(["project", "list", "unexpected"]).code, 0);
    const doctor = run(["doctor"]);
    assert.notEqual(doctor.code, 0, doctor.output);
    assert.match(doctor.output, /检查/);
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

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

const testHome = mkdtempSync(join(tmpdir(), "codex-console-flow-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
const { suggestProjects, validateProjectFolder, presentBindings } = await import("../dist/control/project-selection.js");

test("project suggestions skip active, nested, missing and dependency folders; Unicode paths remain usable", async () => {
    const root = join(testHome, "workspace");
    for (const name of ["中文 项目", "active", "node_modules", ".hidden", "plain", "group/nested", "old"]) {
        mkdirSync(join(root, name), { recursive: true });
        if (name !== "plain") writeFileSync(join(root, name, "package.json"), JSON.stringify({ name }));
    }
    const canonical = name => realpathSync(join(root, name));
    const projects = [
        { id: "active", name: "active", path: canonical("active"), active: true, lastSeenAt: "2026-01-01" },
        { id: "old", name: "old", path: canonical("old"), active: false, lastSeenAt: "2026-01-01" },
        { id: "gone", name: "gone", path: join(root, "missing"), active: false, lastSeenAt: "2026-01-01" },
    ];
    const suggestions = await suggestProjects({ home: testHome, projects });
    assert.deepEqual(new Set(suggestions.map(item => item.name)), new Set(["中文 项目", "old"]));
    assert.equal(suggestions.find(item => item.name === "old").source, "recent");
    assert.equal(basename(await validateProjectFolder(join(root, "中文 项目"))), "中文 项目");
    await assert.rejects(validateProjectFolder(join(root, "missing")), /文件夹不存在/);
    await assert.rejects(validateProjectFolder(join(root, "中文 项目", "package.json")), /文件夹不存在/);
    await assert.rejects(validateProjectFolder("  "), /请选择/);
});

test("conversation presentation hides raw owner identifiers and sorts by last use", () => {
    const bindings = [
        { ownerKey: "oauth:private-client|openai-session:private-session", projectId: "a", lastSeenAt: "2026-01-01", boundAt: "2026-01-01" },
        { ownerKey: "local:noauth", projectId: "b", lastSeenAt: "2026-02-01", boundAt: "2026-01-01" },
    ];
    const result = presentBindings(bindings);
    assert.equal(result[0].projectId, "b");
    assert.equal(result[1].label, "ChatGPT 会话");
    assert.doesNotMatch(JSON.stringify(result), /private-client|private-session|ownerKey/);
    assert.equal(result[1].id, presentBindings(bindings)[1].id);
});

test("runtime binding cleanup removes only requested project bindings", async t => {
    const { createHttpServer } = await import("../dist/server/http-server.js");
    const { loadConfig } = await import("../dist/config/loader.js");
    const { ProjectRegistry } = await import("../dist/projects/registry.js");
    const { BindingStore } = await import("../dist/projects/bindings.js");
    const { ProjectRuntimeManager } = await import("../dist/projects/runtime.js");
    const registry = new ProjectRegistry({ projects: [], save: async () => {} });
    const project = await registry.register({ path: testHome });
    const otherRoot = mkdtempSync(join(tmpdir(), "codex-console-other-"));
    const other = await registry.register({ path: otherRoot });
    const now = "2026-09-15T00:00:00.000Z";
    const bindings = new BindingStore({
        bindings: [
            { ownerKey: "oauth:one|openai-session:first", projectId: project.id, boundAt: now, lastSeenAt: now },
            { ownerKey: "oauth:two|openai-session:second", projectId: project.id, boundAt: now, lastSeenAt: now },
            { ownerKey: "oauth:three|openai-session:third", projectId: other.id, boundAt: now, lastSeenAt: now },
        ],
        save: async () => {},
    });
    const server = createHttpServer(loadConfig({ projectRoot: testHome, userConfig: { port: 0 }, local: true }), {
        daemon: { registry, bindings, runtimes: new ProjectRuntimeManager(), controlToken: "binding-clean-token", runtimeIntent: { local: true, noTunnel: true, tunnelLogs: false }, tunnelStatus: () => ({ running: false, state: "off" }), onShutdown: async () => {} },
    });
    await server.listen();
    t.after(() => server.close());
    const endpoint = new URL(`/daemon/projects/${encodeURIComponent(project.id)}/bindings`, server.getMcpUrl());
    const headers = { "x-codex-control-token": "binding-clean-token", "content-type": "application/json" };
    const before = await fetch(endpoint, { headers });
    assert.equal(before.status, 200, await before.clone().text());
    assert.equal((await before.json()).bindings.length, 2);
    const cleanup = await fetch(`${endpoint.href}/cleanup`, {
        method: "POST",
        headers,
        body: JSON.stringify({ removeOwnerKeys: ["oauth:one|openai-session:first"] }),
    });
    assert.equal(cleanup.status, 200, await cleanup.clone().text());
    const result = await cleanup.json();
    assert.equal(result.removed, 1);
    assert.deepEqual(result.bindings.map((item) => item.ownerKey), ["oauth:two|openai-session:second"]);
    assert.equal(bindings.list().filter((item) => item.projectId === other.id).length, 1);
});

test("public-mode internal probe is read-only and never opens an unauthenticated MCP path", async t => {
    const { createHttpServer } = await import("../dist/server/http-server.js");
    const { loadConfig } = await import("../dist/config/loader.js");
    const { setAdminPassword } = await import("../dist/auth/password-store.js");
    const { ProjectRegistry } = await import("../dist/projects/registry.js");
    const { BindingStore } = await import("../dist/projects/bindings.js");
    const { ProjectRuntimeManager } = await import("../dist/projects/runtime.js");
    await setAdminPassword("console-test-password-12345");
    const registry = new ProjectRegistry({ projects: [], save: async () => {} });
    await registry.register({ path: testHome });
    const bindings = new BindingStore({ bindings: [], save: async () => { throw new Error("Probe must not change bindings"); } });
    const server = createHttpServer(loadConfig({ projectRoot: testHome, userConfig: { port: 0 } }), {
        daemon: { registry, bindings, runtimes: new ProjectRuntimeManager(), controlToken: "test-private-control", runtimeIntent: { local: false, noTunnel: true, tunnelLogs: false }, tunnelStatus: () => ({ running: false, state: "off" }), onShutdown: async () => {} },
    });
    await server.listen();
    t.after(() => server.close());
    const url = new URL("/daemon/check-tools", server.getMcpUrl());
    assert.equal((await fetch(url, { method: "POST" })).status, 401);
    const check = await fetch(url, { method: "POST", headers: { "x-codex-control-token": "test-private-control", "content-type": "application/json" }, body: JSON.stringify({ method: "tools/call", name: "exec_command", command: "should never execute" }) });
    assert.equal(check.status, 200, await check.clone().text());
    assert.deepEqual(await check.json(), { toolCount: 15, projectCount: 1 });
    assert.deepEqual(bindings.list(), []);
    assert.equal((await fetch(server.getMcpUrl())).status, 401);
});

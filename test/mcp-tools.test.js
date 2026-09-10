import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const home = mkdtempSync(join(tmpdir(), "codex-mcp-tools-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CODING_MCP_LOG_TOOLS = "0";
const { createHttpServer } = await import("../dist/server/http-server.js");
const { loadConfig } = await import("../dist/config/loader.js");
const { ProjectRegistry } = await import("../dist/projects/registry.js");
const { BindingStore } = await import("../dist/projects/bindings.js");
const { ProjectRuntimeManager } = await import("../dist/projects/runtime.js");

const names = ["project_control", "read", "read_image", "apply_patch", "ls", "grep", "glob", "code_explore", "exec_command", "write_stdin", "skills_list", "skill_read", "mcp_tools", "mcp_call", "summary"];
const quote = value => `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;

test("all 15 MCP tools execute over HTTP; sessions, files, processes and capabilities stay project-scoped", async t => {
    const projects = [join(home, "project-a"), join(home, "project-b")];
    const downstream = fileURLToPath(new URL("fixtures/downstream.mjs", import.meta.url));
    for (let index = 0; index < projects.length; index++) {
        const path = projects[index];
        mkdirSync(join(path, ".claude", "skills", "guide"), { recursive: true });
        writeFileSync(join(path, ".claude", "skills", "guide", "SKILL.md"), `---\nname: guide\ndescription: Test skill\n---\nProject ${index} only.\n`);
        writeFileSync(join(path, ".mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [downstream], env: { TEST_PROJECT: String(index) } } } }));
        writeFileSync(join(path, "main.ts"), `export function hello${index}() { return "project-${index}"; }\n`);
    }
    await sharp({ create: { width: 2, height: 2, channels: 4, background: "#123456" } }).png().toFile(join(projects[0], "sample.png"));
    writeFileSync(join(projects[0], "interactive.cjs"), "process.stdout.write('READY\\n'); process.stdin.on('data', chunk => { process.stdout.write('REPLY:'+chunk); process.exit(0); });");
    mkdirSync(join(home, ".codex-mcp"), { recursive: true });
    writeFileSync(join(home, ".codex-mcp", "config.json"), JSON.stringify({ capabilities: { sync: "startup", sources: { codex: { enabled: false }, agents: { enabled: false }, claude: { enabled: true } } } }));
    const registry = new ProjectRegistry({ projects: [], save: async () => {} });
    const registered = await Promise.all(projects.map(path => registry.register({ path })));
    const bindings = new BindingStore({ bindings: [], save: async () => {} });
    const runtimes = new ProjectRuntimeManager();
    const server = createHttpServer(loadConfig({ projectRoot: home, local: true, userConfig: { port: 0 } }), {
        daemon: { registry, bindings, runtimes, controlToken: "test-control-token", runtimeIntent: { local: true, noTunnel: false, tunnelLogs: false }, tunnelStatus: () => ({ running: false, state: "off" }), onShutdown: async () => {} },
    });
    await server.listen();
    t.after(() => server.close());
    const client = new Client({ name: "contract-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.getMcpUrl())));
    t.after(() => client.close());
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), [...names].sort());
    const called = new Set();
    const call = async (name, args = {}, session = "a", expectedError = false) => {
        called.add(name);
        const result = await client.callTool({ name, arguments: { purpose: "Verify tool contract", ...args }, _meta: { "openai/session": session } });
        assert.equal(result.isError === true, expectedError, `${name}: ${JSON.stringify(result)}`);
        return result;
    };
    await call("read", { path: "main.ts" }, "a", true);
    await call("project_control", { action: "select", project_id: registered[0].id });
    await call("project_control", { action: "select", project_id: registered[1].id }, "b");
    const a = await call("read", { path: "main.ts" });
    assert.match(a.structuredContent.text, /project-0/);
    const b = await call("read", { path: "main.ts" }, "b");
    assert.match(b.structuredContent.text, /project-1/);
    await call("read", { path: join(projects[1], "main.ts") }, "a", true);
    await call("project_control", { action: "select", project_id: registered[1].id }, "a", true);
    await call("apply_patch", { edits: [{ path: "created.txt", newText: "new content\n" }] });
    assert.equal(readFileSync(join(projects[0], "created.txt"), "utf8"), "new content\n");
    assert.equal(existsSync(join(projects[1], "created.txt")), false);
    await call("apply_patch", { edits: [{ path: join(projects[1], "escape.txt"), newText: "bad" }] }, "a", true);
    assert.equal(existsSync(join(projects[1], "escape.txt")), false);
    assert.match((await call("ls", { path: "." })).structuredContent.text, /main.ts/);
    assert.equal((await call("grep", { pattern: "hello0", include: "*.ts" })).structuredContent.matchCount, 1);
    assert.deepEqual((await call("glob", { pattern: "*.ts" })).structuredContent.files, ["main.ts"]);
    assert.match((await call("code_explore", { path: "." })).structuredContent.text, /hello0/);
    assert.ok((await call("read_image", { path: "sample.png" })).content.some(item => item.type === "image"));
    const command = `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} ${quote(join(projects[0], "interactive.cjs"))}`;
    const execution = await call("exec_command", { cmd: command, yield_time_ms: 100 });
    assert.equal(execution.structuredContent.running, true);
    const sessionId = execution.structuredContent.session_id;
    await call("write_stdin", { session_id: sessionId, chars: "bad\n", yield_time_ms: 0 }, "b", true);
    const output = await call("write_stdin", { session_id: sessionId, chars: "hello\n", yield_time_ms: 1000 });
    assert.equal(output.structuredContent.running, false);
    assert.match(output.structuredContent.text, /REPLY:hello/);
    const skills = await call("skills_list");
    const guide = skills.structuredContent.skills.find(item => item.name.includes("guide"));
    assert.ok(guide);
    assert.match((await call("skill_read", { name: guide.name })).structuredContent.content, /Project 0 only/);
    assert.match((await call("skill_read", { name: guide.name }, "b")).structuredContent.content, /Project 1 only/);
    await call("skill_read", { name: "../secret" }, "a", true);
    const gateway = await call("mcp_tools", { server: "fixture" });
    assert.ok(gateway.structuredContent.tools.fixture.some(tool => tool.name === "echo"));
    assert.match((await call("mcp_call", { server: "fixture", tool: "echo", arguments: { text: "hello" } })).structuredContent.text, /^0:hello$/);
    assert.match((await call("mcp_call", { server: "fixture", tool: "echo", arguments: { text: "hello" } }, "b")).structuredContent.text, /^1:hello$/);
    assert.ok((await call("summary", { summary: "Created file." })).structuredContent.fileChanges.count >= 1);
    assert.equal((await call("summary", { summary: "Unchanged." }, "b")).structuredContent.fileChanges.count, 0);
    await call("project_control", { action: "unbind" });
    await call("read", { path: "main.ts" }, "a", true);
    await registry.deactivateById(registered[1].id);
    await call("read", { path: "main.ts" }, "b", true);
    assert.deepEqual([...called].sort(), [...names].sort());
});


test("project cleanup failures retain the runtime for a later retry", async () => {
    const runtimes = new ProjectRuntimeManager();
    const runtime = runtimes.get("retry", home);
    const shutdown = runtime.processOwners.shutdown.bind(runtime.processOwners);
    runtime.processOwners.shutdown = async () => { throw new Error("temporary cleanup failure"); };
    await assert.rejects(runtimes.remove("retry"), /清理未完成/);
    assert.equal(runtimes.has("retry"), true);
    runtime.processOwners.shutdown = shutdown;
    await runtimes.remove("retry");
    assert.equal(runtimes.has("retry"), false);
});

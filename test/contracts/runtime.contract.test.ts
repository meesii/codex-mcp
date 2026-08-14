import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
    connectMcp,
    createProject,
    createTestEnvironment,
    expectToolOk,
    startRuntimeLog,
    startSingleProjectHarness,
    waitUntil,
} from "./harness.js";

test("runtime telemetry contract: aggregate status exposes bounded metrics, never tool payloads or command secrets", async () => {
    const env = await createTestEnvironment("codex-mcp-runtime-status-contract-");
    const project = await createProject("runtime-status", { files: { "identity.txt": "RUNTIME\n" } });
    const server = await startSingleProjectHarness({ root: project });
    const mcp = await connectMcp(server.mcpUrl);
    const secret = "runtime-secret-marker-DO-NOT-RETAIN";

    try {
        for (let index = 0; index < 20; index += 1) {
            expectToolOk(await mcp.call("read", { path: "identity.txt" }));
        }
        expectToolOk(await mcp.call("bash", {
            command: process.platform === "win32"
                ? `node -e "process.stdout.write('ok')" ${secret}`
                : `node -e \"process.stdout.write('ok')\" ${secret}`,
            output_mode: "full",
        }));

        const status = expectToolOk<{
            tools?: Array<{
                tool: string;
                calls: number;
                errors: number;
                p50Ms: number;
                p95Ms: number;
            }>;
            sampleWindow?: number;
            processes?: { running?: number; retained?: number; bufferedChars?: number };
        }>(await mcp.call("runtime_status", {}));
        const readMetric = status.tools?.find((row) => row.tool === "read");
        const bashMetric = status.tools?.find((row) => row.tool === "bash");
        assert.ok((readMetric?.calls ?? 0) >= 20);
        assert.ok((bashMetric?.calls ?? 0) >= 1);
        assert.ok((status.sampleWindow ?? 0) > 0);
        assert.equal(JSON.stringify(status).includes(secret), false);
        assert.equal(JSON.stringify(status).includes("process.stdout.write"), false);
    } finally {
        await mcp.close().catch(() => undefined);
        await server.close().catch(() => undefined);
        await env.cleanup();
    }
});

test("runtime log contract: public tool calls are persisted without tool arguments or authorization-like secrets", async () => {
    const env = await createTestEnvironment("codex-mcp-runtime-log-contract-");
    const project = await createProject("runtime-log", { files: { "identity.txt": "LOG\n" } });
    const secret = "log-secret-marker-NEVER-PERSIST";
    const previousLogSetting = process.env.CODING_MCP_LOG_TOOLS;
    process.env.CODING_MCP_LOG_TOOLS = "1";
    const logDir = join(env.home, ".codex-mcp", "logs");
    const logger = await startRuntimeLog(logDir);
    const server = await startSingleProjectHarness({ root: project });
    const mcp = await connectMcp(server.mcpUrl);

    try {
        expectToolOk(await mcp.call("bash", {
            command: process.platform === "win32"
                ? `node -e "process.stdout.write('ok')" ${secret}`
                : `node -e \"process.stdout.write('ok')\" ${secret}`,
            output_mode: "full",
        }));
        expectToolOk(await mcp.call("read", { path: "identity.txt" }));
        logger.close();

        await waitUntil(async () => {
            const names = await readdir(logDir).catch(() => []);
            if (names.length === 0) return false;
            const combined = await Promise.all(
                names.filter((name) => name.endsWith(".jsonl"))
                    .map((name) => readFile(join(logDir, name), "utf8").catch(() => "")),
            );
            return combined.join("\n").includes('"event":"tool_call"');
        }, 3_000, "tool log flush");

        const files = (await readdir(logDir)).filter((name) => name.endsWith(".jsonl"));
        assert.ok(files.length >= 1);
        const text = (await Promise.all(files.map((name) => readFile(join(logDir, name), "utf8")))).join("\n");
        assert.match(text, /"event":"tool_call"/);
        assert.match(text, /"tool":"bash"/);
        assert.match(text, /"tool":"read"/);
        assert.equal(text.includes(secret), false);
        assert.equal(text.includes("process.stdout.write"), false);
        assert.equal(text.includes("Authorization: Bearer"), false);
    } finally {
        logger.close();
        await mcp.close().catch(() => undefined);
        await server.close().catch(() => undefined);
        if (previousLogSetting === undefined) delete process.env.CODING_MCP_LOG_TOOLS;
        else process.env.CODING_MCP_LOG_TOOLS = previousLogSetting;
        await env.cleanup();
    }
});

test("runtime HTTP contract: many independent stateless MCP clients can initialize without exhausting a small session registry", async () => {
    const env = await createTestEnvironment("codex-mcp-stateless-contract-");
    const project = await createProject("stateless");
    const server = await startSingleProjectHarness({ root: project });
    const clients: Awaited<ReturnType<typeof connectMcp>>[] = [];

    try {
        for (let index = 0; index < 40; index += 1) {
            const client = await connectMcp(server.mcpUrl, { name: `stateless-${index}` });
            clients.push(client);
        }
        assert.equal(clients.length, 40);
        for (const client of clients) {
            const names = new Set((await client.listTools()).map((tool) => tool.name));
            assert.equal(names.has("server_info"), true);
        }
    } finally {
        await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
        await server.close().catch(() => undefined);
        await env.cleanup();
    }
});

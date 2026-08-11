import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeRuntimeLog,
    getRuntimeLogInfo,
    initializeRuntimeLog,
    writeRuntimeLog,
} from "../src/lib/runtime-log.js";

async function main(): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "codex-mcp-runtime-log-"));
    const info = await initializeRuntimeLog({ directory });
    assert.equal(info.directory, directory);
    assert.equal(info.pattern, join(directory, "codex-mcp.*.jsonl"));
    assert.deepEqual(getRuntimeLogInfo(), info);
    assert.deepEqual(await initializeRuntimeLog({ directory }), info);

    writeRuntimeLog("info", "tool_call", {
        tool: "read",
        durationMs: 12,
        ok: true,
        password: "must-not-appear",
        authorization: "Bearer must-not-appear",
        detail: "x".repeat(1_200),
    });
    closeRuntimeLog();
    closeRuntimeLog();
    assert.equal(getRuntimeLogInfo(), undefined);

    const files = (await readdir(directory)).filter((file) => file.endsWith(".jsonl"));
    assert.equal(files.length, 1, JSON.stringify(await readdir(directory)));
    const lines = (await readFile(join(directory, files[0]!), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines.length, 1);
    const event = lines[0]!;
    assert.equal(event.service, "codex-mcp");
    assert.equal(event.event, "tool_call");
    assert.equal(event.tool, "read");
    assert.equal(event.durationMs, 12);
    assert.equal(event.ok, true);
    assert.equal(typeof event.time, "string");
    assert.equal(typeof event.level, "number");
    assert.equal(event.password, undefined);
    assert.equal(event.authorization, undefined);
    assert.equal((event.detail as string).length, 1_001);
    assert.doesNotMatch(JSON.stringify(event), /must-not-appear/);

    console.log("runtime-log.test.ts: ok");
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});

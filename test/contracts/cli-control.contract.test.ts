import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { basename, join } from "node:path";
import {
    createProject,
    createTestEnvironment,
    exists,
    readJsonFile,
    reserveFreePort,
    runCli,
    spawnCli,
    writeJsonFile,
} from "./harness.js";

test("CLI control contract: command-specific flags fail closed and status JSON is stable", async () => {
    const env = await createTestEnvironment("codex-mcp-cli-grammar-", { createConfigDir: false });
    try {
        for (const args of [
            ["status", "--foreground"],
            ["auth", "--root", env.home],
            ["doctor", "--json"],
        ]) {
            const result = await runCli(args, { home: env.home });
            assert.notEqual(result.code, 0, `${args.join(" ")} unexpectedly succeeded`);
            assert.match(result.stderr + result.stdout, /不适用于|只适用于/);
        }

        const status = await runCli(["status", "--json"], { home: env.home });
        assert.equal(status.code, 0, status.stderr);
        const payload = JSON.parse(status.stdout) as Record<string, unknown>;
        assert.equal(payload.schemaVersion, 1);
        assert.equal(payload.running, false);
        assert.equal(typeof payload.cliVersion, "string");
        assert.equal(payload.daemonVersion, null);
        assert.equal(payload.versionMismatch, false);
        assert.deepEqual(payload.projects, []);
    } finally {
        await env.cleanup();
    }
});

test("CLI project/daemon contract: add, list, info, remove, restart and stop preserve public state", async () => {
    const env = await createTestEnvironment("codex-mcp-cli-project-");
    const projectA = await createProject("cli-control-a");
    const projectB = await createProject("cli-control-b");
    const port = await reserveFreePort();
    await writeJsonFile(join(env.home, ".codex-mcp", "config.json"), { port });

    try {
        const addA = await runCli(["project", "add", projectA, "--local"], { home: env.home, timeoutMs: 30_000 });
        assert.equal(addA.code, 0, addA.stderr || addA.stdout);
        assert.match(addA.stdout, /已注册项目/);

        const daemonPath = join(env.home, ".codex-mcp", "daemon.json");
        const firstDaemon = await readJsonFile<{ pid: number }>(daemonPath);
        assert.ok(firstDaemon.pid > 0);

        const addB = await runCli(["project", "add", projectB], { home: env.home, timeoutMs: 30_000 });
        assert.equal(addB.code, 0, addB.stderr || addB.stdout);

        const projectsPath = join(env.home, ".codex-mcp", "projects.json");
        const beforeRestart = await readJsonFile<{ projects: Array<{ id: string; path: string; active: boolean }> }>(projectsPath);
        assert.equal(beforeRestart.projects.length, 2);
        assert.equal(beforeRestart.projects.every((item) => item.active), true);

        const list = await runCli(["project", "list"], { home: env.home });
        assert.equal(list.code, 0, list.stderr);
        assert.match(list.stdout, /cli-control-a/);
        assert.match(list.stdout, /cli-control-b/);

        const projectABasename = basename(projectA);
        const a = beforeRestart.projects.find((item) => item.path === projectA || basename(item.path) === projectABasename);
        assert.ok(a?.id);
        const info = await runCli(["project", "info", a.id], { home: env.home });
        assert.equal(info.code, 0, info.stderr);
        assert.match(info.stdout, new RegExp(a.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

        const jsonBeforeRestart = await runCli(["status", "--json"], { home: env.home });
        assert.equal(jsonBeforeRestart.code, 0, jsonBeforeRestart.stderr);
        const statusBefore = JSON.parse(jsonBeforeRestart.stdout) as { running: boolean; daemon?: { pid?: number }; projects?: unknown[] };
        assert.equal(statusBefore.running, true);
        assert.equal(statusBefore.projects?.length, 2);

        const restart = await runCli(["restart"], { home: env.home, timeoutMs: 30_000 });
        assert.equal(restart.code, 0, restart.stderr || restart.stdout);
        assert.match(restart.stdout, /已重启/);
        const secondDaemon = await readJsonFile<{ pid: number; mode: string }>(daemonPath);
        assert.notEqual(secondDaemon.pid, firstDaemon.pid, "restart must replace the daemon process");
        assert.equal(secondDaemon.mode, "local", "restart must preserve local/public mode");

        const afterRestart = await readJsonFile<{ projects: Array<{ id: string; active: boolean }> }>(projectsPath);
        assert.equal(afterRestart.projects.length, 2);
        assert.equal(afterRestart.projects.every((item) => item.active), true, "restart must not deactivate registered projects");

        const removeA = await runCli(["project", "remove", a.id], { home: env.home });
        assert.equal(removeA.code, 0, removeA.stderr || removeA.stdout);
        const afterRemove = await readJsonFile<{ projects: Array<{ id: string; active: boolean }> }>(projectsPath);
        assert.equal(afterRemove.projects.find((item) => item.id === a.id)?.active, false);
        assert.equal(afterRemove.projects.filter((item) => item.active).length, 1);

        const bareServe = await runCli(["--local", "--root", projectA], { home: env.home, timeoutMs: 30_000 });
        assert.equal(bareServe.code, 0, bareServe.stderr || bareServe.stdout);
        const afterBareServe = await readJsonFile<{ projects: Array<{ id: string; active: boolean }> }>(projectsPath);
        assert.equal(afterBareServe.projects.find((item) => item.id === a.id)?.active, true, "bare codex-mcp must remain a registration shortcut");

        const stop = await runCli(["stop"], { home: env.home, timeoutMs: 30_000 });
        assert.equal(stop.code, 0, stop.stderr || stop.stdout);
        assert.equal(await exists(daemonPath), false);

        const stoppedStatus = await runCli(["status", "--json"], { home: env.home });
        const stoppedPayload = JSON.parse(stoppedStatus.stdout) as { running: boolean; projects: Array<{ active: boolean }> };
        assert.equal(stoppedPayload.running, false);
        assert.equal(stoppedPayload.projects.length, 2);
        assert.equal(stoppedPayload.projects.every((item) => item.active), true, "stop must preserve active project state");

        const restartStopped = await runCli(["restart"], { home: env.home, timeoutMs: 10_000 });
        assert.notEqual(restartStopped.code, 0, "restart must not guess local/public mode after a full stop");
        assert.match(restartStopped.stderr + restartStopped.stdout, /没有在运行|--local/);
    } finally {
        await runCli(["stop"], { home: env.home, timeoutMs: 10_000 }).catch(() => undefined);
        await rm(projectA, { recursive: true, force: true });
        await rm(projectB, { recursive: true, force: true });
        await env.cleanup();
    }
});

test("CLI logs contract: bounded tail and follow expose appended public log lines", async () => {
    const env = await createTestEnvironment("codex-mcp-cli-logs-");
    const logDir = join(env.home, ".codex-mcp", "logs");
    const logPath = join(logDir, "codex-mcp.jsonl");
    await mkdir(logDir, { recursive: true });
    await writeFile(logPath, "one\ntwo\nthree\n", "utf8");

    try {
        const tail = await runCli(["logs", "--lines", "2"], { home: env.home });
        assert.equal(tail.code, 0, tail.stderr);
        assert.equal(tail.stdout, "two\nthree\n");

        const follow = spawnCli(["logs", "-f", "--lines", "1"], { home: env.home });
        await follow.waitForOutput(/three/);
        await writeFile(logPath, "one\ntwo\nthree\nfollow-marker\n", "utf8");
        await follow.waitForOutput(/follow-marker/);
        await follow.stop();
    } finally {
        await env.cleanup();
    }
});

test("CLI doctor contract: default is read-only; --fix only repairs local state", async () => {
    const env = await createTestEnvironment("codex-mcp-cli-doctor-", { createConfigDir: false });
    const configDir = join(env.home, ".codex-mcp");
    const daemonPath = join(configDir, "daemon.json");
    try {
        const before = await runCli(["doctor"], { home: env.home, timeoutMs: 20_000 });
        assert.equal(before.code, 0, before.stderr);
        assert.equal(await exists(join(configDir, "logs")), false, "read-only doctor must not create runtime directories");

        await mkdir(configDir, { recursive: true });
        await writeJsonFile(daemonPath, {
            pid: 999999,
            host: "127.0.0.1",
            port: 65530,
            controlToken: "stale-control-token-for-contract",
            startedAt: "2020-01-01T00:00:00.000Z",
            version: "0.0.0",
            mode: "local",
        });
        const fixed = await runCli(["doctor", "--fix"], { home: env.home, timeoutMs: 20_000 });
        assert.equal(fixed.code, 0, fixed.stderr);
        assert.match(fixed.stdout, /日志目录|失效的 daemon|不会修改 Cloudflare/);
        assert.equal(await exists(join(configDir, "logs")), true);
        assert.equal(await exists(daemonPath), false, "--fix must remove dead daemon state");
    } finally {
        await env.cleanup();
    }
});

test("CLI status contract: daemon/CLI version mismatch is explicit and actionable", async () => {
    const env = await createTestEnvironment("codex-mcp-cli-version-");
    const token = "contract-version-token";
    const server = createServer((request, response) => {
        if (request.headers["x-codex-control-token"] !== token) {
            response.writeHead(401, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "unauthorized" }));
            return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
            ok: true,
            version: "0.0.1-contract-old",
            mode: "local",
            pid: process.pid,
            startedAt: new Date().toISOString(),
            uptimeMs: 1234,
            localUrl: "http://127.0.0.1:1/mcp",
            tunnel: { running: false },
            projects: [],
        }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await writeJsonFile(join(env.home, ".codex-mcp", "daemon.json"), {
        pid: process.pid,
        host: "127.0.0.1",
        port: address.port,
        controlToken: token,
        startedAt: new Date().toISOString(),
        version: "0.0.1-contract-old",
        mode: "local",
    });

    try {
        const text = await runCli(["status"], { home: env.home });
        assert.equal(text.code, 0, text.stderr);
        assert.match(text.stdout, /CLI 版本/);
        assert.match(text.stdout, /Daemon 版本/);
        assert.match(text.stdout, /0\.0\.1-contract-old/);
        assert.match(text.stdout, /restart/);

        const json = await runCli(["status", "--json"], { home: env.home });
        const payload = JSON.parse(json.stdout) as { versionMismatch: boolean; daemonVersion: string };
        assert.equal(payload.versionMismatch, true);
        assert.equal(payload.daemonVersion, "0.0.1-contract-old");
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await env.cleanup();
    }
});

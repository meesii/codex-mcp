import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
    REPO_ROOT,
    createProject,
    createTestEnvironment,
    exists,
    readJsonFile,
    reserveFreePort,
    runCli,
    writeJsonFile,
} from "./harness.js";

test("CLI contract: one daemon serves multiple registered projects and exit scopes correctly", async () => {
    const env = await createTestEnvironment("codex-mcp-cli-contract-");
    const projectA = await createProject("cli-a", { files: { "identity.txt": "CLI-A\n" } });
    const projectB = await createProject("cli-b", { files: { "identity.txt": "CLI-B\n" } });
    const canonicalA = await realpath(projectA);
    const canonicalB = await realpath(projectB);
    const port = await reserveFreePort();
    await writeJsonFile(join(env.home, ".codex-mcp", "config.json"), { port });

    try {
        const help = await runCli(["--help"], { home: env.home });
        assert.equal(help.code, 0, help.stderr);
        assert.match(help.stdout, /codex-mcp/);
        assert.match(help.stdout, /status/);
        assert.match(help.stdout, /exit -a/);
        assert.match(help.stdout, /--local/);

        const version = await runCli(["--version"], { home: env.home });
        assert.equal(version.code, 0, version.stderr);
        assert.match(version.stdout, /\d+\.\d+\.\d+/);
        assert.doesNotMatch(help.stdout + version.stdout, /\u001b\[/, "piped CLI output must not contain ANSI escapes");

        const invalidRoot = await runCli(["--local", "--root", join(env.home, "missing-project")], {
            home: env.home,
            timeoutMs: 10_000,
        });
        assert.notEqual(invalidRoot.code, 0);
        assert.match(invalidRoot.stderr + invalidRoot.stdout, /不存在|不是文件夹|directory|folder/i);

        const startA = await runCli(["--local", "--root", projectA], {
            home: env.home,
            timeoutMs: 30_000,
        });
        assert.equal(startA.code, 0, startA.stderr || startA.stdout);
        assert.match(startA.stdout, /已就绪|注册|当前项目/);
        assert.match(startA.stdout, /codex-mcp-cli-a-/);

        const daemonStatePath = join(env.home, ".codex-mcp", "daemon.json");
        const daemonStateA = await readJsonFile<{
            pid: number;
            port: number;
            controlToken: string;
        }>(daemonStatePath);
        assert.ok(daemonStateA.pid > 0);
        assert.ok(daemonStateA.port > 0);
        assert.ok(daemonStateA.controlToken.length >= 16);

        const unauthenticatedControl = await fetch(
            `http://127.0.0.1:${daemonStateA.port}/daemon/status`,
        );
        assert.equal(unauthenticatedControl.status, 401);

        const startB = await runCli(["--local", "--root", projectB], {
            home: env.home,
            timeoutMs: 30_000,
        });
        assert.equal(startB.code, 0, startB.stderr || startB.stdout);

        const daemonStateB = await readJsonFile<{ pid: number; port: number }>(daemonStatePath);
        assert.equal(daemonStateB.pid, daemonStateA.pid, "registering B must reuse the same daemon");
        assert.equal(daemonStateB.port, daemonStateA.port, "registering B must reuse the same port");

        const projectsPath = join(env.home, ".codex-mcp", "projects.json");
        const projectsAfterB = await readJsonFile<{
            projects?: Array<{
                path: string;
                active: boolean;
                id: string;
            }>;
        }>(projectsPath);
        const a = projectsAfterB.projects?.find((item) => item.path === canonicalA);
        const b = projectsAfterB.projects?.find((item) => item.path === canonicalB);
        assert.equal(a?.active, true);
        assert.equal(b?.active, true);
        assert.ok(a?.id);
        assert.ok(b?.id);
        assert.notEqual(a?.id, b?.id);

        const stopA = await runCli(["exit"], { cwd: projectA, home: env.home });
        assert.equal(stopA.code, 0, stopA.stderr || stopA.stdout);
        const projectsAfterAExit = await readJsonFile<{
            projects?: Array<{ path: string; active: boolean }>;
        }>(projectsPath);
        assert.equal(projectsAfterAExit.projects?.find((item) => item.path === canonicalA)?.active, false);
        assert.equal(projectsAfterAExit.projects?.find((item) => item.path === canonicalB)?.active, true);

        const status = await runCli(["status"], { home: env.home });
        assert.equal(status.code, 0, status.stderr || status.stdout);
        assert.match(status.stdout, /codex-mcp-cli-b-/);

        const stopAll = await runCli(["exit", "-a"], { home: env.home, timeoutMs: 30_000 });
        assert.equal(stopAll.code, 0, stopAll.stderr || stopAll.stdout);

        const afterStop = await runCli(["status"], { home: env.home });
        assert.equal(afterStop.code, 0, afterStop.stderr || afterStop.stdout);
        assert.match(afterStop.stdout, /未运行|没有(?:在)?运行|守护进程.*未/i);
    } finally {
        await runCli(["exit", "-a"], { home: env.home, timeoutMs: 10_000 }).catch(() => undefined);
        await env.cleanup();
    }
});

test("daemon startup lock contract: a completely fresh HOME creates its own config directory", async () => {
    const env = await createTestEnvironment("codex-mcp-first-run-lock-", { createConfigDir: false });
    try {
        const controlModule = pathToFileURL(join(REPO_ROOT, "dist", "daemon", "control.js")).href;
        execFileSync(
            process.execPath,
            [
                "--input-type=module",
                "-e",
                `const { withDaemonStartLock } = await import(${JSON.stringify(controlModule)}); await withDaemonStartLock(async () => {});`,
            ],
            {
                cwd: REPO_ROOT,
                env: { ...process.env, HOME: env.home, USERPROFILE: env.home },
                stdio: "pipe",
            },
        );
        assert.equal(await exists(join(env.home, ".codex-mcp")), true);
        assert.equal(await exists(join(env.home, ".codex-mcp", "daemon.lock")), false, "lock must be released after startup section");
    } finally {
        await env.cleanup();
    }
});


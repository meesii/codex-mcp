import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const home = mkdtempSync(join(tmpdir(), "codex-mcp-lifecycle-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const { startDaemonForIntent } = await import("../dist/daemon/control.js");
const { CloudflaredSidecar } = await import("../dist/tunnel/sidecar.js");
const { runCloudflared } = await import("../dist/tunnel/exec.js");
const { terminateChildProcess } = await import("../dist/lib/process/tree.js");
const configDir = join(home, ".codex-mcp");
mkdirSync(configDir, { recursive: true });
writeFileSync(join(configDir, "config.json"), JSON.stringify({ port: 0, capabilities: { sources: { codex: { enabled: false }, agents: { enabled: false }, claude: { enabled: false } } } }));

async function until(check, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (!check()) {
        if (Date.now() >= deadline) assert.fail("condition did not become true before deadline");
        await delay(25);
    }
}

test("startup deadline cleans up its child and descendants", { timeout: 10000 }, async () => {
    const fixture = join(home, "cli.js");
    const heartbeat = join(home, "heartbeat");
    writeFileSync(fixture, `const {spawn}=require('node:child_process'); if(process.argv[2]==='worker'){setInterval(()=>require('node:fs').writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),25);}else{spawn(process.execPath,[__filename,'worker'],{stdio:'ignore'});setInterval(()=>{},1000);}`);
    const previous = process.argv[1];
    process.argv[1] = fixture;
    try {
        await assert.rejects(startDaemonForIntent({ local: true, noTunnel: false, tunnelLogs: false }, { timeoutMs: 1000 }), /启动超时/);
        assert.ok(existsSync(heartbeat));
        const last = readFileSync(heartbeat, "utf8");
        await delay(120);
        assert.equal(readFileSync(heartbeat, "utf8"), last);
        assert.equal(existsSync(join(configDir, "daemon.json")), false);
    } finally { process.argv[1] = previous; }
});

test("a daemon whose starting parent disconnects before initialization exits without publishing state", { timeout: 10000 }, async t => {
    const child = spawn(process.execPath, [cli, "daemon", "--local"], { cwd: home, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    t.after(() => terminateChildProcess(child));
    const exited = once(child, "exit");
    child.disconnect();
    const [code] = await exited;
    assert.notEqual(code, 0);
    assert.equal(existsSync(join(configDir, "daemon.json")), false);
});

test("cloudflared observed lifecycle has bounded recovery and stop cancels readiness", { timeout: 10000 }, async () => {
    const previous = process.cwd();
    const fixtureDir = mkdtempSync(join(home, "sidecar-"));
    const fixture = join(fixtureDir, "tunnel");
    writeFileSync(fixture, "process.stdout.write('Registered tunnel connection location=test protocol=http2\\n'); setTimeout(()=>process.exit(1),100);");
    process.chdir(fixtureDir);
    const states = [];
    const sidecar = new CloudflaredSidecar({ bin: process.execPath, tunnelId: "test", configPath: "unused", maxRestarts: 1, readyTimeoutMs: 1000, onStateChange: value => states.push(value) });
    try {
        assert.equal((await sidecar.start()).protocol, "http2");
        await until(() => states.at(-1)?.state === "exited");
        assert.equal(states.filter(value => value.state === "connected").length, 2);
        assert.equal(states.at(-1).restartCount, 1);
        await sidecar.stop();
        assert.equal(states.at(-1).state, "off");
        writeFileSync(fixture, "setInterval(()=>{},1000);");
        const starting = sidecar.start();
        const rejected = assert.rejects(starting, /退出|准备/);
        await delay(80);
        await sidecar.stop();
        await rejected;
        assert.equal(states.at(-1).state, "off");
    } finally { await sidecar.stop(); process.chdir(previous); }
});

test("captured cloudflared operations surface login output and honor cancellation", { timeout: 10000 }, async () => {
    const fixtureDir = mkdtempSync(join(home, "cloudflared-capture-"));
    const fixture = join(fixtureDir, "login.cjs");
    writeFileSync(fixture, "process.stdout.write('Open https://dash.cloudflare.com/argotunnel?token=test\\n'); setInterval(()=>{},1000);");
    const controller = new AbortController();
    let output = "";
    const running = runCloudflared(process.execPath, [fixture], {
        timeoutMs: 5000,
        managedHome: fixtureDir,
        signal: controller.signal,
        onOutput: text => { output += text; },
    });
    await until(() => output.includes("https://dash.cloudflare.com/argotunnel"));
    controller.abort(new Error("cancel login"));
    await assert.rejects(running, /cancel login|取消/);
    assert.match(output, /https:\/\/dash\.cloudflare\.com\/argotunnel/);
});

test("logs --follow continues across rotation and truncation", { timeout: 10000 }, async t => {
    const logDir = join(configDir, "logs");
    mkdirSync(logDir, { recursive: true });
    const first = join(logDir, "codex-mcp.2026-09-09.1.jsonl");
    const second = join(logDir, "codex-mcp.2026-09-09.2.jsonl");
    writeFileSync(first, "initial-record\n");
    const child = spawn(process.execPath, [cli, "logs", "--follow"], { cwd: home, stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => terminateChildProcess(child));
    let output = "";
    child.stdout.on("data", data => { output += data.toString(); });
    await until(() => output.includes("initial-record"));
    await delay(80);
    appendFileSync(first, "appended-record\n");
    await until(() => output.includes("appended-record"));
    writeFileSync(second, "rotated-record\n");
    await until(() => output.includes("rotated-record"));
    truncateSync(second, 0);
    writeFileSync(second, "new\n");
    await until(() => output.includes("new\n"));
    await terminateChildProcess(child);
});

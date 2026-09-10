import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const scratch = mkdtempSync(join(tmpdir(), "codex-mcp-package-smoke-"));
const home = join(scratch, "home");
const installRoot = join(scratch, "install");
const project = join(scratch, "project");
const packDir = join(scratch, "pack");
const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    npm_config_cache: join(scratch, "npm-cache"),
};

mkdirSync(join(home, ".codex-mcp"), { recursive: true });
mkdirSync(project, { recursive: true });
mkdirSync(packDir, { recursive: true });
writeFileSync(
    join(home, ".codex-mcp", "config.json"),
    JSON.stringify({
        port: 0,
        capabilities: {
            sources: {
                codex: { enabled: false },
                agents: { enabled: false },
                claude: { enabled: false },
            },
        },
    }),
);

function run(file, args, options = {}) {
    try {
        return execFileSync(file, args, {
            cwd: options.cwd ?? root,
            env,
            encoding: "utf8",
            stdio: "pipe",
            timeout: options.timeout ?? 180_000,
        });
    } catch (error) {
        const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
        throw new Error(`${file} ${args.join(" ")} failed\n${output}`, { cause: error });
    }
}

function buildTarball() {
    const output = run(npm, ["pack", "--json", "--pack-destination", packDir]);
    const packed = JSON.parse(output);
    if (!Array.isArray(packed) || typeof packed[0]?.filename !== "string") {
        throw new Error(`npm pack returned an unexpected payload: ${output}`);
    }
    return join(packDir, packed[0].filename);
}

const tarball = process.argv[2] ? resolve(process.argv[2]) : buildTarball();
if (!existsSync(tarball)) throw new Error(`package tarball does not exist: ${tarball}`);

run(npm, ["install", "--prefix", installRoot, tarball, "--omit=dev", "--registry=https://registry.npmjs.org"]);
const cli = join(installRoot, "node_modules", "@meesii", "codex-mcp", "dist", "cli.js");
const binShim = join(installRoot, "node_modules", ".bin", process.platform === "win32" ? "codex-mcp.cmd" : "codex-mcp");
assert.equal(existsSync(binShim), true, `npm bin shim is missing: ${binShim}`);
assert.equal(run(process.execPath, [cli, "--version"], { cwd: project }).trim(), packageVersion);

let started = false;
try {
    run(process.execPath, [cli, "start", "--local"], { cwd: project });
    started = true;
    const status = JSON.parse(run(process.execPath, [cli, "status", "--json"], { cwd: project }));
    assert.equal(status.running, true);
    assert.equal(status.daemon.mode, "local");
    assert.equal(status.daemon.controlApiVersion, 1);
    assert.match(status.daemon.localUrl, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.match(status.controller.panelUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(status.projects.length, 1);
    assert.equal(status.projects[0].active, true);
    run(process.execPath, [cli, "stop"], { cwd: project });
    started = false;
    const stopped = JSON.parse(run(process.execPath, [cli, "status", "--json"], { cwd: project }));
    assert.equal(stopped.running, false);
    assert.equal(existsSync(join(home, ".codex-mcp", "daemon.json")), false);
    assert.equal(stopped.controller.pid, status.controller.pid);
    const panel = await fetch(stopped.controller.panelUrl);
    assert.equal(panel.status, 200);
    assert.match(await panel.text(), /codex-mcp 本机控制台/);
    const controllerStatePath = join(home, ".codex-mcp", "controller.json");
    const controllerState = JSON.parse(readFileSync(controllerStatePath, "utf8"));
    const shutdown = await fetch(`http://127.0.0.1:${controllerState.port}/api/controller/shutdown`, {
        method: "POST",
        headers: { "x-codex-controller-token": controllerState.controlToken },
    });
    assert.equal(shutdown.status, 200);
    const deadline = Date.now() + 10_000;
    while (existsSync(controllerStatePath) && Date.now() < deadline) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    assert.equal(existsSync(controllerStatePath), false, "Controller state should be removed after explicit smoke cleanup");
    process.stdout.write(`package_smoke=PASS version=${packageVersion}\n`);
} finally {
    if (started) {
        try { run(process.execPath, [cli, "stop"], { cwd: project, timeout: 30_000 }); }
        catch { /* best-effort cleanup for a failed smoke */ }
    }
    const controllerStatePath = join(home, ".codex-mcp", "controller.json");
    if (existsSync(controllerStatePath)) {
        try {
            const controllerState = JSON.parse(readFileSync(controllerStatePath, "utf8"));
            await fetch(`http://127.0.0.1:${controllerState.port}/api/controller/shutdown`, {
                method: "POST",
                headers: { "x-codex-controller-token": controllerState.controlToken },
            });
        } catch { /* best-effort cleanup for a failed smoke */ }
    }
    if (process.env.CODEX_MCP_KEEP_PACKAGE_SMOKE !== "1") {
        rmSync(scratch, { recursive: true, force: true });
    } else {
        process.stdout.write(`package_smoke_dir=${scratch}\n`);
    }
}

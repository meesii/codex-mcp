import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT } from "./harness.js";

test("package contract: npm tarball contains the runnable CLI and both platform installers", () => {
    const npmCli = process.env.npm_execpath;
    assert.ok(npmCli, "npm_execpath must be available when the contract suite runs via npm test");
    const output = execFileSync(process.execPath, [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(output) as Array<{
        files?: Array<{ path?: string }>;
    }>;
    const files = new Set((parsed[0]?.files ?? []).map((entry) => entry.path));
    for (const required of [
        "dist/cli.js",
        "scripts/install.sh",
        "scripts/install.ps1",
        "README.md",
        "LICENSE",
        "package.json",
    ]) {
        assert.equal(files.has(required), true, `npm package is missing ${required}`);
    }
});

test("installer safety contract: install/uninstall scripts use an isolated ~/.codex-mcp/npm prefix and uninstall never deletes all user state", async () => {
    const installSh = await readFile(join(REPO_ROOT, "scripts", "install.sh"), "utf8");
    const uninstallSh = await readFile(join(REPO_ROOT, "scripts", "uninstall.sh"), "utf8");
    const installPs = await readFile(join(REPO_ROOT, "scripts", "install.ps1"), "utf8");
    const uninstallPs = await readFile(join(REPO_ROOT, "scripts", "uninstall.ps1"), "utf8");

    execFileSync("sh", ["-n", join(REPO_ROOT, "scripts", "install.sh")], { stdio: "ignore" });
    execFileSync("sh", ["-n", join(REPO_ROOT, "scripts", "uninstall.sh")], { stdio: "ignore" });

    assert.match(installSh, /\.codex-mcp\/npm/);
    assert.match(uninstallSh, /\.codex-mcp\/npm/);
    assert.doesNotMatch(uninstallSh, /rm\s+-rf\s+[^\n]*\.codex-mcp["']?(?:\s|$)/);

    assert.match(installPs, /\.codex-mcp\\npm|\.codex-mcp[\\/]npm/);
    assert.match(uninstallPs, /\.codex-mcp\\npm|\.codex-mcp[\\/]npm/);
    assert.doesNotMatch(uninstallPs, /Remove-Item[^\n]*\.codex-mcp["']\s*$/m);
});

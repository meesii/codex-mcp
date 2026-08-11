import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, resolveProjectRoot } from "../src/config.js";

async function main(): Promise<void> {
    const originalCwd = process.cwd();
    const fixtureRoot = await mkdtemp(join(tmpdir(), "codex-mcp-config-"));

    try {
        process.chdir(fixtureRoot);
        const currentDirectory = process.cwd();
        assert.equal(resolveProjectRoot(), currentDirectory);
        assert.equal(loadConfig({ local: true }).projectRoot, currentDirectory);

        const explicitRoot = await mkdtemp(join(tmpdir(), "codex-mcp-root-"));
        assert.equal(resolveProjectRoot(explicitRoot), explicitRoot);
        assert.equal(
            loadConfig({ local: true, projectRoot: explicitRoot }).projectRoot,
            explicitRoot,
        );

        const filePath = join(fixtureRoot, "not-a-directory");
        await writeFile(filePath, "fixture\n", "utf8");
        assert.throws(
            () => resolveProjectRoot(filePath),
            /不存在或不是文件夹/,
        );
        assert.throws(
            () => resolveProjectRoot("missing-directory"),
            /不存在或不是文件夹/,
        );
        assert.equal(resolveProjectRoot("."), resolve(currentDirectory));
    } finally {
        process.chdir(originalCwd);
    }

    console.log("config.test.ts: ok");
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});

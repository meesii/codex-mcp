import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { getManagedToolSpec } from "../src/managed-tools/manifest.js";
import { extractZipFile } from "../src/managed-tools/unzip.js";

async function main(): Promise<void> {
    const macArmRg = getManagedToolSpec("ripgrep", "darwin", "arm64");
    assert.equal(macArmRg.version, "15.2.0");
    assert.match(macArmRg.url, /aarch64-apple-darwin\.tar\.gz$/);
    assert.equal(macArmRg.archiveEntry?.endsWith("/rg"), true);

    const linuxX64Rg = getManagedToolSpec("ripgrep", "linux", "x64");
    assert.match(linuxX64Rg.url, /x86_64-unknown-linux-musl\.tar\.gz$/);
    assert.equal(linuxX64Rg.sha256.length, 64);

    const windowsRg = getManagedToolSpec("ripgrep", "win32", "x64");
    assert.equal(windowsRg.archive, "zip");
    assert.equal(windowsRg.archiveEntry?.endsWith("/rg.exe"), true);

    const macCloudflared = getManagedToolSpec("cloudflared", "darwin", "arm64");
    assert.equal(macCloudflared.version, "2026.7.2");
    assert.equal(macCloudflared.archiveEntry, "cloudflared");

    const linuxCloudflared = getManagedToolSpec("cloudflared", "linux", "arm64");
    assert.equal(linuxCloudflared.archive, "raw");
    assert.match(linuxCloudflared.url, /cloudflared-linux-arm64$/);

    const windowsArmCloudflared = getManagedToolSpec("cloudflared", "win32", "arm64");
    assert.match(windowsArmCloudflared.url, /cloudflared-windows-amd64\.exe$/);

    assert.throws(
        () => getManagedToolSpec("ripgrep", "freebsd" as NodeJS.Platform, "x64"),
        /暂不支持/,
    );

    const tempRoot = await mkdtemp(join(tmpdir(), "codex-mcp-unzip-"));
    const safeZip = join(tempRoot, "safe.zip");
    await writeFile(
        safeZip,
        zipSync({
            "ripgrep-win/rg.exe": strToU8("rg-bin"),
        }),
    );
    const safeDir = join(tempRoot, "safe");
    await extractZipFile(safeZip, safeDir);
    assert.equal(await readFile(join(safeDir, "ripgrep-win", "rg.exe"), "utf8"), "rg-bin");

    const slipZip = join(tempRoot, "slip.zip");
    await writeFile(
        slipZip,
        zipSync({
            "../evil.txt": strToU8("nope"),
        }),
    );
    await assert.rejects(extractZipFile(slipZip, join(tempRoot, "slip")), /非法路径/);

    console.log("managed-tools.test.ts: ok");
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});

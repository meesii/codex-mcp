import assert from "node:assert/strict";
import { getManagedToolSpec } from "../src/managed-tools/manifest.js";

function main(): void {
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

    console.log("managed-tools.test.ts: ok");
}

main();

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { getUpdateInstallerInvocation } from "../src/update.js";

function main(): void {
    const windows = getUpdateInstallerInvocation("win32");
    assert.equal(windows.file, "powershell.exe");
    assert.equal(windows.args.at(-2), "-File");
    assert.equal(windows.args.at(-1), windows.scriptPath);
    assert.match(windows.scriptPath, /scripts[\\/]install\.ps1$/);
    assert.equal(existsSync(windows.scriptPath), true);

    for (const platform of ["darwin", "linux"] as const) {
        const unix = getUpdateInstallerInvocation(platform);
        assert.equal(unix.file, "sh");
        assert.deepEqual(unix.args, [unix.scriptPath]);
        assert.match(unix.scriptPath, /scripts[\\/]install\.sh$/);
        assert.equal(existsSync(unix.scriptPath), true);
    }

    assert.throws(
        () => getUpdateInstallerInvocation("freebsd"),
        /暂不支持自动更新/,
    );

    console.log("update.test.ts: ok");
}

main();

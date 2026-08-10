import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    generateAdminPassword,
    getAuthCredentialPath,
    hasAdminPassword,
    setAdminPassword,
    verifyAdminPassword,
} from "../src/auth/password-store.js";

async function main(): Promise<void> {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const tempHome = mkdtempSync(join(tmpdir(), "codex-mcp-password-"));

    try {
        process.env.HOME = tempHome;
        process.env.USERPROFILE = tempHome;

        const first = generateAdminPassword();
        const second = generateAdminPassword();

        assert.equal(first.length, 24);
        assert.match(first, /^[A-Za-z0-9_-]{24}$/);
        assert.notEqual(first, second);

        assert.equal(await hasAdminPassword(), false);
        await setAdminPassword(first);
        assert.equal(await hasAdminPassword(), true);
        assert.equal(await verifyAdminPassword(first), true);
        assert.equal(await verifyAdminPassword(second), false);
        assert.equal(readFileSync(getAuthCredentialPath(), "utf8").includes(first), false);

        console.log("password-store.test.ts: ok");
    } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previousUserProfile;
        rmSync(tempHome, { recursive: true, force: true });
    }
}

await main();

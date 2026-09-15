import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const home = mkdtempSync(join(tmpdir(), "codex-mcp-tunnel-transaction-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { applyTunnelSetup } = await import("../dist/tunnel/apply-setup.js");
const { isDeletedCloudflareTunnelRecord } = await import("../dist/tunnel/cloudflare-api.js");
const { selectReusableTunnel } = await import("../dist/tunnel/cloudflare-session.js");

const tunnelId = "00000000-0000-4000-8000-000000000001";
const before = { zoneId: "zone", hostname: "mcp.example.com", records: [] };
const after = { ...before, records: [{ id: "dns-new", type: "CNAME", name: before.hostname, ttl: 1, proxied: true, content: `${tunnelId}.cfargotunnel.com` }] };
const access = { kind: "cloudflare", domain: before.hostname, tunnelId, tunnelName: "fixture", cloudflaredBin: "fixture-bin", configRevision: "candidate", zoneId: "zone", accountId: "account" };
const candidate = { userConfig: { host: "127.0.0.1", port: 3920, publicAccess: access }, publicAccess: access, domain: before.hostname, useCloudflared: true, tunnelId, zoneId: "zone", configRevision: "candidate", previousConfigRevision: "previous", bin: "fixture-bin", candidateSession: { createdTunnel: true } };

function fixture(failAt) {
    const events = [];
    let current = before;
    let committed = false;
    const operations = {
        assertSetupPortAvailable: async () => { events.push("preflight"); if (failAt === "preflight") throw new Error("port occupied"); },
        verifySetupPublicRoute: async (_candidate, _host, _port, options) => {
            events.push("connector-ready");
            await options.beforePublicVerify();
            events.push("probe");
            if (failAt === "probe" || failAt === "restore") throw new Error("wrong public instance");
            return { publicMcpUrl: `https://${before.hostname}/mcp` };
        },
        snapshotCloudflareDns: async () => { events.push("snapshot"); return current; },
        cutoverCloudflareDns: async snapshot => { assert.equal(snapshot, before); events.push("cutover"); current = after; return { changed: true, committed: after }; },
        restoreCloudflareDns: async (original, written) => {
            assert.equal(original, before); assert.equal(written, after); events.push("restore");
            if (failAt === "restore") throw new Error("concurrent DNS change");
            current = before;
        },
        saveUserConfig: config => { events.push("commit"); if (failAt === "commit") throw new Error("disk full"); committed = true; return config; },
        removeCloudflaredRevision: revision => { assert.equal(revision, "previous"); events.push("remove-previous"); },
        cleanupFailedCandidate: async (_candidate, errors, mayDelete) => { events.push(mayDelete ? "delete-candidate" : "retain-candidate"); if (!mayDelete) errors.push("candidate still referenced"); },
        requireDnsOverwriteConfirmation: async () => { assert.fail("empty original DNS needs no overwrite prompt"); },
    };
    return { events, operations, committed: () => committed, dns: () => current };
}

test("Tunnel commits only after connector, DNS cutover and public verification succeed", async () => {
    const f = fixture();
    await applyTunnelSetup(candidate, f.operations);
    assert.deepEqual(f.events, ["preflight", "connector-ready", "snapshot", "cutover", "probe", "commit", "remove-previous"]);
    assert.equal(f.committed(), true);
    assert.equal(f.dns(), after);
});

test("a committed hostname switch retires only the previous managed DNS route", async () => {
    const f = fixture();
    const previousManagedAccess = {
        ...access,
        domain: "old.example.com",
        configRevision: "previous",
    };
    f.operations.removeCloudflareManagedDnsIfOwned = async (zoneId, hostname, id) => {
        assert.equal(zoneId, previousManagedAccess.zoneId);
        assert.equal(hostname, previousManagedAccess.domain);
        assert.equal(id, previousManagedAccess.tunnelId);
        assert.equal(f.committed(), true, "old DNS must not be retired before local commit");
        f.events.push("retire-old-dns");
        return true;
    };
    await applyTunnelSetup({ ...candidate, previousManagedAccess }, f.operations);
    assert.deepEqual(f.events, ["preflight", "connector-ready", "snapshot", "cutover", "probe", "commit", "remove-previous", "retire-old-dns"]);
});

test("old managed DNS cleanup failure does not roll back a verified new route", async () => {
    const f = fixture();
    const previousManagedAccess = {
        ...access,
        domain: "old.example.com",
        configRevision: "previous",
    };
    f.operations.removeCloudflareManagedDnsIfOwned = async () => {
        f.events.push("retire-old-dns");
        throw new Error("cleanup unavailable");
    };
    await applyTunnelSetup({ ...candidate, previousManagedAccess }, f.operations);
    assert.equal(f.committed(), true);
    assert.equal(f.events.at(-1), "retire-old-dns");
});

for (const phase of ["probe", "commit"]) {
    test(`Tunnel ${phase} failure restores DNS before deleting the candidate and preserves previous config`, async () => {
        const f = fixture(phase);
        await assert.rejects(applyTunnelSetup(candidate, f.operations), /公网配置失败/);
        assert.equal(f.committed(), false);
        assert.equal(f.dns(), before);
        assert.ok(f.events.indexOf("restore") > f.events.indexOf("cutover"));
        assert.ok(f.events.indexOf("delete-candidate") > f.events.indexOf("restore"));
        assert.equal(f.events.includes("remove-previous"), false);
    });
}

test("failed DNS compensation retains a referenced candidate and reports partial state", async () => {
    const f = fixture("restore");
    await assert.rejects(applyTunnelSetup(candidate, f.operations), /部分变更状态/);
    assert.equal(f.committed(), false);
    assert.equal(f.dns(), after);
    assert.equal(f.events.at(-1), "retain-candidate");
    assert.equal(f.events.includes("delete-candidate"), false);
});

test("failed local preflight makes no DNS change and never commits", async () => {
    const f = fixture("preflight");
    await assert.rejects(applyTunnelSetup(candidate, f.operations), /port occupied/);
    assert.deepEqual(f.events, ["preflight", "delete-candidate"]);
    assert.equal(f.committed(), false);
});

test("Cloudflare soft-deleted tunnel records are treated as absent", () => {
    assert.equal(isDeletedCloudflareTunnelRecord({}), false);
    assert.equal(isDeletedCloudflareTunnelRecord({ deleted_at: null }), false);
    assert.equal(isDeletedCloudflareTunnelRecord({ deleted_at: "2026-09-15T12:15:02Z" }), true);
});

test("managed Tunnel reuse recognizes locally-owned historical suffixes", () => {
    const base = "codex-mcp-mba-local-06c2be";
    const rows = [
        { id: "foreign", name: base },
        { id: "owned-old", name: `${base}-cd4be8eb` },
        { id: "unrelated", name: "other-tunnel" },
    ];
    const owns = (id) => id === "owned-old";
    assert.deepEqual(selectReusableTunnel(rows, base, owns), rows[1]);
    assert.equal(selectReusableTunnel(rows, base, () => false), undefined);
});

test("managed Tunnel reuse prefers a known id, then the exact default name", () => {
    const base = "codex-mcp-host-abcdef";
    const rows = [
        { id: "exact", name: base },
        { id: "suffix", name: `${base}-12345678` },
    ];
    const owns = () => true;
    assert.deepEqual(selectReusableTunnel(rows, base, owns, "suffix"), rows[1]);
    assert.deepEqual(selectReusableTunnel(rows, base, owns), rows[0]);
});

test("managed Tunnel reuse survives a machine hostname change only when ownership is unambiguous", () => {
    const rows = [
        { id: "old-host", name: "codex-mcp-mba-local-06c2be-cd4be8eb" },
        { id: "foreign", name: "somebody-else" },
    ];
    assert.deepEqual(selectReusableTunnel(rows, "codex-mcp-192-168-1-194-746b9f", (id) => id === "old-host"), rows[0]);
    assert.equal(selectReusableTunnel(
        [...rows, { id: "second-owned", name: "codex-mcp-another-host-123456" }],
        "codex-mcp-192-168-1-194-746b9f",
        (id) => id === "old-host" || id === "second-owned",
    ), undefined);
});

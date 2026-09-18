import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { normalizeCodexMcpList } = await import("../dist/config/codex-import.js");
const { loadClaudeMcpConfig } = await import("../dist/capabilities/providers/claude.js");

test("external capability providers treat a real empty state as empty instead of malformed", () => {
    assert.deepEqual(normalizeCodexMcpList([]), { mcpServers: {} });
    assert.throws(
        () => normalizeCodexMcpList(null),
        /顶层应该是数组/,
        "Codex contract is an array; null should not be silently accepted",
    );

    const root = mkdtempSync(join(tmpdir(), "codex-mcp-empty-capabilities-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });

    assert.deepEqual(
        loadClaudeMcpConfig({
            homeDirectory: home,
            primaryWorkspace: workspace,
            workspaceRoots: [workspace],
            includeUserScope: true,
            includeProjectScope: true,
        }),
        { config: { mcpServers: {} } },
    );

    writeFileSync(join(home, ".claude.json"), JSON.stringify({ firstStartVersion: "fixture" }));
    writeFileSync(join(workspace, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
    assert.deepEqual(
        loadClaudeMcpConfig({
            homeDirectory: home,
            primaryWorkspace: workspace,
            workspaceRoots: [workspace],
            includeUserScope: true,
            includeProjectScope: true,
        }),
        { config: { mcpServers: {} } },
    );
});

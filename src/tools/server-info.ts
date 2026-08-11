import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ProjectContext } from "../config/project.js";
import { PACKAGE_VERSION } from "../server/version.js";
import { registerTool } from "../lib/tool/log.js";
import { readOnlyAnnotations, withToolAuth } from "../lib/tool/meta.js";
import { okResult } from "../lib/tool/result.js";
import { TOOL_NAMES } from "./names.js";

const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1_000).toISOString();
const TOOLSET_HASH = buildToolsetHash();

function buildToolsetHash(): string {
    const hash = createHash("sha256").update(PACKAGE_VERSION).update("\0");
    try {
        const toolDir = dirname(fileURLToPath(import.meta.url));
        const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
        const files = readdirSync(toolDir)
            .filter((name) => name.endsWith(extension))
            .sort();
        for (const name of files) {
            hash.update(name).update("\0").update(readFileSync(`${toolDir}/${name}`)).update("\0");
        }
    } catch {
        hash.update(TOOL_NAMES.join("\n"));
    }
    return hash.digest("hex").slice(0, 16);
}

export function registerServerInfoTool(server: McpServer, project: ProjectContext): void {
    registerTool(
        server,
        "server_info",
        withToolAuth({
            title: "Read server info",
            description:
                "Return the running codex-mcp version, process start time, bound project root, and core toolset fingerprint. Use when a connector may still be attached to an older process/schema.",
            inputSchema: {},
            outputSchema: {
                version: z.string(),
                startedAt: z.string(),
                pid: z.number().int(),
                projectRoot: z.string(),
                toolsetHash: z.string(),
                toolCount: z.number().int(),
                restartRequiredForCoreToolChanges: z.boolean(),
                capabilities: z.object({
                    applyPatch: z.boolean(),
                    structuredSearch: z.boolean(),
                    commandCwd: z.boolean(),
                    mutationDiff: z.boolean(),
                }),
            },
            annotations: readOnlyAnnotations,
        }),
        async () =>
            okResult(`codex-mcp ${PACKAGE_VERSION} · ${TOOL_NAMES.length} registered tool name(s).`, {
                version: PACKAGE_VERSION,
                startedAt: PROCESS_STARTED_AT,
                pid: process.pid,
                projectRoot: project.root,
                toolsetHash: TOOLSET_HASH,
                toolCount: TOOL_NAMES.length,
                restartRequiredForCoreToolChanges: true,
                capabilities: {
                    applyPatch: TOOL_NAMES.includes("apply_patch"),
                    structuredSearch: true,
                    commandCwd: true,
                    mutationDiff: true,
                },
            }),
    );
}

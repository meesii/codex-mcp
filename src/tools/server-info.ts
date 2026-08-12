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
const STARTUP_TOOLSET_HASH = buildToolsetHash();

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
                "Return the running codex-mcp version, process start time, primary/additional workspace roots, startup/disk core toolset fingerprints, and whether a restart is recommended because core tool source changed on disk after this process started.",
            inputSchema: {},
            outputSchema: {
                version: z.string(),
                startedAt: z.string(),
                pid: z.number().int(),
                projectRoot: z.string(),
                workspaceRoots: z.array(z.string()),
                toolsetHash: z.string(),
                diskToolsetHash: z.string(),
                toolCount: z.number().int(),
                restartRequiredForCoreToolChanges: z.boolean(),
                restartRecommended: z.boolean(),
                capabilities: z.object({
                    applyPatch: z.boolean(),
                    structuredSearch: z.boolean(),
                    commandCwd: z.boolean(),
                    mutationDiff: z.boolean(),
                    externalReads: z.boolean(),
                    externalAuthorization: z.boolean(),
                }),
            },
            annotations: readOnlyAnnotations,
        }),
        async () => {
            const diskToolsetHash = buildToolsetHash();
            const restartRecommended = diskToolsetHash !== STARTUP_TOOLSET_HASH;
            return okResult(
                restartRecommended
                    ? `codex-mcp ${PACKAGE_VERSION} · core tool source changed on disk; restart recommended.`
                    : `codex-mcp ${PACKAGE_VERSION} · ${TOOL_NAMES.length} registered tool name(s).`,
                {
                    version: PACKAGE_VERSION,
                    startedAt: PROCESS_STARTED_AT,
                    pid: process.pid,
                    projectRoot: project.root,
                    workspaceRoots: project.roots,
                    toolsetHash: STARTUP_TOOLSET_HASH,
                    diskToolsetHash,
                    toolCount: TOOL_NAMES.length,
                    restartRequiredForCoreToolChanges: true,
                    restartRecommended,
                    capabilities: {
                        applyPatch: TOOL_NAMES.includes("apply_patch"),
                        structuredSearch: true,
                        commandCwd: true,
                        mutationDiff: true,
                        externalReads: true,
                        externalAuthorization: TOOL_NAMES.includes("permission_grant"),
                    },
                },
            );
        },
    );
}

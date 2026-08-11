import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerTool } from "../lib/tool-log.js";
import {
    readOnlyAnnotations,
    stateWriteAnnotations,
    withToolAuth,
} from "../lib/tool-meta.js";
import { errorResult, okResult } from "../lib/tool-result.js";
import {
    DEFAULT_UI_PREFERENCES,
    type UiSettingsStore,
} from "../ui/settings.js";

const uiSchema = z.object({
    tools: z.boolean(),
    status: z.boolean(),
});

const appCallableMeta = {
    ui: {
        visibility: ["model", "app"],
    },
    // Compatibility bit for existing ChatGPT widget runtimes.
    "openai/widgetAccessible": true,
};

/** Register ChatGPT-facing local UI preference tools. */
export function registerSettingsTools(
    server: McpServer,
    settings: UiSettingsStore,
): void {
    registerTool(
        server,
        "settings_get",
        withToolAuth({
            title: "Open codex-mcp settings",
            description:
                "Open/read codex-mcp display settings. Use when the user asks to open settings or control whether custom MCP UI cards appear in ChatGPT. The settings card itself always remains available.",
            inputSchema: {},
            outputSchema: {
                ui: uiSchema,
                defaults: uiSchema,
            },
            annotations: readOnlyAnnotations,
            _meta: appCallableMeta,
        }),
        async () => {
            try {
                const ui = settings.get();
                return okResult(
                    `UI settings: ordinary tools ${ui.tools ? "on" : "off"}; status ${ui.status ? "on" : "off"}.`,
                    {
                        ui,
                        defaults: { ...DEFAULT_UI_PREFERENCES },
                    },
                );
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );

    registerTool(
        server,
        "settings_update",
        withToolAuth({
            title: "Update codex-mcp settings",
            description:
                "Persist ChatGPT-facing UI settings. `tools` controls ordinary coding tool cards; `status` controls Summary and Goal cards. The settings panel always remains available. Call with no arguments to request a tool-list refresh without changing settings. Every successful call sends the standard tools/list_changed notification so capable clients refresh tool metadata.",
            inputSchema: {
                tools: z
                    .boolean()
                    .optional()
                    .describe("Show custom UI cards for ordinary coding tools."),
                status: z
                    .boolean()
                    .optional()
                    .describe("Show custom Summary and Goal status cards."),
            },
            outputSchema: {
                ui: uiSchema,
                toolListChangedRequested: z.boolean(),
            },
            annotations: stateWriteAnnotations,
            _meta: appCallableMeta,
        }),
        async ({ tools, status }) => {
            try {
                if (tools === undefined && status === undefined) {
                    return errorResult("Provide at least one setting: tools or status.");
                }
                const ui = settings.update({ tools, status });
                // Descriptor metadata changed. The next stateless MCP request builds
                // tools from the fresh preference snapshot; ask the host to re-list.
                await Promise.resolve(server.sendToolListChanged());
                return okResult(
                    `Saved UI settings: ordinary tools ${ui.tools ? "on" : "off"}; status ${ui.status ? "on" : "off"}.`,
                    {
                        ui,
                        toolListChangedRequested: true,
                    },
                );
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );
}

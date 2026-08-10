import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { SkillRegistry } from "../skills/registry.js";
import { registerTool } from "../lib/tool-log.js";
import { readOnlyAnnotations, withToolAuth } from "../lib/tool-meta.js";
import { errorResult, okResult } from "../lib/tool-result.js";

const skillInfoSchema = z.object({
    name: z.string(),
    description: z.string(),
    source: z.enum(["agents", "codex"]),
});

/** Register Codex skill discovery/read tools. */
export function registerSkillTools(server: McpServer, skills: SkillRegistry): void {
    registerTool(
        server,
        "skills_list",
        withToolAuth({
            title: "List Codex skills",
            description:
                "List skills imported from the local Codex skill roots. Use skill_read before following a skill that matches the current task.",
            inputSchema: {},
            outputSchema: {
                count: z.number().int(),
                skills: z.array(skillInfoSchema),
            },
            annotations: readOnlyAnnotations,
        }),
        async () => {
            const listed = skills.list();
            return okResult(`Listed ${listed.length} Codex skill(s).`, {
                count: listed.length,
                skills: listed,
            });
        },
    );

    registerTool(
        server,
        "skill_read",
        withToolAuth({
            title: "Read Codex skill",
            description:
                "Read SKILL.md or another text file inside a discovered Codex skill. path defaults to SKILL.md and must stay inside that skill directory.",
            inputSchema: {
                name: z.string().min(1).describe("Skill name from skills_list."),
                path: z
                    .string()
                    .min(1)
                    .optional()
                    .describe("Relative file inside the skill, default SKILL.md."),
            },
            outputSchema: {
                name: z.string(),
                path: z.string(),
                content: z.string(),
                truncated: z.boolean(),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({ name, path }) => {
            try {
                const result = skills.read(name, path);
                return okResult(
                    `Read ${result.name}/${result.path}${result.truncated ? " (truncated)" : ""}.`,
                    { ...result },
                );
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );
}

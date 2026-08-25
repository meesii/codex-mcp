import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { SkillRegistry } from "../skills/registry.js";
import { registerTool } from "../lib/tool/log.js";
import { readOnlyAnnotations, withToolAuth } from "../lib/tool/meta.js";
import { errorResult, okResult } from "../lib/tool/result.js";

const skillInfoSchema = z.object({
    name: z.string(),
    description: z.string(),
    source: z.enum(["agents", "codex", "claude"]),
    scope: z.enum(["user", "project"]).optional(),
    workspaceRoot: z.string().optional(),
});

export function registerSkillTools(server: McpServer, skills: SkillRegistry): void {
    registerTool(
        server,
        "skills_list",
        withToolAuth({
            title: "List imported skills",
            description: "List the skills enabled from external capability sources.",
            inputSchema: {},
            outputSchema: {
                text: z.string(), count: z.number().int(),
                skills: z.array(skillInfoSchema),
            },
            annotations: readOnlyAnnotations,
        }),
        async () => {
            const listed = skills.list();
            const text = listed.length ? listed.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n") : "No skills enabled.";
            return okResult(text, { text, count: listed.length, skills: listed });
        },
    );

    registerTool(
        server,
        "skill_read",
        withToolAuth({
            title: "Read imported skill",
            description: "Read the full SKILL.md body of one enabled skill.",
            inputSchema: {
                name: z.string().min(1).describe("Skill name from skills_list."),
            },
            outputSchema: {
                text: z.string(), name: z.string(),
                description: z.string(), source: z.enum(["agents", "codex", "claude"]),
                path: z.string(),
                content: z.string(),
                truncated: z.boolean(),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({ name }) => {
            try {
                const info = skills.list().find((skill) => skill.name === name);
                if (!info) return errorResult(`Unknown skill: ${name}`);
                const result = skills.read(name);
                return okResult(result.content, { text: result.content, ...info, path: result.path, content: result.content, truncated: result.truncated });
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );
}

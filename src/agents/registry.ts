import {
    existsSync,
    lstatSync,
    readFileSync,
    realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ProjectContext } from "../project.js";

const MAX_AGENT_FILE_CHARS = 50_000;
const MAX_COMBINED_AGENT_CHARS = 100_000;
const MAX_SCOPED_FILES = 32;

export interface AgentInstructionFile {
    path: string;
    source: "global" | "project";
    content: string;
    truncated: boolean;
}

/**
 * Resolve Codex AGENTS.md instructions for the bound project.
 *
 * Global `~/.codex/AGENTS.md` always applies. Project AGENTS.md files are
 * discovered along the directory chain from project root to a requested path,
 * so deeper files naturally add more-specific instructions without scanning
 * the whole workspace.
 */
export class AgentInstructionRegistry {
    private readonly globalAgentsPath: string;

    constructor(
        private readonly project: ProjectContext,
        homeDirectory = homedir(),
    ) {
        this.globalAgentsPath = join(homeDirectory, ".codex", "AGENTS.md");
    }

    /** Instructions that apply to the project root itself (used at initialize). */
    buildInstructionsBlock(): string {
        const files = this.forPath(".");
        if (files.length === 0) return "";
        return [
            "Inherited Codex AGENTS.md instructions (follow these local project rules):",
            ...files.flatMap((file) => [
                `<agents path="${escapeAttribute(file.path)}">`,
                file.content,
                "</agents>",
            ]),
            "For work below nested directories, use agents_for_path to load any more-specific AGENTS.md files before changing code.",
        ].join("\n");
    }

    /** Return global + project AGENTS.md files applicable to a project path. */
    forPath(inputPath = "."): AgentInstructionFile[] {
        const files: AgentInstructionFile[] = [];
        let remaining = MAX_COMBINED_AGENT_CHARS;

        const global = this.readInstructionFile(
            this.globalAgentsPath,
            "~/.codex/AGENTS.md",
            "global",
            remaining,
        );
        if (global) {
            files.push(global);
            remaining -= global.content.length;
        }

        const resolved = this.project.resolvePath(inputPath || ".");
        const targetDirectory = existingDirectoryForPath(resolved);
        const relationship = relative(this.project.root, targetDirectory);
        const segments = relationship
            ? relationship.split(sep).filter(Boolean)
            : [];

        let current = this.project.root;
        const projectCandidates = [join(current, "AGENTS.md")];
        for (const segment of segments.slice(0, MAX_SCOPED_FILES - 1)) {
            current = join(current, segment);
            projectCandidates.push(join(current, "AGENTS.md"));
        }

        for (const candidate of projectCandidates) {
            if (remaining <= 0) break;
            const file = this.readProjectInstructionFile(candidate, remaining);
            if (!file) continue;
            files.push(file);
            remaining -= file.content.length;
        }
        return files;
    }

    private readProjectInstructionFile(
        pathValue: string,
        remaining: number,
    ): AgentInstructionFile | undefined {
        if (!existsSync(pathValue)) return undefined;
        let canonical: string;
        try {
            canonical = realpathSync.native(pathValue);
        } catch {
            return undefined;
        }
        if (!isInside(this.project.root, canonical)) return undefined;
        const display = relative(this.project.root, canonical).replaceAll("\\", "/") || "AGENTS.md";
        return this.readInstructionFile(canonical, display, "project", remaining);
    }

    private readInstructionFile(
        pathValue: string,
        displayPath: string,
        source: AgentInstructionFile["source"],
        remaining: number,
    ): AgentInstructionFile | undefined {
        if (remaining <= 0 || !existsSync(pathValue)) return undefined;
        try {
            if (!lstatSync(pathValue).isFile()) return undefined;
            const raw = readFileSync(pathValue, "utf8");
            if (raw.includes("\0")) return undefined;
            const limit = Math.min(MAX_AGENT_FILE_CHARS, remaining);
            const truncated = raw.length > limit;
            return {
                path: displayPath,
                source,
                content: truncated ? raw.slice(0, limit) : raw,
                truncated,
            };
        } catch {
            return undefined;
        }
    }
}

function existingDirectoryForPath(pathValue: string): string {
    let candidate = resolve(pathValue);
    try {
        const info = lstatSync(candidate);
        return info.isDirectory() ? candidate : dirname(candidate);
    } catch {
        return dirname(candidate);
    }
}

function isInside(root: string, candidate: string): boolean {
    const relationship = relative(root, candidate);
    return (
        relationship === "" ||
        (relationship !== ".." && !relationship.startsWith(`..${sep}`))
    );
}

function escapeAttribute(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

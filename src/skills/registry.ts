import {
    existsSync,
    readFileSync,
    readdirSync,
    realpathSync,
    statSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_SKILL_FILE_CHARS = 80_000;

export type SkillSource = "agents" | "codex" | "claude";
export type SkillScope = "user" | "project";

export interface SkillInfo {
    name: string;
    description: string;
    source: SkillSource;
    scope?: SkillScope;
    workspaceRoot?: string;
}

export interface SkillFileResult {
    name: string;
    path: string;
    content: string;
    truncated: boolean;
}

interface SkillEntry extends SkillInfo {
    root: string;
}

export interface SkillRoot {
    path: string;
    source: SkillSource;
    scope?: SkillScope;
    workspaceRoot?: string;
    /** Prefix model-facing names for secondary workspace scoped skills. */
    namePrefix?: string;
    /** Respect Claude's disable-model-invocation frontmatter by hiding such skills. */
    respectModelInvocation?: boolean;
}

export class SkillRegistry {
    private readonly skills = new Map<string, SkillEntry>();
    private readonly claudeUserSkillNames = new Set<string>();
    private roots: SkillRoot[];
    private generation = 0;

    private constructor(roots: SkillRoot[]) {
        this.roots = roots.map((root) => ({ ...root }));
    }

    static empty(): SkillRegistry {
        return new SkillRegistry([]);
    }

    /** Compatibility default used by tests/embedders that do not create a CapabilityManager. */
    static discoverDefault(): SkillRegistry {
        return SkillRegistry.discover([
            { path: join(homedir(), ".agents", "skills"), source: "agents", scope: "user" },
            { path: join(homedir(), ".codex", "skills"), source: "codex", scope: "user" },
        ]);
    }

    static discover(roots: SkillRoot[]): SkillRegistry {
        const registry = new SkillRegistry(roots);
        registry.refresh();
        return registry;
    }

    setRoots(roots: SkillRoot[]): void {
        this.roots = roots.map((root) => ({ ...root }));
    }

    refresh(): { generation: number; count: number } {
        this.skills.clear();
        this.claudeUserSkillNames.clear();
        for (const root of this.roots) {
            this.discoverRoot(root);
        }
        this.generation += 1;
        return { generation: this.generation, count: this.skills.size };
    }

    getGeneration(): number {
        return this.generation;
    }

    getRoots(): SkillRoot[] {
        return this.roots.map((root) => ({ ...root }));
    }

    hasSkills(): boolean {
        return this.skills.size > 0;
    }

    list(): SkillInfo[] {
        return [...this.skills.values()]
            .map(({ name, description, source, scope, workspaceRoot }) => ({
                name,
                description,
                source,
                ...(scope ? { scope } : {}),
                ...(workspaceRoot ? { workspaceRoot } : {}),
            }))
            .sort((left, right) => left.name.localeCompare(right.name));
    }

    buildInstructionsBlock(): string {
        const skills = this.list();
        if (skills.length === 0) return "";
        return [
            "Imported skills (read a matching skill with skill_read before following it):",
            ...skills.map((skill) => {
                const scope = skill.workspaceRoot ? ` [workspace ${skill.workspaceRoot}]` : "";
                return `- ${skill.name}${scope} — ${clipOneLine(skill.description || "No description", 220)}`;
            }),
        ].join("\n");
    }

    read(name: string, path = "SKILL.md"): SkillFileResult {
        const entry = this.skills.get(name.trim());
        if (!entry) {
            const known = this.list().map((skill) => skill.name);
            const hint = known.length > 0 ? `known: ${known.join(", ")}` : "none discovered";
            throw new Error(`unknown skill "${name}" (${hint})`);
        }

        const relativePath = normalizeSkillRelativePath(path);
        const requested = resolve(entry.root, relativePath);
        let canonical: string;
        try {
            canonical = realpathSync.native(requested);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                throw new Error(`skill file not found: ${entry.name}/${relativePath}`);
            }
            throw error;
        }
        if (!isInside(entry.root, canonical)) {
            throw new Error(`skill path escapes ${entry.name}: ${relativePath}`);
        }
        if (!statSync(canonical).isFile()) {
            throw new Error(`skill path is not a file: ${entry.name}/${relativePath}`);
        }

        const raw = readFileSync(canonical, "utf8");
        if (raw.includes("\0")) {
            throw new Error(`skill file is not text: ${entry.name}/${relativePath}`);
        }
        const truncated = raw.length > MAX_SKILL_FILE_CHARS;
        return {
            name: entry.name,
            path: relativePath,
            content: truncated ? raw.slice(0, MAX_SKILL_FILE_CHARS) : raw,
            truncated,
        };
    }

    private discoverRoot(root: SkillRoot): void {
        if (!existsSync(root.path)) return;
        let names: string[];
        try {
            names = readdirSync(root.path);
        } catch {
            return;
        }

        for (const directoryName of names.sort()) {
            if (directoryName === ".system") {
                this.discoverSystemSkills(join(root.path, directoryName), root);
                continue;
            }
            if (directoryName.startsWith(".")) continue;
            this.discoverSkillDirectory(join(root.path, directoryName), directoryName, root);
        }
    }

    private discoverSystemSkills(systemRoot: string, root: SkillRoot): void {
        let names: string[];
        try {
            names = readdirSync(systemRoot);
        } catch {
            return;
        }
        for (const directoryName of names.sort()) {
            if (directoryName.startsWith(".")) continue;
            this.discoverSkillDirectory(join(systemRoot, directoryName), directoryName, root);
        }
    }

    private discoverSkillDirectory(
        skillLink: string,
        directoryName: string,
        root: SkillRoot,
    ): void {
        const skillFile = join(skillLink, "SKILL.md");
        if (!existsSync(skillFile)) return;

        let canonicalRoot: string;
        let contents: string;
        try {
            canonicalRoot = realpathSync.native(skillLink);
            if (!statSync(canonicalRoot).isDirectory()) return;
            contents = readFileSync(skillFile, "utf8");
        } catch {
            return;
        }

        const metadata = parseSkillMetadata(contents, directoryName);
        if (root.source === "claude") {
            if (root.scope === "project" && this.claudeUserSkillNames.has(metadata.name)) return;
            if (root.scope === "user") this.claudeUserSkillNames.add(metadata.name);
        }
        if (
            root.respectModelInvocation &&
            (!metadata.modelInvocable || !metadata.portableModelInvocation)
        ) {
            return;
        }
        const name = `${root.namePrefix ?? ""}${metadata.name}`;
        if (this.skills.has(name)) return;
        this.skills.set(name, {
            name,
            description: metadata.description,
            source: root.source,
            ...(root.scope ? { scope: root.scope } : {}),
            ...(root.workspaceRoot ? { workspaceRoot: root.workspaceRoot } : {}),
            root: canonicalRoot,
        });
    }
}

interface ParsedSkillMetadata {
    name: string;
    description: string;
    modelInvocable: boolean;
    portableModelInvocation: boolean;
}

function parseSkillMetadata(contents: string, fallbackName: string): ParsedSkillMetadata {
    const lines = contents.replaceAll("\r\n", "\n").split("\n");
    if (lines[0]?.trim() !== "---") {
        return {
            name: fallbackName,
            description: "",
            modelInvocable: true,
            portableModelInvocation: true,
        };
    }

    let name = fallbackName;
    let description = "";
    let whenToUse = "";
    let modelInvocable = true;
    let portableModelInvocation = true;
    for (let index = 1; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (line.trim() === "---") break;
        const nameMatch = line.match(/^name:\s*(.*)$/);
        if (nameMatch) {
            name = unquoteYamlScalar(nameMatch[1]!.trim()) || fallbackName;
            continue;
        }
        const disableMatch = line.match(/^disable-model-invocation:\s*(.*)$/);
        if (disableMatch) {
            modelInvocable = !parseYamlBoolean(disableMatch[1]!.trim(), false);
            continue;
        }
        const allowedToolsMatch = line.match(/^allowed-tools:\s*(.*)$/);
        if (allowedToolsMatch) {
            // Claude can restrict the tool surface while a skill runs. codex-mcp cannot
            // currently reproduce that per-skill sandbox, so do not auto-expose it.
            portableModelInvocation = false;
            continue;
        }
        const hooksMatch = line.match(/^hooks:\s*(.*)$/);
        if (hooksMatch) {
            portableModelInvocation = false;
            continue;
        }
        const contextMatch = line.match(/^context:\s*(.*)$/);
        if (contextMatch && unquoteYamlScalar(contextMatch[1]!.trim()).toLowerCase() === "fork") {
            portableModelInvocation = false;
            continue;
        }
        const agentMatch = line.match(/^agent:\s*(.*)$/);
        if (agentMatch && unquoteYamlScalar(agentMatch[1]!.trim())) {
            portableModelInvocation = false;
            continue;
        }
        const descriptionMatch = line.match(/^(description|when_to_use):\s*(.*)$/);
        if (!descriptionMatch) continue;
        const key = descriptionMatch[1]!;
        const scalar = descriptionMatch[2]!.trim();
        let parsed: string;
        if (scalar !== ">" && scalar !== "|") {
            parsed = unquoteYamlScalar(scalar);
        } else {
            const folded: string[] = [];
            while (index + 1 < lines.length) {
                const next = lines[index + 1]!;
                if (!/^\s+/.test(next)) break;
                index += 1;
                folded.push(next.trim());
            }
            parsed = scalar === ">" ? folded.join(" ") : folded.join("\n");
        }
        if (key === "description") description = parsed;
        else whenToUse = parsed;
    }
    if (/!`[^`\n]+`/.test(contents)) {
        // Claude executes dynamic context commands before the model sees the skill.
        // Returning the literal syntax would change semantics, so fail closed.
        portableModelInvocation = false;
    }
    if (whenToUse) description = description ? `${description} ${whenToUse}` : whenToUse;
    return { name, description, modelInvocable, portableModelInvocation };
}

function parseYamlBoolean(value: string, fallback: boolean): boolean {
    const normalized = unquoteYamlScalar(value).trim().toLowerCase();
    if (["true", "yes", "on", "1"].includes(normalized)) return true;
    if (["false", "no", "off", "0"].includes(normalized)) return false;
    return fallback;
}

function unquoteYamlScalar(value: string): string {
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
        return value.slice(1, -1).replaceAll("''", "'");
    }
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        try {
            return JSON.parse(value) as string;
        } catch {
            return value.slice(1, -1);
        }
    }
    return value;
}

function normalizeSkillRelativePath(value: string): string {
    const trimmed = value.trim() || "SKILL.md";
    if (isAbsolute(trimmed)) throw new Error("skill path must be relative");
    const normalized = trimmed.replaceAll("\\", "/");
    if (
        normalized === ".." ||
        normalized.startsWith("../") ||
        normalized.includes("/../")
    ) {
        throw new Error("skill path must stay inside the skill directory");
    }
    return normalized;
}

function isInside(root: string, candidate: string): boolean {
    const relationship = relative(root, candidate);
    return (
        relationship === "" ||
        (!isAbsolute(relationship) &&
            relationship !== ".." &&
            !relationship.startsWith(`..${sep}`))
    );
}

function clipOneLine(value: string, maxChars: number): string {
    const oneLine = value.replace(/\s+/g, " ").trim();
    if (oneLine.length <= maxChars) return oneLine;
    return `${oneLine.slice(0, maxChars - 1)}…`;
}

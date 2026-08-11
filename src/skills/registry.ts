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

export type SkillSource = "agents" | "codex";

export interface SkillInfo {
    name: string;
    description: string;
    source: SkillSource;
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
}

export class SkillRegistry {
    private readonly skills = new Map<string, SkillEntry>();
    private generation = 0;

    private constructor(private readonly roots: SkillRoot[]) {}

    static empty(): SkillRegistry {
        return new SkillRegistry([]);
    }

    static discoverDefault(): SkillRegistry {
        return SkillRegistry.discover([
            { path: join(homedir(), ".agents", "skills"), source: "agents" },
            { path: join(homedir(), ".codex", "skills"), source: "codex" },
        ]);
    }

    static discover(roots: SkillRoot[]): SkillRegistry {
        const registry = new SkillRegistry(roots.map((root) => ({ ...root })));
        registry.refresh();
        return registry;
    }

    refresh(): { generation: number; count: number } {
        this.skills.clear();
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
            .map(({ name, description, source }) => ({ name, description, source }))
            .sort((left, right) => left.name.localeCompare(right.name));
    }

    buildInstructionsBlock(): string {
        const skills = this.list();
        if (skills.length === 0) return "";
        return [
            "Codex skills (read matching skills with skill_read before following them):",
            ...skills.map(
                (skill) =>
                    `- ${skill.name} — ${clipOneLine(skill.description || "No description", 220)}`,
            ),
        ].join("\n");
    }

    read(name: string, path = "SKILL.md"): SkillFileResult {
        const entry = this.skills.get(name.trim());
        if (!entry) {
            const known = this.list().map((skill) => skill.name);
            const hint = known.length > 0 ? `known: ${known.join(", ")}` : "none discovered";
            throw new Error(`unknown Codex skill "${name}" (${hint})`);
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
                this.discoverSystemSkills(join(root.path, directoryName), root.source);
                continue;
            }
            if (directoryName.startsWith(".")) continue;
            this.discoverSkillDirectory(join(root.path, directoryName), directoryName, root.source);
        }
    }

    private discoverSystemSkills(systemRoot: string, source: SkillSource): void {
        let names: string[];
        try {
            names = readdirSync(systemRoot);
        } catch {
            return;
        }
        for (const directoryName of names.sort()) {
            if (directoryName.startsWith(".")) continue;
            this.discoverSkillDirectory(join(systemRoot, directoryName), directoryName, source);
        }
    }

    private discoverSkillDirectory(
        skillLink: string,
        directoryName: string,
        source: SkillSource,
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
        if (this.skills.has(metadata.name)) return;
        this.skills.set(metadata.name, {
            ...metadata,
            source,
            root: canonicalRoot,
        });
    }
}

function parseSkillMetadata(
    contents: string,
    fallbackName: string,
): Pick<SkillInfo, "name" | "description"> {
    const lines = contents.replaceAll("\r\n", "\n").split("\n");
    if (lines[0]?.trim() !== "---") {
        return { name: fallbackName, description: "" };
    }

    let name = fallbackName;
    let description = "";
    for (let index = 1; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (line.trim() === "---") break;
        const nameMatch = line.match(/^name:\s*(.*)$/);
        if (nameMatch) {
            name = unquoteYamlScalar(nameMatch[1]!.trim()) || fallbackName;
            continue;
        }
        const descriptionMatch = line.match(/^description:\s*(.*)$/);
        if (!descriptionMatch) continue;

        const scalar = descriptionMatch[1]!.trim();
        if (scalar !== ">" && scalar !== "|") {
            description = unquoteYamlScalar(scalar);
            continue;
        }

        const folded: string[] = [];
        while (index + 1 < lines.length) {
            const next = lines[index + 1]!;
            if (!/^\s+/.test(next)) break;
            index += 1;
            folded.push(next.trim());
        }
        description = scalar === ">" ? folded.join(" ") : folded.join("\n");
    }
    return { name, description };
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

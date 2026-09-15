import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { promisify } from "node:util";
import { detectProjectDisplayName } from "../projects/identity.js";
import { expandHomePath } from "../config/loader.js";
import { loadProjectsFile, type RegisteredProject, type SessionBinding } from "../daemon/state.js";

const execute = promisify(execFile);
let pickerOpen = false;

export async function validateProjectFolder(input: string): Promise<string> {
    if (!input.trim()) throw new Error("请选择一个项目文件夹。");
    try {
        const path = await realpath(resolve(expandHomePath(input.trim())));
        if (!(await stat(path)).isDirectory()) throw new Error("not a directory");
        await access(path, constants.R_OK | (process.platform === "win32" ? 0 : constants.X_OK));
        return path;
    } catch (error) {
        if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
            throw new Error("没有访问这个文件夹的权限，请选择其他文件夹或调整权限。");
        }
        throw new Error("文件夹不存在或无法读取，请重新选择。");
    }
}

/** Only fixed commands are launched; request data is never inserted into a script. */
export async function chooseProjectFolder(signal?: AbortSignal): Promise<{ path?: string; cancelled?: boolean; unavailable?: boolean }> {
    if (pickerOpen) throw new Error("文件夹选择窗口已经打开，请先完成选择。");
    pickerOpen = true;
    try {
        const commands = process.platform === "darwin"
            ? [{ file: "/usr/bin/osascript", args: ["-e", 'try\nreturn POSIX path of (choose folder with prompt "选择要添加的项目文件夹")\non error number -128\nreturn ""\nend try'] }]
            : process.platform === "win32"
                ? [{ file: "powershell.exe", args: ["-NoProfile", "-STA", "-Command", "Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description = 'Select a project folder'; if ($picker.ShowDialog() -eq 'OK') { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output $picker.SelectedPath }; $picker.Dispose()"] }]
                : process.platform === "linux" && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
                    ? [{ file: "zenity", args: ["--file-selection", "--directory", "--title=选择项目文件夹"] }, { file: "kdialog", args: ["--getexistingdirectory", homedir(), "--title", "选择项目文件夹"] }]
                    : [];
        for (const command of commands) {
            try {
                const { stdout } = await execute(command.file, command.args, { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024, signal });
                const selected = stdout.trim();
                return selected ? { path: await validateProjectFolder(selected) } : { cancelled: true };
            } catch (error) {
                signal?.throwIfAborted();
                const code = (error as NodeJS.ErrnoException).code;
                if (process.platform === "linux" && Number(code) === 1) return { cancelled: true };
                if (code === "ENOENT") continue;
                return { unavailable: true };
            }
        }
        return { unavailable: true };
    } finally { pickerOpen = false; }
}

export interface ProjectSuggestion { name: string; path: string; source: "recent" | "discovered"; }

export async function suggestProjects(options: { home?: string; projects?: RegisteredProject[] } = {}): Promise<ProjectSuggestion[]> {
    const home = options.home ?? homedir();
    const projects = options.projects ?? loadProjectsFile();
    const pathKey = (path: string) => process.platform === "win32" ? normalize(path).toLocaleLowerCase("en-US") : path;
    const known = new Set<string>();
    await Promise.all(projects.filter((item) => item.active).map(async (item) => {
        try { known.add(pathKey(await realpath(item.path))); } catch { /* Stale active entries do not block discovery. */ }
    }));
    const suggestions: ProjectSuggestion[] = [];
    async function append(path: string, source: ProjectSuggestion["source"]): Promise<void> {
        try {
            const canonical = await realpath(path);
            const key = pathKey(canonical);
            if (known.has(key) || !(await stat(canonical)).isDirectory()) return;
            known.add(key);
            suggestions.push({ name: detectProjectDisplayName(canonical), path: canonical, source });
        } catch { /* A stale or inaccessible candidate is not actionable. */ }
    }
    for (const project of [...projects].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))) {
        if (suggestions.length >= 20) break;
        if (!project.active) await append(project.path, "recent");
    }
    // Deliberately shallow and bounded: no recursive scan of a user's home.
    for (const folder of ["workspace", "workspaces", "Projects", "projects", "code", "Developer", "repos"]) {
        if (suggestions.length >= 20) break;
        try {
            const directory = await opendir(join(home, folder));
            let visited = 0;
            for await (const entry of directory) {
                if (++visited > 100 || suggestions.length >= 20) break;
                if (!entry.isDirectory() || entry.name.startsWith(".") || ["node_modules", "dist", "vendor"].includes(entry.name)) continue;
                const candidate = join(home, folder, entry.name);
                const markers = await Promise.all([".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"].map((marker) => access(join(candidate, marker)).then(() => true, () => false)));
                if (markers.some(Boolean)) await append(candidate, "discovered");
            }
        } catch { /* Conventional directories are optional. */ }
    }
    return suggestions;
}

export function bindingPresentationId(ownerKey: string): string {
    return createHash("sha256").update(ownerKey).digest("hex").slice(0, 32);
}

export function presentBindings(bindings: SessionBinding[]) {
    return bindings.map((binding) => ({
        id: bindingPresentationId(binding.ownerKey),
        projectId: binding.projectId,
        label: binding.ownerKey.includes("|openai-session:") ? "ChatGPT 会话" : "客户端会话",
        lastSeenAt: binding.lastSeenAt,
    })).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

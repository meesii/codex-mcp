import { homedir } from "node:os";
import { join } from "node:path";

export type ManagedToolName = "ripgrep" | "cloudflared";

/** Directory owned by codex-mcp for small runtime binaries. */
export function getManagedBinDir(): string {
    return join(homedir(), ".codex-mcp", "bin");
}

/** Absolute path of a managed runtime binary. */
export function getManagedToolPath(tool: ManagedToolName): string {
    const base = tool === "ripgrep" ? "rg" : "cloudflared";
    const fileName = process.platform === "win32" ? `${base}.exe` : base;
    return join(getManagedBinDir(), fileName);
}

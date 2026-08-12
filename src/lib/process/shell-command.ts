import { existsSync } from "node:fs";
import { win32 } from "node:path";

export function resolveWindowsPowerShell(
    env: NodeJS.ProcessEnv = process.env,
    fileExists: (path: string) => boolean = existsSync,
): string {
    const pathValue = env.Path ?? env.PATH ?? "";
    for (const rawEntry of pathValue.split(win32.delimiter)) {
        const entry = rawEntry.trim().replace(/^"|"$/g, "");
        if (!entry) continue;
        if (fileExists(win32.join(entry, "pwsh.exe"))) return "pwsh.exe";
    }

    // Windows PowerShell 5.1 is the same baseline used by the installer and
    // updater, so PowerShell 7 remains an optional preference rather than an
    // undocumented runtime prerequisite.
    return "powershell.exe";
}

export function commandShell(command: string): {
    file: string;
    args: string[];
    isWindows: boolean;
} {
    const isWindows = process.platform === "win32";
    return {
        file: isWindows ? resolveWindowsPowerShell() : "/bin/bash",
        args: isWindows ? ["-NoProfile", "-Command", command] : ["-c", command],
        isWindows,
    };
}

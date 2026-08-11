export function commandShell(command: string): {
    file: string;
    args: string[];
    isWindows: boolean;
} {
    const isWindows = process.platform === "win32";
    return {
        file: isWindows ? "pwsh" : "/bin/bash",
        args: isWindows ? ["-NoProfile", "-Command", command] : ["-c", command],
        isWindows,
    };
}

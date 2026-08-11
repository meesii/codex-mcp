import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { printInfo } from "../lib/util/terminal.js";

export interface UpdateInstallerInvocation {
    file: string;
    args: string[];
    scriptPath: string;
}

export function getUpdateInstallerInvocation(
    platform: NodeJS.Platform = process.platform,
): UpdateInstallerInvocation {
    if (platform === "win32") {
        const scriptPath = fileURLToPath(new URL("../scripts/install.ps1", import.meta.url));
        return {
            file: "powershell.exe",
            args: [
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                scriptPath,
            ],
            scriptPath,
        };
    }

    if (platform === "darwin" || platform === "linux") {
        const scriptPath = fileURLToPath(new URL("../scripts/install.sh", import.meta.url));
        return {
            file: "sh",
            args: [scriptPath],
            scriptPath,
        };
    }

    throw new Error(`当前系统暂不支持自动更新：${platform}`);
}

export async function runSelfUpdate(): Promise<void> {
    const invocation = getUpdateInstallerInvocation();
    try {
        await access(invocation.scriptPath);
    } catch {
        throw new Error(
            "当前安装缺少更新组件。请重新运行一次安装脚本，之后即可使用 `codex-mcp update`。",
        );
    }

    printInfo("正在检查并安装最新版 codex-mcp…");
    const exitCode = await runInstaller(invocation);
    if (exitCode !== 0) {
        throw new Error(`更新没有完成（退出码 ${exitCode}）`);
    }
}

async function runInstaller(invocation: UpdateInstallerInvocation): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
        const child = spawn(invocation.file, invocation.args, {
            env: {
                ...process.env,
                CODEX_MCP_UPDATE: "1",
            },
            stdio: "inherit",
            windowsHide: false,
            shell: false,
        });
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
    });
}

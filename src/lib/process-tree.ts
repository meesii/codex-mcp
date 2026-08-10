import { spawn, type ChildProcess } from "node:child_process";

const TASKKILL_TIMEOUT_MS = 5_000;

/** Signal a shell process tree rather than only the immediate shell process. */
export async function signalProcessTree(pid: number, signal: NodeJS.Signals): Promise<void> {
    if (process.platform === "win32") {
        // Windows does not expose Unix-style process-group signals here. taskkill
        // is intentionally forceful for the whole tree, but it still runs
        // asynchronously with a wall-clock bound so termination cannot freeze the
        // MCP event loop.
        await runTaskkill(pid);
        return;
    }

    try {
        process.kill(-pid, signal);
    } catch {
        try {
            process.kill(pid, signal);
        } catch {
            // Process already exited.
        }
    }
}

/**
 * Terminate a child process with bounded TERM→KILL escalation.
 * Windows uses bounded asynchronous taskkill /F for the process tree.
 */
export async function terminateChildProcess(
    child: ChildProcess,
    graceMs = 2_000,
    killWaitMs = 1_000,
): Promise<void> {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;

    await signalProcessTree(child.pid, "SIGTERM");
    if (await waitForChildClose(child, graceMs)) return;

    await signalProcessTree(child.pid, "SIGKILL");
    if (!(await waitForChildClose(child, killWaitMs))) {
        throw new Error(`Process ${child.pid} did not exit after SIGKILL`);
    }
}

async function runTaskkill(pid: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
            shell: false,
        });
        let settled = false;
        const finish = (error?: Error): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve();
        };
        const timer = setTimeout(() => {
            try {
                child.kill("SIGKILL");
            } catch {
                // The helper may have exited between timeout and kill.
            }
            finish(new Error(`taskkill timed out after ${TASKKILL_TIMEOUT_MS}ms`));
        }, TASKKILL_TIMEOUT_MS);
        timer.unref();
        child.once("error", finish);
        child.once("close", () => finish());
    });
}

async function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return await new Promise<boolean>((resolve) => {
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const onClose = (): void => finish(true);
        const finish = (closed: boolean): void => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            child.removeListener("close", onClose);
            resolve(closed);
        };
        timer = setTimeout(() => finish(false), timeoutMs);
        timer.unref();
        child.once("close", onClose);
    });
}

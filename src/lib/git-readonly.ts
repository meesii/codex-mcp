import { runSubprocess, type SubprocessResult } from "./subprocess.js";

const DEFAULT_GIT_TIMEOUT_MS = 15_000;
const DEFAULT_GIT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_GIT_MAX_STDERR_BYTES = 256 * 1024;

export interface RunGitReadOnlyOptions {
    timeoutMs?: number;
    maxOutputBytes?: number;
    allowTruncation?: boolean;
}

/**
 * Run a local Git inspection command without shell execution or optional index writes.
 *
 * `GIT_OPTIONAL_LOCKS=0` suppresses status/index refresh writes; fsmonitor and
 * interactive credential prompts are disabled. Diff/show callers must still pass
 * `--no-ext-diff --no-textconv` because those are command-level capabilities.
 */
export async function runGitReadOnly(
    cwd: string,
    args: readonly string[],
    options: RunGitReadOnlyOptions = {},
): Promise<SubprocessResult> {
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_GIT_MAX_OUTPUT_BYTES;
    const result = await runSubprocess(
        "git",
        ["-C", cwd, "-c", "core.fsmonitor=false", ...args],
        {
            cwd,
            env: {
                ...process.env,
                GIT_OPTIONAL_LOCKS: "0",
                GIT_TERMINAL_PROMPT: "0",
                GCM_INTERACTIVE: "Never",
            },
            timeoutMs: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
            maxStdoutBytes: maxOutputBytes,
            maxStderrBytes: DEFAULT_GIT_MAX_STDERR_BYTES,
            maxTotalBytes: maxOutputBytes + DEFAULT_GIT_MAX_STDERR_BYTES,
        },
    );

    if (result.truncated && options.allowTruncation !== true) {
        throw new Error(`git output exceeded ${maxOutputBytes} bytes`);
    }
    if (!result.truncated && result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `git exited with code ${result.exitCode ?? "unknown"}`);
    }
    return result;
}

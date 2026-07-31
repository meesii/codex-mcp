import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnSync } from "node:child_process";

const DEFAULT_YIELD_MS = 10_000;
const DEFAULT_POLL_MS = 5_000;
const MAX_YIELD_MS = 30_000;
const MAX_POLL_MS = 110_000;
const DEFAULT_MAX_OUTPUT_CHARS = 40_000;
const MAX_BUFFER_CHARS = 1_000_000;
const COMPLETED_TTL_MS = 5 * 60 * 1000;

export interface StartProcessInput {
    command: string;
    cwd: string;
    yieldTimeMs?: number;
    maxOutputChars?: number;
}

export interface PollProcessInput {
    processId: number;
    chars?: string;
    yieldTimeMs?: number;
    maxOutputChars?: number;
}

export interface ProcessSnapshot {
    processId?: number;
    output: string;
    outputTruncated: boolean;
    running: boolean;
    exitCode?: number;
    signal?: string;
    wallTimeMs: number;
}

interface ProcessSession {
    id: number;
    child?: ChildProcessWithoutNullStreams;
    startedAt: number;
    buffer: string;
    truncated: boolean;
    running: boolean;
    exitCode?: number;
    signal?: string;
    exitPromise: Promise<void>;
    resolveExit: () => void;
    cleanupTimer?: NodeJS.Timeout;
}

/**
 * Manage long-running processes with processId handles.
 */
export class ProcessSessionManager {
    private readonly sessions = new Map<number, ProcessSession>();
    private nextId = 1;

    /**
     * Start a command; wait up to yieldTimeMs then return a snapshot.
     * If still running, `processId` is set for later poll/kill.
     *
     * @param input - Start options
     * @returns Process snapshot
     */
    async start(input: StartProcessInput): Promise<ProcessSnapshot> {
        const session = this.createSession();
        this.sessions.set(session.id, session);

        try {
            this.spawnCommand(session, input.command, input.cwd);
        } catch (error) {
            this.sessions.delete(session.id);
            throw error;
        }

        const yieldMs = clampInt(input.yieldTimeMs, DEFAULT_YIELD_MS, MAX_YIELD_MS);
        await this.waitForExit(session, yieldMs);
        return this.consume(session, input.maxOutputChars);
    }

    /**
     * Poll output and optionally write stdin (Codex write_stdin style).
     * Pass `"\\u0003"` in chars to send Ctrl-C / interrupt.
     *
     * @param input - Poll options
     * @returns Process snapshot
     */
    async poll(input: PollProcessInput): Promise<ProcessSnapshot> {
        const session = this.getSession(input.processId);
        const chars = input.chars ?? "";
        const wantsInteract = chars.length > 0;

        if (chars.includes("\u0003") && session.running) {
            this.signalProcess(session, "SIGINT");
        }
        const writable = chars.replaceAll("\u0003", "");
        if (writable && session.running && session.child?.stdin.writable) {
            session.child.stdin.write(writable);
        }

        if (session.running && (wantsInteract || session.buffer.length === 0)) {
            const fallback = wantsInteract ? 250 : DEFAULT_POLL_MS;
            const maximum = wantsInteract ? MAX_YIELD_MS : MAX_POLL_MS;
            const yieldMs = clampInt(input.yieldTimeMs, fallback, maximum);
            await this.waitForExit(session, yieldMs);
        }

        return this.consume(session, input.maxOutputChars);
    }

    /**
     * Terminate a running process by processId.
     *
     * @param processId - Process id from exec_command
     * @returns Snapshot after signaling kill
     */
    async kill(processId: number): Promise<ProcessSnapshot> {
        const session = this.getSession(processId);
        if (session.running) {
            this.signalProcess(session, "SIGTERM");
            await this.waitForExit(session, 2_000);
            if (session.running) {
                this.signalProcess(session, "SIGKILL");
                await this.waitForExit(session, 1_000);
            }
        }
        return this.consume(session);
    }

    /**
     * Kill every managed process (server shutdown).
     */
    shutdown(): void {
        for (const session of this.sessions.values()) {
            if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
            if (session.running) this.signalProcess(session, "SIGTERM");
        }
        this.sessions.clear();
    }

    private createSession(): ProcessSession {
        let resolveExit = (): void => undefined;
        const exitPromise = new Promise<void>((resolve) => {
            resolveExit = resolve;
        });
        return {
            id: this.nextId++,
            startedAt: Date.now(),
            buffer: "",
            truncated: false,
            running: true,
            exitPromise,
            resolveExit,
        };
    }

    private spawnCommand(session: ProcessSession, command: string, cwd: string): void {
        const isWindows = process.platform === "win32";
        const file = isWindows ? "pwsh" : "/bin/bash";
        const args = isWindows
            ? ["-NoProfile", "-Command", command]
            : ["-lc", command];
        const detached = !isWindows;

        const child = spawn(file, args, {
            cwd,
            env: {
                ...process.env,
                NO_COLOR: "1",
            },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            detached,
        });

        session.child = child;
        child.stdout.on("data", (chunk: Buffer) => this.append(session, chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => this.append(session, chunk.toString("utf8")));
        child.on("error", (error) => this.append(session, `${error.message}\n`));
        child.on("close", (code, signal) => {
            this.finish(session, code ?? undefined, signal ?? undefined);
        });
    }

    private append(session: ProcessSession, chunk: string): void {
        if (!chunk) return;
        session.buffer += chunk;
        if (session.buffer.length > MAX_BUFFER_CHARS) {
            session.buffer = session.buffer.slice(session.buffer.length - MAX_BUFFER_CHARS);
            session.truncated = true;
        }
    }

    private finish(session: ProcessSession, exitCode?: number, signal?: string): void {
        if (!session.running) return;
        session.running = false;
        session.exitCode = exitCode;
        session.signal = signal;
        session.resolveExit();
        session.cleanupTimer = setTimeout(() => {
            this.sessions.delete(session.id);
        }, COMPLETED_TTL_MS);
        session.cleanupTimer.unref();
    }

    private async waitForExit(session: ProcessSession, yieldMs: number): Promise<void> {
        let timer: NodeJS.Timeout | undefined;
        try {
            await Promise.race([
                session.exitPromise,
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, yieldMs);
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    private consume(session: ProcessSession, maxOutputChars?: number): ProcessSnapshot {
        const limit = clampInt(maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS, 200_000);
        let output = session.buffer;
        let outputTruncated = session.truncated;
        if (output.length > limit) {
            output = `${output.slice(0, Math.floor(limit / 2))}\n... output truncated ...\n${output.slice(-Math.floor(limit / 2))}`;
            outputTruncated = true;
        }
        session.buffer = "";
        session.truncated = false;

        if (!session.running) {
            if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
            this.sessions.delete(session.id);
        }

        return {
            processId: session.running ? session.id : undefined,
            output,
            outputTruncated,
            running: session.running,
            exitCode: session.exitCode,
            signal: session.signal,
            wallTimeMs: Date.now() - session.startedAt,
        };
    }

    private getSession(processId: number): ProcessSession {
        const session = this.sessions.get(processId);
        if (!session) {
            throw new Error(`Unknown processId: ${processId}`);
        }
        return session;
    }

    private signalProcess(session: ProcessSession, signal: NodeJS.Signals): void {
        const child = session.child;
        if (!child?.pid) return;

        if (process.platform === "win32") {
            spawnSync("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
                stdio: "ignore",
                windowsHide: true,
            });
            return;
        }

        try {
            process.kill(-child.pid, signal);
        } catch {
            try {
                child.kill(signal);
            } catch {
                // already exited
            }
        }
    }
}

/**
 * Clamp an optional integer into [0, maximum], with a default when unset.
 *
 * @param value - Optional input
 * @param fallback - Default
 * @param maximum - Max allowed
 * @returns Clamped integer
 */
function clampInt(value: number | undefined, fallback: number, maximum: number): number {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < 0) return fallback;
    return Math.min(Math.floor(value), maximum);
}

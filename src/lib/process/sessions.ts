import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { signalProcessTree } from "./tree.js";
import { RollingTextBuffer } from "./rolling-buffer.js";
import { commandShell } from "./shell-command.js";
import type { ProcessRuntimeStats } from "../util/telemetry.js";

const DEFAULT_YIELD_MS = 10_000;
const DEFAULT_POLL_MS = 5_000;
const MAX_YIELD_MS = 30_000;
const MAX_POLL_MS = 110_000;
const DEFAULT_MAX_OUTPUT_CHARS = 40_000;
const MAX_BUFFER_CHARS = 1_000_000;
const COMPLETED_MAX_BUFFER_CHARS = 200_000;
const COMPLETED_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_PROCESSES = 8;
const DEFAULT_MAX_PROCESSES_PER_SCOPE = 4;
const MAX_RETAINED_COMPLETED_GLOBAL = 64;
const MAX_RETAINED_COMPLETED_PER_SCOPE = 16;
const MAX_RETAINED_BUFFER_CHARS_GLOBAL = 8_000_000;
const MAX_RETAINED_BUFFER_CHARS_PER_SCOPE = 2_000_000;

export interface StartProcessInput {
    command: string;
    cwd: string;
    name?: string;
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

export interface ProcessInfo {
    processId: number;
    name?: string;
    command: string;
    cwd: string;
    running: boolean;
    startedAt: number;
    wallTimeMs: number;
    exitCode?: number;
    signal?: string;
    bufferedChars: number;
    outputTruncated: boolean;
}

export interface ProcessSessionAccess {
    start(input: StartProcessInput): Promise<ProcessSnapshot>;
    poll(input: PollProcessInput): Promise<ProcessSnapshot>;
    kill(processId: number): Promise<ProcessSnapshot>;
    list(): ProcessInfo[];
    runtimeStats(): ProcessRuntimeStats;
    status(processId: number): ProcessInfo;
    peek(processId: number, maxOutputChars?: number): ProcessSnapshot;
}

interface ProcessSession {
    id: number;
    ownerScope?: string;
    name?: string;
    command: string;
    cwd: string;
    child?: ChildProcessWithoutNullStreams;
    startedAt: number;
    buffer: RollingTextBuffer;
    truncated: boolean;
    running: boolean;
    exitCode?: number;
    signal?: string;
    exitPromise: Promise<void>;
    resolveExit: () => void;
    cleanupTimer?: NodeJS.Timeout;
}

interface SharedProcessState {
    sessions: Map<number, ProcessSession>;
    nextId: number;
    maxProcesses: number;
    starts: number;
    completions: number;
    outputTruncations: number;
}

/**
 * Manage long-running processes with processId handles.
 *
 * A root manager owns the shared process capacity. `scope()` creates a view for
 * one stable process owner: process ids remain globally unique, but poll/kill
 * only see processes created by that owner. Root `shutdown()` is reserved for
 * server shutdown and terminates every process across owners.
 */
export class ProcessSessionManager implements ProcessSessionAccess {
    private readonly state: SharedProcessState;

    constructor(
        maxProcesses = DEFAULT_MAX_PROCESSES,
        private readonly ownerScope?: string,
        state?: SharedProcessState,
        private readonly maxProcessesPerScope = DEFAULT_MAX_PROCESSES_PER_SCOPE,
    ) {
        this.state = state ?? {
            sessions: new Map<number, ProcessSession>(),
            nextId: 1,
            maxProcesses,
            starts: 0,
            completions: 0,
            outputTruncations: 0,
        };
    }

    scope(ownerScope: string): ProcessSessionManager {
        if (!ownerScope) throw new Error("Process scope id is required");
        return new ProcessSessionManager(
            this.state.maxProcesses,
            ownerScope,
            this.state,
            this.maxProcessesPerScope,
        );
    }

    /**
     * Start a command; wait up to yieldTimeMs then return a snapshot.
     * If still running, `processId` is set for later poll/kill.
     */
    async start(input: StartProcessInput): Promise<ProcessSnapshot> {
        const running = [...this.state.sessions.values()].filter((session) => session.running);
        if (running.length >= this.state.maxProcesses) {
            throw new Error(
                `Process capacity reached (${this.state.maxProcesses} running processes max)`,
            );
        }
        if (this.ownerScope !== undefined) {
            const ownedRunning = running.filter(
                (session) => session.ownerScope === this.ownerScope,
            ).length;
            if (ownedRunning >= this.maxProcessesPerScope) {
                throw new Error(
                    `Process scope capacity reached (${this.maxProcessesPerScope} running processes max)`,
                );
            }
        }

        const session = this.createSession(input.command, input.cwd, input.name);
        this.state.sessions.set(session.id, session);

        try {
            this.spawnCommand(session, input.command, input.cwd);
            this.state.starts += 1;
        } catch (error) {
            this.state.sessions.delete(session.id);
            throw error;
        }

        const yieldMs = clampInt(input.yieldTimeMs, DEFAULT_YIELD_MS, MAX_YIELD_MS);
        await this.waitForExit(session, yieldMs);
        return this.consume(session, input.maxOutputChars);
    }

    /**
     * Poll output and optionally write stdin (Codex write_stdin style).
     * `"\\u0003"` sends SIGINT to the Unix process group; Windows falls back
     * to force-terminating the process tree because console signals are not portable here.
     */
    async poll(input: PollProcessInput): Promise<ProcessSnapshot> {
        const session = this.getSession(input.processId);
        const chars = input.chars ?? "";
        const wantsInteract = chars.length > 0;

        if (chars.includes("\u0003") && session.running) {
            await this.signalProcess(session, "SIGINT");
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

    async kill(processId: number): Promise<ProcessSnapshot> {
        return this.killSession(this.getSession(processId));
    }

    list(): ProcessInfo[] {
        return [...this.state.sessions.values()]
            .filter(
                (session) =>
                    this.ownerScope === undefined || session.ownerScope === this.ownerScope,
            )
            .map((session) => this.toInfo(session))
            .sort((left, right) => left.processId - right.processId);
    }

    runtimeStats(): ProcessRuntimeStats {
        const sessions = [...this.state.sessions.values()];
        const running = sessions.filter((session) => session.running).length;
        return {
            running,
            retained: sessions.length - running,
            bufferedChars: sessions.reduce((total, session) => total + session.buffer.length, 0),
            starts: this.state.starts,
            completions: this.state.completions,
            outputTruncations: this.state.outputTruncations,
        };
    }

    status(processId: number): ProcessInfo {
        return this.toInfo(this.getSession(processId));
    }

    peek(processId: number, maxOutputChars?: number): ProcessSnapshot {
        const session = this.getSession(processId);
        const limit = clampInt(maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS, 200_000);
        let output = session.buffer.toString();
        let outputTruncated = session.truncated;
        if (output.length > limit) {
            output = `${output.slice(0, Math.floor(limit / 2))}\n... output truncated ...\n${output.slice(-Math.floor(limit / 2))}`;
            outputTruncated = true;
        }
        return {
            processId: session.id,
            output,
            outputTruncated,
            running: session.running,
            exitCode: session.exitCode,
            signal: session.signal,
            wallTimeMs: Date.now() - session.startedAt,
        };
    }

    /**
     * Kill managed processes and wait for TERM→KILL escalation.
     * Scoped managers only terminate their own processes; the root manager
     * terminates all scopes during HTTP server shutdown.
     */
    async shutdown(): Promise<void> {
        const sessions = [...this.state.sessions.values()].filter(
            (session) =>
                this.ownerScope === undefined || session.ownerScope === this.ownerScope,
        );
        await Promise.all(
            sessions.map(async (session) => {
                try {
                    await this.killSession(session);
                } catch {
                    // A concurrently completed session can disappear before shutdown reaches it.
                }
            }),
        );
        for (const session of sessions) {
            this.removeSession(session);
        }
    }

    private createSession(command: string, cwd: string, name?: string): ProcessSession {
        let resolveExit = (): void => undefined;
        const exitPromise = new Promise<void>((resolve) => {
            resolveExit = resolve;
        });
        return {
            id: this.state.nextId++,
            ownerScope: this.ownerScope,
            ...(name ? { name } : {}),
            command,
            cwd,
            startedAt: Date.now(),
            buffer: new RollingTextBuffer(MAX_BUFFER_CHARS),
            truncated: false,
            running: true,
            exitPromise,
            resolveExit,
        };
    }

    private spawnCommand(session: ProcessSession, command: string, cwd: string): void {
        const { file, args, isWindows } = commandShell(command);
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
        if (session.buffer.append(chunk)) this.markTruncated(session);
    }

    private finish(session: ProcessSession, exitCode?: number, signal?: string): void {
        if (!session.running) return;
        session.running = false;
        session.exitCode = exitCode;
        session.signal = signal;
        this.state.completions += 1;
        session.resolveExit();

        // Running processes may need a large rolling buffer for interactive logs,
        // but completed history is retained only for reconnect recovery. Shrink it
        // before entering the retained pool so 5-minute TTL history cannot pin
        // running-process-sized buffers.
        if (session.buffer.trimTo(COMPLETED_MAX_BUFFER_CHARS)) {
            this.markTruncated(session);
        }

        session.cleanupTimer = setTimeout(() => {
            this.removeSession(session);
        }, COMPLETED_TTL_MS);
        session.cleanupTimer.unref();
        this.enforceRetentionBudgets(session.ownerScope);
    }

    private async killSession(session: ProcessSession): Promise<ProcessSnapshot> {
        if (session.running) {
            await this.signalProcess(session, "SIGTERM");
            await this.waitForExit(session, 2_000);
            if (session.running) {
                await this.signalProcess(session, "SIGKILL");
                await this.waitForExit(session, 1_000);
            }
        }
        return this.consume(session);
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
        let output = session.buffer.toString();
        let outputTruncated = session.truncated;
        if (output.length > limit) {
            output = `${output.slice(0, Math.floor(limit / 2))}\n... output truncated ...\n${output.slice(-Math.floor(limit / 2))}`;
            outputTruncated = true;
        }
        session.buffer.clear();
        session.truncated = false;

        if (!session.running) {
            this.removeSession(session);
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

    private enforceRetentionBudgets(ownerScope: string | undefined): void {
        const completed = [...this.state.sessions.values()]
            .filter((item) => !item.running)
            .sort((left, right) => left.startedAt - right.startedAt || left.id - right.id);
        const owned = completed.filter((item) => item.ownerScope === ownerScope);

        evictOldestUntilWithinBudget(
            owned,
            MAX_RETAINED_COMPLETED_PER_SCOPE,
            MAX_RETAINED_BUFFER_CHARS_PER_SCOPE,
            (session) => this.removeSession(session),
        );

        const remaining = [...this.state.sessions.values()]
            .filter((item) => !item.running)
            .sort((left, right) => left.startedAt - right.startedAt || left.id - right.id);
        evictOldestUntilWithinBudget(
            remaining,
            MAX_RETAINED_COMPLETED_GLOBAL,
            MAX_RETAINED_BUFFER_CHARS_GLOBAL,
            (session) => this.removeSession(session),
        );
    }

    private markTruncated(session: ProcessSession): void {
        if (!session.truncated) this.state.outputTruncations += 1;
        session.truncated = true;
    }

    private removeSession(session: ProcessSession): void {
        if (session.cleanupTimer) {
            clearTimeout(session.cleanupTimer);
            session.cleanupTimer = undefined;
        }
        if (this.state.sessions.get(session.id) === session) {
            this.state.sessions.delete(session.id);
        }
    }

    private toInfo(session: ProcessSession): ProcessInfo {
        return {
            processId: session.id,
            ...(session.name ? { name: session.name } : {}),
            command: session.command,
            cwd: session.cwd,
            running: session.running,
            startedAt: session.startedAt,
            wallTimeMs: Date.now() - session.startedAt,
            exitCode: session.exitCode,
            signal: session.signal,
            bufferedChars: session.buffer.length,
            outputTruncated: session.truncated,
        };
    }

    private getSession(processId: number): ProcessSession {
        const session = this.state.sessions.get(processId);
        if (!session || session.ownerScope !== this.ownerScope) {
            throw new Error(`Unknown processId: ${processId}`);
        }
        return session;
    }

    private async signalProcess(session: ProcessSession, signal: NodeJS.Signals): Promise<void> {
        const pid = session.child?.pid;
        if (pid) await signalProcessTree(pid, signal);
    }
}

function evictOldestUntilWithinBudget(
    sessions: ProcessSession[],
    maxSessions: number,
    maxBufferedChars: number,
    remove: (session: ProcessSession) => void,
): void {
    let count = sessions.length;
    let bufferedChars = sessions.reduce((total, session) => total + session.buffer.length, 0);
    for (const session of sessions) {
        if (count <= maxSessions && bufferedChars <= maxBufferedChars) break;
        remove(session);
        count -= 1;
        bufferedChars -= session.buffer.length;
    }
}

function clampInt(value: number | undefined, fallback: number, maximum: number): number {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < 0) return fallback;
    return Math.min(Math.floor(value), maximum);
}

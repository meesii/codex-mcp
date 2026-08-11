import { once } from "node:events";
import { join } from "node:path";
import pino, { type Level, type Logger } from "pino";
import { getUserLogDir } from "../config/user-config.js";

const LOG_FILE_NAME = "codex-mcp.jsonl";
const LOG_MAX_VALUE_LENGTH = 1_000;
const SENSITIVE_FIELD_RE =
    /authorization|cookie|credential|password|private.?key|secret|token/i;

type RuntimeLogValue = string | number | boolean | null | undefined;
type RuntimeLogFields = Record<string, RuntimeLogValue>;
type RuntimeTransport = ReturnType<typeof pino.transport>;

interface RuntimeLogState {
    directory: string;
    failed: boolean;
    logger?: Logger;
    onError?: (error: Error) => void;
    transport: RuntimeTransport;
    warned: boolean;
}

export interface RuntimeLogInfo {
    directory: string;
    pattern: string;
}

export interface RuntimeLogOptions {
    directory?: string;
    onError?: (error: Error) => void;
}

let state: RuntimeLogState | undefined;

/** Start the process-wide rotating JSONL logger. Safe to call more than once. */
export async function initializeRuntimeLog(
    options: RuntimeLogOptions = {},
): Promise<RuntimeLogInfo> {
    if (state) return logInfo(state.directory);

    const directory = options.directory ?? getUserLogDir();
    const transport = pino.transport({
        target: "pino-roll",
        options: {
            file: join(directory, LOG_FILE_NAME),
            frequency: "daily",
            size: "10m",
            dateFormat: "yyyy-MM-dd",
            mkdir: true,
            limit: {
                count: 7,
                removeOtherLogFiles: true,
            },
        },
    });
    const pending: RuntimeLogState = {
        directory,
        failed: false,
        ...(options.onError ? { onError: options.onError } : {}),
        transport,
        warned: false,
    };
    transport.on("error", (error: Error) => handleTransportError(pending, error));

    try {
        await once(transport, "ready");
        pending.logger = pino(
            {
                base: { service: "codex-mcp" },
                timestamp: pino.stdTimeFunctions.isoTime,
                redact: {
                    paths: [
                        "authorization",
                        "cookie",
                        "credential",
                        "password",
                        "privateKey",
                        "secret",
                        "token",
                    ],
                    remove: true,
                },
            },
            transport,
        );
        state = pending;
        return logInfo(directory);
    } catch (error) {
        transport.end();
        throw error;
    }
}

/** Write one bounded structured runtime event when file logging is available. */
export function writeRuntimeLog(
    level: Level,
    event: string,
    fields: RuntimeLogFields = {},
): void {
    const current = state;
    if (!current?.logger || current.failed) return;
    current.logger[level]({
        ...sanitizeFields(fields),
        event: clipText(event),
    });
}

/** Flush pending JSON lines and stop the transport during process shutdown. */
export function closeRuntimeLog(): void {
    const current = state;
    state = undefined;
    if (!current) return;

    try {
        current.transport.flushSync();
    } finally {
        current.transport.end();
    }
}

export function getRuntimeLogInfo(): RuntimeLogInfo | undefined {
    return state ? logInfo(state.directory) : undefined;
}

function logInfo(directory: string): RuntimeLogInfo {
    return {
        directory,
        pattern: join(directory, "codex-mcp.*.jsonl"),
    };
}

function sanitizeFields(fields: RuntimeLogFields): Record<string, RuntimeLogValue> {
    const safe: Record<string, RuntimeLogValue> = {};
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined || SENSITIVE_FIELD_RE.test(key)) continue;
        safe[key] = typeof value === "string" ? clipText(value) : value;
    }
    return safe;
}

function clipText(value: string): string {
    return value.length <= LOG_MAX_VALUE_LENGTH
        ? value
        : `${value.slice(0, LOG_MAX_VALUE_LENGTH)}…`;
}

function handleTransportError(current: RuntimeLogState, error: Error): void {
    current.failed = true;
    if (state !== current || current.warned) return;
    current.warned = true;
    current.onError?.(error);
}

import { styleText } from "node:util";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { toolUiMeta } from "../../ui/register-ui.js";
import { securitySchemesForServer } from "./meta.js";
import { summarizeOutcome, summarizeToolCall } from "../../ui/tool-summary.js";
import { buildUiCard } from "../../ui/ui-card.js";
import { resultText } from "./result.js";
import { runtimeTelemetry } from "../util/telemetry.js";

const TOOL_NAME_WIDTH = 18;
const toolRegistrationPolicies = new WeakMap<McpServer, ReadonlySet<string>>();

const colorEnabled =
    process.env.NO_COLOR === undefined &&
    process.stdout.isTTY === true;

function paint(
    format: Parameters<typeof styleText>[0],
    text: string,
): string {
    if (!colorEnabled) return text;
    return styleText(format, text);
}

export function isToolLogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = env.CODING_MCP_LOG_TOOLS;
    if (raw === undefined) return true;
    return raw !== "0" && raw.toLowerCase() !== "false";
}

function timeLabel(): string {
    return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

function formatDuration(durationMs: number): string {
    if (durationMs < 1000) return `${durationMs}ms`;
    const seconds = durationMs / 1000;
    if (seconds < 10) return `${seconds.toFixed(1)}s`;
    return `${Math.round(seconds)}s`;
}

function padToolName(toolName: string): string {
    return toolName.padEnd(TOOL_NAME_WIDTH);
}

function formatDetail(title?: string, outcome?: string): string {
    const parts = [title, outcome].filter((part): part is string => Boolean(part));
    return parts.join(paint("dim", "  ·  "));
}

export function logMcpEvent(kind: string, details: Record<string, unknown> = {}): void {
    if (!isToolLogEnabled()) return;

    const pairs = Object.entries(details)
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([key, value]) => `${key}=${String(value)}`);
    const detail = pairs.length > 0 ? paint("dim", pairs.join(" ")) : "";

    console.log(
        `${paint("dim", timeLabel())}  ${paint(["bold", "yellow"], "warn")}  ${paint("yellow", kind.padEnd(TOOL_NAME_WIDTH))}  ${detail}`.trimEnd(),
    );
}

function logToolCall(
    toolName: string,
    args: Record<string, unknown>,
    result: CallToolResult | { thrown: string },
    durationMs: number,
): void {
    if (!isToolLogEnabled()) return;

    const time = paint("dim", timeLabel());
    const tool = paint(["bold", "magenta"], padToolName(toolName));
    const ms = paint("dim", formatDuration(durationMs).padStart(5));
    const call = summarizeToolCall(toolName, args);
    const title =
        call.title && call.title !== "—"
            ? paint("white", call.title)
            : undefined;

    if ("thrown" in result) {
        const detail = formatDetail(title, paint("red", String(result.thrown)));
        console.log(
            `${time}  ${paint(["bold", "red"], "err ")}  ${tool}  ${ms}  ${detail}`.trimEnd(),
        );
        return;
    }

    const contentText = resultText(result);
    const ok = !result.isError;
    const status = ok
        ? paint(["bold", "green"], "ok  ")
        : paint(["bold", "yellow"], "fail");
    const structured =
        result.structuredContent && typeof result.structuredContent === "object"
            ? (result.structuredContent as Record<string, unknown>)
            : null;
    const outcome = summarizeOutcome(toolName, ok, structured, contentText);
    const outcomeText = outcome
        ? paint(ok ? "dim" : "yellow", outcome)
        : undefined;
    const detail = formatDetail(title, outcomeText);

    console.log(`${time}  ${status}  ${tool}  ${ms}  ${detail}`.trimEnd());
}

export function configureToolRegistrationPolicy(
    server: McpServer,
    allowedTools?: ReadonlySet<string>,
): void {
    if (allowedTools === undefined) {
        toolRegistrationPolicies.delete(server);
        return;
    }
    toolRegistrationPolicies.set(server, allowedTools);
}

export function registerTool(
    server: McpServer,
    name: string,
    config: object,
    // Args are validated by the SDK from inputSchema; keep handler ergonomics simple.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (args: any) => Promise<CallToolResult>,
): void {
    const allowedTools = toolRegistrationPolicies.get(server);
    if (allowedTools && !allowedTools.has(name)) return;

    const previousMeta =
        config && typeof config === "object" && "_meta" in config
            ? ((config as { _meta?: Record<string, unknown> })._meta ?? {})
            : {};
    const securitySchemes = securitySchemesForServer(server);
    const generatedUiMeta = toolUiMeta(server, name);
    const previousUi =
        previousMeta.ui && typeof previousMeta.ui === "object"
            ? (previousMeta.ui as Record<string, unknown>)
            : undefined;
    const generatedUi =
        generatedUiMeta.ui && typeof generatedUiMeta.ui === "object"
            ? (generatedUiMeta.ui as Record<string, unknown>)
            : undefined;
    const mergedUi =
        previousUi || generatedUi
            ? { ...(previousUi ?? {}), ...(generatedUi ?? {}) }
            : undefined;
    const configWithUi = {
        ...config,
        securitySchemes,
        _meta: {
            ...previousMeta,
            securitySchemes,
            ...generatedUiMeta,
            ...(mergedUi ? { ui: mergedUi } : {}),
        },
    };

    const wrapped = async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const startedAt = performance.now();
        try {
            const result = withUiCardMeta(name, args, await handler(args));
            const durationMs = performance.now() - startedAt;
            runtimeTelemetry.recordTool(
                name,
                durationMs,
                result.isError === true,
                estimateResultBytes(result),
            );
            logToolCall(name, args, result, Math.round(durationMs));
            return result;
        } catch (error) {
            const durationMs = performance.now() - startedAt;
            runtimeTelemetry.recordTool(name, durationMs, true, 0);
            logToolCall(
                name,
                args,
                { thrown: error instanceof Error ? error.message : String(error) },
                Math.round(durationMs),
            );
            throw error;
        }
    };

    // SDK overloads are wide; keep a single registration path here.
    (
        server.registerTool as (
            toolName: string,
            conf: object,
            fn: (args: Record<string, unknown>) => Promise<CallToolResult>,
        ) => void
    )(name, configWithUi, wrapped);
}

function estimateResultBytes(result: CallToolResult): number {
    try {
        return Buffer.byteLength(
            JSON.stringify({
                isError: result.isError === true,
                content: result.content,
                structuredContent: result.structuredContent,
            }),
            "utf8",
        );
    } catch {
        return 0;
    }
}

function withUiCardMeta(
    toolName: string,
    args: Record<string, unknown>,
    result: CallToolResult,
): CallToolResult {
    const structured =
        result.structuredContent && typeof result.structuredContent === "object"
            ? (result.structuredContent as Record<string, unknown>)
            : null;
    const uiCard = buildUiCard(
        toolName,
        !result.isError,
        args,
        structured,
        resultText(result),
    );
    const previousMeta =
        result._meta && typeof result._meta === "object"
            ? (result._meta as Record<string, unknown>)
            : {};

    return {
        ...result,
        _meta: {
            ...previousMeta,
            tool: toolName,
            uiCard,
        },
    };
}

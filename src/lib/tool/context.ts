import { AsyncLocalStorage } from "node:async_hooks";
import type { ServerContext } from "@modelcontextprotocol/server";

const OPENAI_SESSION_META_KEY = "openai/session";
const MAX_OWNER_META_CHARS = 512;

export interface ToolInvocationContext {
    /** Anonymous ChatGPT conversation/session id supplied per tool call. */
    openAiSessionId?: string;
    /** MCP transport session id when the transport exposes one. */
    transportSessionId?: string;
}

const invocationStorage = new AsyncLocalStorage<ToolInvocationContext>();

export async function runWithToolInvocationContext<T>(
    context: ServerContext,
    run: () => Promise<T>,
): Promise<T> {
    const openAiSessionId = stringMeta(context.mcpReq._meta, OPENAI_SESSION_META_KEY);
    const transportSessionId = boundedString(context.sessionId);
    return await invocationStorage.run(
        {
            ...(openAiSessionId ? { openAiSessionId } : {}),
            ...(transportSessionId ? { transportSessionId } : {}),
        },
        run,
    );
}

export function currentToolOwnerId(fallbackOwnerId: string): string {
    const current = invocationStorage.getStore();
    if (current?.openAiSessionId) {
        return `${fallbackOwnerId}|openai-session:${current.openAiSessionId}`;
    }
    if (current?.transportSessionId) {
        return `${fallbackOwnerId}|mcp-session:${current.transportSessionId}`;
    }
    return fallbackOwnerId;
}

export function getToolInvocationContext(): ToolInvocationContext | undefined {
    const current = invocationStorage.getStore();
    return current ? { ...current } : undefined;
}

function stringMeta(
    meta: Record<string, unknown> | undefined,
    key: string,
): string | undefined {
    return boundedString(meta?.[key]);
}

function boundedString(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim();
    if (!normalized || normalized.length > MAX_OWNER_META_CHARS) return undefined;
    return normalized;
}

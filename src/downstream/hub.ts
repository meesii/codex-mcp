import { isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
    getDefaultEnvironment,
    StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
    ToolListChangedNotificationSchema,
    type CallToolResult,
    type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { loadMergedMcpConfig } from "../config/codex-import.js";
import { AsyncMutex } from "../lib/util/mutex.js";
import { runtimeTelemetry } from "../lib/util/telemetry.js";
import {
    isStdioMcpServer,
    isUrlMcpServer,
    listEnabledMcpServers,
    type McpServerConfig,
    type NamedMcpServer,
    type UserMcpConfig,
} from "../config/user-mcp.js";

export interface DownstreamServerInfo {
    name: string;
    description: string;
    status: "ready" | "error";
    error?: string;
    capabilities?: {
        tools: boolean;
        resources: boolean;
        prompts: boolean;
    };
}

export interface DownstreamToolInfo {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

export interface DownstreamResourceInfo {
    uri: string;
    name: string;
    title?: string;
    description?: string;
    mimeType?: string;
    size?: number;
}

export interface DownstreamResourceTemplateInfo {
    uriTemplate: string;
    name: string;
    title?: string;
    description?: string;
    mimeType?: string;
}

export interface DownstreamPromptInfo {
    name: string;
    title?: string;
    description?: string;
    arguments: Array<{
        name: string;
        description?: string;
        required: boolean;
    }>;
}

export interface DownstreamReloadResult {
    generation: number;
    added: string[];
    changed: string[];
    removed: string[];
    ready: number;
    error: number;
}

export interface DownstreamResourceReadResult {
    contents: Array<{
        uri: string;
        mimeType?: string;
        text?: string;
        blob?: string;
    }>;
}

export interface DownstreamPromptResult {
    description?: string;
    messages: Array<Record<string, unknown>>;
}

export interface DownstreamListResult<T> {
    items: T[];
    truncated: boolean;
}

interface DownstreamConnection {
    client: Client;
    transport: StdioClientTransport | StreamableHTTPClientTransport;
    stderrTail: () => string;
    toolsCache?: Promise<DownstreamListResult<DownstreamToolInfo>>;
    closed: boolean;
    closePromise?: Promise<void>;
}

interface ServerSlot {
    readonly name: string;
    readonly lifecycle: AsyncMutex;
    config: McpServerConfig;
    info: DownstreamServerInfo;
    current?: DownstreamConnection;
}

interface TransportState {
    transport: StdioClientTransport | StreamableHTTPClientTransport;
    stderrTail: () => string;
}

const DOWNSTREAM_CONNECT_TIMEOUT_MS = 15_000;
const DOWNSTREAM_STDIO_MAX_MESSAGE_BYTES = 6 * 1024 * 1024;
const DOWNSTREAM_STDERR_TAIL_CHARS = 64 * 1024;
const DOWNSTREAM_MAX_PAGES = 50;
const DOWNSTREAM_MAX_LIST_ITEMS = 2_000;
const DOWNSTREAM_MAX_LIST_BYTES = 2 * 1024 * 1024;
const DOWNSTREAM_MAX_RESULT_BYTES = 4 * 1024 * 1024;

/**
 * Shared downstream MCP gateway.
 *
 * A configured server is represented by a stable slot. The live connection is
 * an immutable generation object: reload/reconnect may replace `slot.current`,
 * but they never clear fields on a connection already held by an in-flight call.
 * Per-slot lifecycle mutexes serialize reconnects, while a hub-level mutex
 * serializes config reload/close transitions.
 */
export class DownstreamMcpHub {
    private readonly sessions = new Map<string, ServerSlot>();
    private readonly configLifecycle = new AsyncMutex();
    private closed = false;
    private generation = 0;
    private importError?: string;

    private constructor() {}

    static async connectFromDefaultConfig(
        options: {
            loadConfig?: () => Promise<UserMcpConfig>;
            onImportError?: (error: Error) => void;
        } = {},
    ): Promise<DownstreamMcpHub> {
        const hub = new DownstreamMcpHub();
        try {
            const loadConfig = options.loadConfig ?? loadMergedMcpConfig;
            await hub.reloadFromConfig(await loadConfig());
        } catch (error) {
            const normalized = error instanceof Error ? error : new Error(String(error));
            hub.importError = clipImportError(normalized.message);
            options.onImportError?.(normalized);
        }
        return hub;
    }

    static empty(): DownstreamMcpHub {
        return new DownstreamMcpHub();
    }

    getGeneration(): number {
        return this.generation;
    }

    getImportError(): string | undefined {
        return this.importError;
    }

    async reloadFromDefaultConfig(): Promise<DownstreamReloadResult> {
        try {
            const result = await this.reloadFromConfig(await loadMergedMcpConfig());
            this.importError = undefined;
            return result;
        } catch (error) {
            this.importError = clipImportError(error instanceof Error ? error.message : String(error));
            throw error;
        }
    }

    async reloadFromConfig(config: UserMcpConfig): Promise<DownstreamReloadResult> {
        return await this.configLifecycle.runExclusive(async () => {
            this.assertOpen();

            const desired = new Map(
                listEnabledMcpServers(config).map((entry) => [entry.name, entry] as const),
            );
            const removed: string[] = [];
            const changed: string[] = [];
            const added: string[] = [];
            const retired: ServerSlot[] = [];
            const toConnect: ServerSlot[] = [];

            for (const [name, slot] of [...this.sessions.entries()]) {
                const entry = desired.get(name);
                if (!entry) {
                    removed.push(name);
                    this.sessions.delete(name);
                    retired.push(slot);
                    continue;
                }
                if (!sameMcpConfig(slot.config, entry.config)) {
                    changed.push(name);
                    this.sessions.delete(name);
                    retired.push(slot);
                }
            }

            for (const entry of desired.values()) {
                if (this.sessions.has(entry.name)) continue;
                const slot = createSlot(entry);
                this.sessions.set(entry.name, slot);
                if (!changed.includes(entry.name)) added.push(entry.name);
                toConnect.push(slot);
            }

            // Publish the new slot map before touching old connections. In-flight
            // calls may still finish on their immutable old connection, but any
            // retry/reconnect validates slot identity and cannot resurrect it.
            await Promise.all([
                ...retired.map((slot) => this.retireSlot(slot)),
                ...toConnect.map((slot) => this.connectSlot(slot)),
            ]);

            this.generation += 1;
            this.importError = undefined;
            const servers = this.listServers();
            return {
                generation: this.generation,
                added: added.sort(),
                changed: changed.sort(),
                removed: removed.sort(),
                ready: servers.filter((server) => server.status === "ready").length,
                error: servers.filter((server) => server.status === "error").length,
            };
        });
    }

    async reconnectServer(serverName: string): Promise<DownstreamServerInfo> {
        this.assertOpen();
        const slot = this.requireSlot(serverName);
        runtimeTelemetry.recordDownstreamReconnect();
        await slot.lifecycle.runExclusive(async () => {
            this.assertSlotActive(slot);
            await this.replaceConnection(slot);
        });
        return { ...slot.info };
    }

    hasServers(): boolean {
        return this.sessions.size > 0;
    }

    listServers(): DownstreamServerInfo[] {
        return [...this.sessions.values()]
            .map((slot) => ({ ...slot.info }))
            .sort((left, right) => left.name.localeCompare(right.name));
    }

    listReadyServers(): DownstreamServerInfo[] {
        return this.listServers().filter((server) => server.status === "ready");
    }

    buildInstructionsBlock(): string {
        const servers = this.listServers();
        if (servers.length === 0) return "";
        return [
            "Downstream MCP servers (use mcp_tools / mcp_call):",
            ...servers.map((server) => {
                if (server.status === "ready") return `- ${server.name} — ${server.description}`;
                const detail = server.error ? `unavailable: ${server.error}` : "unavailable";
                return `- ${server.name} — ${detail}`;
            }),
        ].join("\n");
    }

    async listTools(serverName: string): Promise<DownstreamListResult<DownstreamToolInfo>> {
        return await this.withConnection(serverName, "tools", (connection, slot) => {
            runtimeTelemetry.recordDownstreamCache(connection.toolsCache !== undefined);
            return listSessionToolsCached(connection, slot.config.toolTimeoutMs);
        });
    }

    async callTool(
        serverName: string,
        toolName: string,
        args: Record<string, unknown> = {},
    ): Promise<CallToolResult> {
        return await this.withConnection(serverName, "tools", async (connection, slot) => {
            const result = (await connection.client.callTool(
                { name: toolName, arguments: args },
                undefined,
                requestOptions(slot.config.toolTimeoutMs),
            )) as CallToolResult;
            assertResultBudget(result, `downstream tool ${serverName}/${toolName}`);
            return result;
        });
    }

    async listResources(serverName: string): Promise<{
        resources: DownstreamResourceInfo[];
        templates: DownstreamResourceTemplateInfo[];
        truncated: boolean;
    }> {
        return await this.withConnection(serverName, "resources", async (connection, slot) => {
            const resources = await listSessionResources(connection, slot.config.toolTimeoutMs);
            const templates = await listSessionResourceTemplates(connection, slot.config.toolTimeoutMs);
            return {
                resources: resources.items,
                templates: templates.items,
                truncated: resources.truncated || templates.truncated,
            };
        });
    }

    async readResource(
        serverName: string,
        uri: string,
    ): Promise<DownstreamResourceReadResult> {
        return await this.withConnection(serverName, "resources", async (connection, slot) => {
            const result = await connection.client.readResource(
                { uri },
                requestOptions(slot.config.toolTimeoutMs),
            );
            assertResultBudget(result, `downstream resource ${serverName}/${uri}`);
            return {
                contents: result.contents.map((content) => ({
                    uri: content.uri,
                    ...(content.mimeType ? { mimeType: content.mimeType } : {}),
                    ...("text" in content ? { text: content.text } : { blob: content.blob }),
                })),
            };
        });
    }

    async listPrompts(serverName: string): Promise<DownstreamListResult<DownstreamPromptInfo>> {
        return await this.withConnection(serverName, "prompts", (connection, slot) =>
            listSessionPrompts(connection, slot.config.toolTimeoutMs),
        );
    }

    async getPrompt(
        serverName: string,
        promptName: string,
        args: Record<string, string> = {},
    ): Promise<DownstreamPromptResult> {
        return await this.withConnection(serverName, "prompts", async (connection, slot) => {
            const result = await connection.client.getPrompt(
                {
                    name: promptName,
                    ...(Object.keys(args).length > 0 ? { arguments: args } : {}),
                },
                requestOptions(slot.config.toolTimeoutMs),
            );
            assertResultBudget(result, `downstream prompt ${serverName}/${promptName}`);
            return {
                ...(result.description ? { description: result.description } : {}),
                messages: result.messages.map((message) => ({
                    role: message.role,
                    content: message.content,
                })),
            };
        });
    }

    async close(): Promise<void> {
        await this.configLifecycle.runExclusive(async () => {
            if (this.closed) return;
            this.closed = true;
            const slots = [...this.sessions.values()];
            this.sessions.clear();
            await Promise.all(slots.map((slot) => this.retireSlot(slot)));
        });
    }

    private async withConnection<T>(
        serverName: string,
        primitive: "tools" | "resources" | "prompts",
        operation: (connection: DownstreamConnection, slot: ServerSlot) => Promise<T>,
    ): Promise<T> {
        const startedAt = performance.now();
        try {
            const slot = this.requireSlot(serverName);
            let connection = this.requireReadyConnection(slot, primitive);
            try {
                const result = await operation(connection, slot);
                runtimeTelemetry.recordDownstream(serverName, performance.now() - startedAt, false);
                return result;
            } catch (error) {
                if (!isConnectionClosedError(error)) throw error;
                runtimeTelemetry.recordDownstreamReconnect();
                connection = await this.reconnectAfterFailure(slot, connection);
                requirePrimitive(slot.info, primitive);
                const result = await operation(connection, slot);
                runtimeTelemetry.recordDownstream(serverName, performance.now() - startedAt, false);
                return result;
            }
        } catch (error) {
            runtimeTelemetry.recordDownstream(serverName, performance.now() - startedAt, true);
            throw error;
        }
    }

    private async reconnectAfterFailure(
        slot: ServerSlot,
        failedConnection: DownstreamConnection,
    ): Promise<DownstreamConnection> {
        return await slot.lifecycle.runExclusive(async () => {
            this.assertSlotActive(slot);
            if (slot.current && slot.current !== failedConnection && !slot.current.closed) {
                return slot.current;
            }
            if (slot.current === failedConnection) {
                slot.current = undefined;
                await closeConnection(failedConnection);
            }
            await this.openAndPublish(slot);
            return this.requireReadyConnection(slot);
        });
    }

    private async connectSlot(slot: ServerSlot): Promise<void> {
        await slot.lifecycle.runExclusive(async () => {
            if (!this.isSlotActive(slot)) return;
            try {
                await this.openAndPublish(slot);
            } catch {
                // Initial/reload connection failures are represented in slot.info;
                // one unavailable downstream must not fail the entire hub reload.
            }
        });
    }

    private async replaceConnection(slot: ServerSlot): Promise<void> {
        const previous = slot.current;
        slot.current = undefined;
        slot.info = unavailableInfo(slot.name, "reconnecting");
        if (previous) await closeConnection(previous);
        await this.openAndPublish(slot);
    }

    private async openAndPublish(slot: ServerSlot): Promise<void> {
        this.assertSlotActive(slot);
        try {
            const connection = await openConnection(slot.name, slot.config);
            if (!this.isSlotActive(slot)) {
                await closeConnection(connection);
                throw new Error(`downstream MCP "${slot.name}" configuration changed while connecting`);
            }
            const previous = slot.current;
            slot.current = connection;
            slot.info = readyInfo(slot.name, connection.client);
            if (previous && previous !== connection) await closeConnection(previous);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            slot.current = undefined;
            slot.info = unavailableInfo(slot.name, message);
            throw new Error(`downstream MCP "${slot.name}" connect failed: ${message}`);
        }
    }

    private async retireSlot(slot: ServerSlot): Promise<void> {
        await slot.lifecycle.runExclusive(async () => {
            const connection = slot.current;
            slot.current = undefined;
            if (connection) await closeConnection(connection);
        });
    }

    private requireSlot(serverName: string): ServerSlot {
        this.assertOpen();
        const slot = this.sessions.get(serverName);
        if (slot) return slot;
        const known = this.listServers().map((server) => server.name);
        const hint = known.length > 0 ? `known: ${known.join(", ")}` : "none configured";
        throw new Error(`unknown downstream MCP "${serverName}" (${hint})`);
    }

    private requireReadyConnection(
        slot: ServerSlot,
        primitive?: "tools" | "resources" | "prompts",
    ): DownstreamConnection {
        this.assertSlotActive(slot);
        if (primitive) requirePrimitive(slot.info, primitive);
        const connection = slot.current;
        if (slot.info.status !== "ready" || !connection || connection.closed) {
            const detail = slot.info.error ?? "not connected";
            throw new Error(`downstream MCP "${slot.name}" is unavailable: ${detail}`);
        }
        return connection;
    }

    private isSlotActive(slot: ServerSlot): boolean {
        return !this.closed && this.sessions.get(slot.name) === slot;
    }

    private assertSlotActive(slot: ServerSlot): void {
        this.assertOpen();
        if (this.sessions.get(slot.name) !== slot) {
            throw new Error(`downstream MCP "${slot.name}" configuration changed or was removed`);
        }
    }

    private assertOpen(): void {
        if (this.closed) throw new Error("downstream MCP hub is closed");
    }
}

function createSlot(entry: NamedMcpServer): ServerSlot {
    return {
        name: entry.name,
        lifecycle: new AsyncMutex(),
        config: entry.config,
        info: unavailableInfo(entry.name, "connecting"),
    };
}

function unavailableInfo(name: string, error: string): DownstreamServerInfo {
    return { name, description: name, status: "error", error };
}

function readyInfo(name: string, client: Client): DownstreamServerInfo {
    const capabilities = client.getServerCapabilities();
    return {
        name,
        // Only locally configured text enters parent MCP instructions.
        description: name,
        status: "ready",
        capabilities: {
            tools: capabilities?.tools !== undefined,
            resources: capabilities?.resources !== undefined,
            prompts: capabilities?.prompts !== undefined,
        },
    };
}

async function openConnection(name: string, config: McpServerConfig): Promise<DownstreamConnection> {
    const client = new Client({ name: "codex-mcp", version: "0.1.0" });
    const state = createTransportState(config);
    const connection: DownstreamConnection = {
        client,
        transport: state.transport,
        stderrTail: state.stderrTail,
        closed: false,
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        connection.toolsCache = undefined;
    });
    try {
        const connectTimeout = config.startupTimeoutMs ?? DOWNSTREAM_CONNECT_TIMEOUT_MS;
        await client.connect(state.transport, {
            timeout: connectTimeout,
            maxTotalTimeout: connectTimeout,
        });
        return connection;
    } catch (error) {
        await closeConnection(connection);
        const base = error instanceof Error ? error.message : String(error);
        const stderr = state.stderrTail().trim();
        throw new Error(stderr ? `${base}; stderr: ${clipOneLine(stderr, 1_000)}` : base);
    }
}

function createTransportState(config: McpServerConfig): TransportState {
    if (isStdioMcpServer(config)) {
        const transport = new StdioClientTransport({
            command: config.command,
            args: config.args,
            cwd: config.cwd,
            stderr: "pipe",
            maxBufferSize: DOWNSTREAM_STDIO_MAX_MESSAGE_BYTES,
            env: {
                ...getDefaultEnvironment(),
                ...(config.env ?? {}),
            },
        });
        let stderrTail = "";
        transport.stderr?.on("data", (chunk: Buffer | string) => {
            stderrTail += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
            if (stderrTail.length > DOWNSTREAM_STDERR_TAIL_CHARS) {
                stderrTail = stderrTail.slice(-DOWNSTREAM_STDERR_TAIL_CHARS);
            }
        });
        return { transport, stderrTail: () => stderrTail };
    }
    if (isUrlMcpServer(config)) {
        return {
            transport: new StreamableHTTPClientTransport(new URL(config.url), {
                requestInit: config.headers ? { headers: config.headers } : undefined,
            }),
            stderrTail: () => "",
        };
    }
    throw new Error("unsupported MCP server config");
}

async function closeConnection(connection: DownstreamConnection): Promise<void> {
    if (connection.closePromise) return await connection.closePromise;
    connection.closed = true;
    connection.closePromise = (async () => {
        try {
            await connection.client.close();
        } catch {
            // Best-effort shutdown; transport close below is the fallback.
        }
        try {
            await connection.transport.close();
        } catch {
            // Best-effort shutdown.
        }
    })();
    await connection.closePromise;
}

async function listSessionToolsCached(
    connection: DownstreamConnection,
    timeoutMs?: number,
): Promise<DownstreamListResult<DownstreamToolInfo>> {
    if (connection.toolsCache) return await connection.toolsCache;
    const pending = listSessionTools(connection, timeoutMs);
    connection.toolsCache = pending;
    try {
        return await pending;
    } catch (error) {
        if (connection.toolsCache === pending) connection.toolsCache = undefined;
        throw error;
    }
}

async function listSessionTools(
    connection: DownstreamConnection,
    timeoutMs?: number,
): Promise<DownstreamListResult<DownstreamToolInfo>> {
    return await collectPaginated(
        "tools",
        async (cursor) => {
            const listed = await connection.client.listTools(
                cursor ? { cursor } : undefined,
                requestOptions(timeoutMs),
            );
            return { items: listed.tools.map(toToolInfo), nextCursor: listed.nextCursor };
        },
    );
}

async function listSessionResources(
    connection: DownstreamConnection,
    timeoutMs?: number,
): Promise<DownstreamListResult<DownstreamResourceInfo>> {
    return await collectPaginated(
        "resources",
        async (cursor) => {
            const listed = await connection.client.listResources(
                cursor ? { cursor } : undefined,
                requestOptions(timeoutMs),
            );
            return {
                items: listed.resources.map((resource) => ({
                    uri: resource.uri,
                    name: resource.name,
                    ...(resource.title ? { title: resource.title } : {}),
                    ...(resource.description ? { description: resource.description } : {}),
                    ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
                    ...(resource.size !== undefined ? { size: resource.size } : {}),
                })),
                nextCursor: listed.nextCursor,
            };
        },
    );
}

async function listSessionResourceTemplates(
    connection: DownstreamConnection,
    timeoutMs?: number,
): Promise<DownstreamListResult<DownstreamResourceTemplateInfo>> {
    return await collectPaginated(
        "resource templates",
        async (cursor) => {
            const listed = await connection.client.listResourceTemplates(
                cursor ? { cursor } : undefined,
                requestOptions(timeoutMs),
            );
            return {
                items: listed.resourceTemplates.map((template) => ({
                    uriTemplate: template.uriTemplate,
                    name: template.name,
                    ...(template.title ? { title: template.title } : {}),
                    ...(template.description ? { description: template.description } : {}),
                    ...(template.mimeType ? { mimeType: template.mimeType } : {}),
                })),
                nextCursor: listed.nextCursor,
            };
        },
    );
}

async function listSessionPrompts(
    connection: DownstreamConnection,
    timeoutMs?: number,
): Promise<DownstreamListResult<DownstreamPromptInfo>> {
    return await collectPaginated(
        "prompts",
        async (cursor) => {
            const listed = await connection.client.listPrompts(
                cursor ? { cursor } : undefined,
                requestOptions(timeoutMs),
            );
            return {
                items: listed.prompts.map((prompt) => ({
                    name: prompt.name,
                    ...(prompt.title ? { title: prompt.title } : {}),
                    ...(prompt.description ? { description: prompt.description } : {}),
                    arguments: (prompt.arguments ?? []).map((argument) => ({
                        name: argument.name,
                        ...(argument.description ? { description: argument.description } : {}),
                        required: argument.required === true,
                    })),
                })),
                nextCursor: listed.nextCursor,
            };
        },
    );
}

export async function collectPaginated<T>(
    label: string,
    fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
): Promise<DownstreamListResult<T>> {
    const items: T[] = [];
    const seenCursors = new Set<string>();
    let bytes = 0;
    let cursor: string | undefined;
    let page = 0;

    while (page < DOWNSTREAM_MAX_PAGES) {
        page += 1;
        const result = await fetchPage(cursor);
        for (const item of result.items) {
            const itemBytes = serializedBytes(item);
            if (
                items.length >= DOWNSTREAM_MAX_LIST_ITEMS ||
                bytes + itemBytes > DOWNSTREAM_MAX_LIST_BYTES
            ) {
                return { items, truncated: true };
            }
            items.push(item);
            bytes += itemBytes;
        }

        const nextCursor = result.nextCursor;
        if (!nextCursor) return { items, truncated: false };
        if (seenCursors.has(nextCursor) || nextCursor === cursor) {
            throw new Error(`downstream ${label} pagination repeated cursor "${clipOneLine(nextCursor, 200)}"`);
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
    }

    return { items, truncated: true };
}

function requestOptions(timeoutMs?: number):
    | { timeout: number; maxTotalTimeout: number }
    | undefined {
    return timeoutMs ? { timeout: timeoutMs, maxTotalTimeout: timeoutMs } : undefined;
}

function sameMcpConfig(left: McpServerConfig, right: McpServerConfig): boolean {
    return isDeepStrictEqual(left, right);
}

function requirePrimitive(
    info: DownstreamServerInfo,
    primitive: "tools" | "resources" | "prompts",
): void {
    if (info.capabilities?.[primitive] === true) return;
    throw new Error(`downstream MCP "${info.name}" does not advertise ${primitive} capability`);
}

function isConnectionClosedError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /not connected|connection closed|closed/i.test(message);
}

function toToolInfo(tool: Tool): DownstreamToolInfo {
    const schema =
        tool.inputSchema && typeof tool.inputSchema === "object"
            ? (tool.inputSchema as Record<string, unknown>)
            : { type: "object", properties: {} };
    return {
        name: tool.name,
        description: tool.description?.trim() || "",
        inputSchema: schema,
    };
}

function assertResultBudget(value: unknown, label: string): void {
    const bytes = serializedBytes(value);
    if (bytes > DOWNSTREAM_MAX_RESULT_BYTES) {
        throw new Error(
            `${label} exceeded gateway result budget (${bytes} bytes > ${DOWNSTREAM_MAX_RESULT_BYTES})`,
        );
    }
}

function serializedBytes(value: unknown): number {
    try {
        return Buffer.byteLength(JSON.stringify(value), "utf8");
    } catch {
        throw new Error("downstream MCP returned a non-serializable result");
    }
}

function clipImportError(value: string): string {
    return clipOneLine(value, 1_000);
}

function clipOneLine(value: string, maxChars: number): string {
    const oneLine = value.replace(/\s+/g, " ").trim();
    if (oneLine.length <= maxChars) return oneLine;
    return `${oneLine.slice(0, maxChars - 1)}…`;
}

import { randomUUID } from "node:crypto";
import type { Server as NodeHttpServer } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "./config.js";
import { ProcessSessionManager } from "./lib/process-sessions.js";
import { logMcpEvent } from "./lib/tool-log.js";
import { createMcpServer } from "./mcp-server.js";
import { McpSessionRegistry } from "./mcp-sessions.js";
import { ProjectContext } from "./project.js";

type Transport = StreamableHTTPServerTransport;

const MCP_SESSION_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MCP_SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface RunningHttpServer {
    config: ServerConfig;
    project: ProjectContext;
    listen: () => Promise<NodeHttpServer>;
    close: () => Promise<void>;
    /** Bound URL after listen, e.g. http://127.0.0.1:3920/mcp */
    getMcpUrl: () => string;
}

/**
 * Send a JSON-RPC error response when headers are not yet sent.
 *
 * @param res - Express response
 * @param httpStatus - HTTP status code
 * @param code - JSON-RPC error code
 * @param message - Error message
 */
function sendJsonRpcError(
    res: {
        headersSent: boolean;
        status: (code: number) => { json: (body: unknown) => void };
    },
    httpStatus: number,
    code: number,
    message: string,
): void {
    if (res.headersSent) return;
    res.status(httpStatus).json({
        jsonrpc: "2.0",
        error: { code, message },
        id: null,
    });
}

/**
 * Create the HTTP + Streamable MCP application (no auth).
 *
 * @param config - Server configuration
 * @returns Running server controls
 */
export function createHttpServer(config: ServerConfig): RunningHttpServer {
    const app = createMcpExpressApp({
        host: config.host,
        ...(config.allowedHosts.length > 0
            ? {
                  allowedHosts: Array.from(
                      new Set([
                          ...config.allowedHosts,
                          "127.0.0.1",
                          "localhost",
                          "[::1]",
                      ]),
                  ),
              }
            : {}),
    });
    const transports = new McpSessionRegistry<Transport>();
    const project = new ProjectContext(config.projectRoot);
    const processes = new ProcessSessionManager();
    let httpServer: NodeHttpServer | undefined;
    let boundPort = config.port;

    const sessionCleanupTimer = setInterval(() => {
        void transports.closeIdle(MCP_SESSION_IDLE_TIMEOUT_MS);
    }, MCP_SESSION_CLEANUP_INTERVAL_MS);
    sessionCleanupTimer.unref();

    app.get("/healthz", (_req, res) => {
        res.json({ ok: true, name: "codex-mcp", projectRoot: config.projectRoot });
    });

    app.all("/mcp", async (req, res) => {
        const sessionId = req.header("mcp-session-id");
        const initializeRequest =
            req.method === "POST" && isInitializeRequest(req.body);

        try {
            let transport: Transport | undefined;

            if (sessionId) {
                transport = transports.get(sessionId);
                if (!transport) {
                    logMcpEvent("session_miss", {
                        session: sessionId.slice(0, 8),
                        host: req.headers.host ?? null,
                    });
                    sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
                    return;
                }
            } else if (initializeRequest) {
                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    onsessioninitialized: (newSessionId) => {
                        if (transport) transports.register(newSessionId, transport);
                    },
                });

                transport.onclose = () => {
                    const closedSessionId = transport?.sessionId;
                    if (closedSessionId) {
                        transports.remove(closedSessionId);
                    }
                };

                const server = createMcpServer(config, project, processes);
                await server.connect(transport);
            } else {
                sendJsonRpcError(res, 400, -32000, "No valid MCP session");
                return;
            }

            await transport.handleRequest(req, res, req.body);
        } catch (error) {
            console.error("mcp_request_error", error);
            sendJsonRpcError(res, 500, -32603, "Internal server error");
        }
    });

    return {
        config,
        project,
        getMcpUrl: () => `http://${config.host}:${boundPort}/mcp`,
        listen: () =>
            new Promise<NodeHttpServer>((resolve, reject) => {
                httpServer = app.listen(config.port, config.host, () => {
                    const address = httpServer?.address();
                    if (address && typeof address === "object") {
                        boundPort = address.port;
                    }
                    resolve(httpServer!);
                });
                httpServer.on("error", reject);
            }),
        close: async () => {
            clearInterval(sessionCleanupTimer);
            processes.shutdown();
            await transports.closeAll();
            await new Promise<void>((resolve, reject) => {
                if (!httpServer) {
                    resolve();
                    return;
                }
                httpServer.close((error) => {
                    if (error) reject(error);
                    else resolve();
                });
            });
        },
    };
}

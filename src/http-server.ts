import { randomBytes, randomUUID } from "node:crypto";
import type { Server as NodeHttpServer } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { createMcpHandler, isInitializeRequest } from "@modelcontextprotocol/server";
import type { ServerConfig } from "./config.js";
import { AgentInstructionRegistry } from "./agents/registry.js";
import { createOAuthRuntime, type OAuthRuntime } from "./auth/server.js";
import { hasAdminPassword } from "./auth/password-store.js";
import { DownstreamMcpHub } from "./downstream/hub.js";
import { ProcessOwnerPool } from "./lib/process-owner-pool.js";
import { ProcessSessionManager } from "./lib/process-sessions.js";
import { createNodeHttpAdapter } from "./lib/node-http-adapter.js";
import { requestClientKey } from "./lib/request-ip.js";
import { logMcpEvent } from "./lib/tool-log.js";
import { runtimeTelemetry } from "./lib/runtime-telemetry.js";
import { createMcpServer } from "./mcp-server.js";
import { ProjectContext } from "./project.js";
import { SkillRegistry } from "./skills/registry.js";
import { GoalStore } from "./goals/store.js";
import { UiSettingsStore } from "./ui/settings.js";
import { WorkspaceRegistry } from "./workspace/registry.js";

const INITIALIZE_RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_INITIALIZES_PER_WINDOW = 60;
const LOCAL_PROCESS_OWNER_ID = "local:noauth";

export interface CreateHttpServerOptions {
    /** Shared downstream MCP hub; defaults to an empty hub. */
    hub?: DownstreamMcpHub;
    /** Shared Codex skill registry; defaults to an empty registry. */
    skills?: SkillRegistry;
    /** Scoped AGENTS.md registry; defaults to one bound to projectRoot. */
    agents?: AgentInstructionRegistry;
    /** Optional goal storage directory override, primarily for isolated tests. */
    goalStorageDir?: string;
    /** Optional UI settings store; defaults to ~/.codex-mcp/config.json persistence. */
    uiSettings?: UiSettingsStore;
    /** Optional per-client tool policy resolver; omitted means all tools. */
    allowedToolsResolver?: (clientId?: string) => ReadonlySet<string> | undefined;
}

export interface RunningHttpServer {
    config: ServerConfig;
    project: ProjectContext;
    hub: DownstreamMcpHub;
    skills: SkillRegistry;
    agents: AgentInstructionRegistry;
    goals: GoalStore;
    uiSettings: UiSettingsStore;
    listen: () => Promise<NodeHttpServer>;
    close: () => Promise<void>;
    /** Bound URL after listen, e.g. http://127.0.0.1:3920/mcp */
    getMcpUrl: () => string;
    /** Unpredictable public-route probe used only for end-to-end tunnel verification. */
    getTunnelProbe: () => { path: string; expectedBody: string };
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
 * Create the HTTP + Streamable MCP application with optional embedded OAuth.
 *
 * @param config - Server configuration
 * @param options - Optional shared resources (downstream hub)
 * @returns Running server controls
 */
export function createHttpServer(
    config: ServerConfig,
    options: CreateHttpServerOptions = {},
): RunningHttpServer {
    const hub = options.hub ?? DownstreamMcpHub.empty();
    const skills = options.skills ?? SkillRegistry.empty();
    const project = new ProjectContext(config.projectRoot);
    const workspace = new WorkspaceRegistry(project);
    const agents = options.agents ?? new AgentInstructionRegistry(project);
    const goals = new GoalStore(project, options.goalStorageDir);
    const uiSettings = options.uiSettings ?? new UiSettingsStore();
    const allowedToolsResolver = options.allowedToolsResolver ?? (() => undefined);
    const publicHttpHostnames =
        config.allowedHosts.length > 0
            ? Array.from(
                  new Set([
                      ...config.allowedHosts,
                      "127.0.0.1",
                      "localhost",
                      "[::1]",
                  ]),
              )
            : undefined;
    const app = createMcpExpressApp({
        host: config.host,
        ...(publicHttpHostnames
            ? {
                  allowedHosts: publicHttpHostnames,
                  // When binding to loopback behind a public reverse proxy, the SDK
                  // otherwise installs localhost-only Origin validation even though
                  // Host validation already knows about the public tunnel hostname.
                  allowedOrigins: publicHttpHostnames,
              }
            : {}),
    });
    const processOwners = new ProcessOwnerPool(new ProcessSessionManager());
    const mcpHandler = createMcpHandler(
        (context) => {
            const authClientId = config.oauthRequired ? context.authInfo?.clientId : undefined;
            const processLease = processOwners.acquire(
                resolveProcessOwnerId(config.oauthRequired, authClientId),
            );
            let released = false;
            const releaseLease = (): void => {
                if (released) return;
                released = true;
                processLease.release();
            };

            try {
                const server = createMcpServer(
                    config,
                    project,
                    processLease.processes,
                    hub,
                    skills,
                    agents,
                    workspace,
                    goals,
                    uiSettings,
                    allowedToolsResolver(authClientId),
                );
                const previousOnClose = server.server.onclose;
                server.server.onclose = () => {
                    try {
                        previousOnClose?.();
                    } finally {
                        releaseLease();
                    }
                };
                return server;
            } catch (error) {
                releaseLease();
                throw error;
            }
        },
        {
            legacy: "stateless",
            responseMode: "auto",
            keepAliveMs: 10_000,
            onerror: (error) => {
                logMcpEvent("mcp_handler_error", { error: error.message });
            },
        },
    );
    const nodeMcpHandler = createNodeHttpAdapter(mcpHandler, {
        onerror: (error) => {
            logMcpEvent("mcp_node_adapter_error", { error: error.message });
        },
    });
    let httpServer: NodeHttpServer | undefined;
    let boundPort = config.port;
    let oauthRuntimePromise: Promise<OAuthRuntime> | undefined;
    const tunnelProbe = {
        path: `/.well-known/codex-mcp-tunnel-check/${randomBytes(24).toString("base64url")}`,
        expectedBody: randomBytes(32).toString("base64url"),
    };
    const initializeLimiter = new FixedWindowLimiter(
        INITIALIZE_RATE_WINDOW_MS,
        MAX_INITIALIZES_PER_WINDOW,
    );

    const getOAuthRuntime = (): Promise<OAuthRuntime> => {
        if (!oauthRuntimePromise) {
            const resourceUrl = new URL(
                config.publicMcpUrl ?? `http://${config.host}:${boundPort}/mcp`,
            );
            oauthRuntimePromise = createOAuthRuntime(resourceUrl);
        }
        return oauthRuntimePromise;
    };

    // OAuth discovery/authorize/token/register/revoke remain public. The router
    // falls through for non-OAuth paths.
    app.use((req, res, next) => {
        if (!config.oauthRequired) {
            next();
            return;
        }
        void getOAuthRuntime()
            .then((runtime) => runtime.router(req, res, next))
            .catch(next);
    });

    app.get("/healthz", (_req, res) => {
        res.json({ ok: true });
    });

    // A high-entropy path and independent high-entropy response let the local CLI prove that
    // the public hostname reaches this exact process. This catches a Cloudflare DNS/route that
    // accidentally points at another tunnel even when proxied CNAME flattening hides the target.
    app.get(tunnelProbe.path, (_req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.send(tunnelProbe.expectedBody);
    });

    // Observe the complete /mcp surface before bearer auth/rate limiting so
    // rejected 401/429 requests are included in HTTP error metrics too.
    app.all("/mcp", (req, res, next) => {
        const requestId = randomUUID();
        const startedAt = performance.now();
        let finished = false;
        let telemetryFinished = false;
        runtimeTelemetry.beginHttpRequest();

        const finishTelemetry = (aborted: boolean): number => {
            const durationMs = performance.now() - startedAt;
            if (!telemetryFinished) {
                telemetryFinished = true;
                runtimeTelemetry.finishHttpRequest(durationMs, res.statusCode, aborted);
            }
            return Math.round(durationMs);
        };

        res.once("finish", () => {
            finished = true;
            const durationMs = finishTelemetry(false);
            if (res.statusCode >= 400) {
                logMcpEvent("mcp_http_error_response", {
                    request: requestId.slice(0, 8),
                    method: req.method,
                    status: res.statusCode,
                    session: req.header("mcp-session-id")?.slice(0, 8),
                    durationMs,
                });
            }
        });
        res.once("close", () => {
            if (finished) return;
            const durationMs = finishTelemetry(true);
            logMcpEvent("mcp_http_aborted", {
                request: requestId.slice(0, 8),
                method: req.method,
                status: res.statusCode,
                session: req.header("mcp-session-id")?.slice(0, 8),
                durationMs,
            });
        });
        next();
    });

    app.all("/mcp", (req, res, next) => {
        if (!config.oauthRequired) {
            next();
            return;
        }
        void getOAuthRuntime()
            .then((runtime) => runtime.bearerAuth(req, res, next))
            .catch(next);
    });

    app.all("/mcp", (req, res, next) => {
        if (req.method === "POST" && isInitializeRequest(req.body)) {
            const rateKey = requestClientKey(req);
            if (!initializeLimiter.take(rateKey)) {
                sendJsonRpcError(res, 429, -32000, "Too many MCP initialize requests");
                return;
            }
        }
        next();
    });

    app.all("/mcp", async (req, res) => {
        await nodeMcpHandler(req, res, req.body);
    });

    return {
        config,
        project,
        hub,
        skills,
        agents,
        goals,
        uiSettings,
        getMcpUrl: () => `http://${config.host}:${boundPort}/mcp`,
        getTunnelProbe: () => ({ ...tunnelProbe }),
        listen: async () => {
            if (config.oauthRequired && !(await hasAdminPassword())) {
                throw new Error(
                    "还没有设置连接密码，请先运行 `codex-mcp setup`。",
                );
            }
            const listening = await new Promise<NodeHttpServer>((resolve, reject) => {
                httpServer = app.listen(config.port, config.host, () => {
                    const address = httpServer?.address();
                    if (address && typeof address === "object") {
                        boundPort = address.port;
                    }
                    resolve(httpServer!);
                });
                httpServer.on("error", reject);
            });
            if (config.oauthRequired) {
                try {
                    await getOAuthRuntime();
                } catch (error) {
                    await closeNodeServer(httpServer);
                    httpServer = undefined;
                    throw error;
                }
            }
            return listening;
        },
        close: async () => {
            await mcpHandler.close();
            await processOwners.shutdown();
            await hub.close();
            await closeNodeServer(httpServer);
            httpServer = undefined;
        },
    };
}

function resolveProcessOwnerId(
    oauthRequired: boolean,
    authClientId: string | undefined,
): string {
    if (!oauthRequired) return LOCAL_PROCESS_OWNER_ID;
    if (!authClientId) {
        throw new Error("Authenticated MCP request is missing an OAuth client id");
    }
    return `oauth:${authClientId}`;
}

async function closeNodeServer(server: NodeHttpServer | undefined): Promise<void> {
    if (!server || !server.listening) return;
    await new Promise<void>((resolve, reject) => {
        server.close((error) => {
            if (error) reject(error);
            else resolve();
        });
    });
}

class FixedWindowLimiter {
    private readonly entries = new Map<string, { count: number; resetAt: number }>();

    constructor(
        private readonly windowMs: number,
        private readonly max: number,
    ) {}

    take(key: string): boolean {
        const now = Date.now();
        const current = this.entries.get(key);
        if (!current || current.resetAt <= now) {
            this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
            if (this.entries.size > 512) this.prune(now);
            return true;
        }
        current.count += 1;
        return current.count <= this.max;
    }

    private prune(now: number): void {
        for (const [key, entry] of this.entries) {
            if (entry.resetAt <= now) this.entries.delete(key);
        }
    }
}

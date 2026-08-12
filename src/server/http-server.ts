import { randomBytes, randomUUID } from "node:crypto";
import type { Server as NodeHttpServer } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { createMcpHandler, isInitializeRequest } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config/loader.js";
import { AgentInstructionRegistry } from "../agents/registry.js";
import { createOAuthRuntime, type OAuthRuntime } from "../auth/server.js";
import { hasAdminPassword } from "../auth/password-store.js";
import { DownstreamMcpHub } from "../downstream/hub.js";
import { ProcessOwnerPool } from "../lib/process/owner-pool.js";
import { CurrentOwnerProcessSessions } from "../lib/process/current-owner.js";
import { ProcessSessionManager } from "../lib/process/sessions.js";
import { createNodeHttpAdapter } from "../lib/http/node-adapter.js";
import { requestClientKey } from "../lib/http/request-ip.js";
import { logMcpEvent } from "../lib/tool/log.js";
import { runtimeTelemetry } from "../lib/util/telemetry.js";
import { createMcpServer } from "./mcp-server.js";
import { ProjectContext } from "../config/project.js";
import { SkillRegistry } from "../skills/registry.js";
import { GoalStore } from "../goals/store.js";
import { UiSettingsStore } from "../ui/settings.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
import type { PermissionGrantStore } from "../permissions/store.js";
import { PermissionRuntime } from "../permissions/runtime.js";
import type { CapabilityManager } from "../capabilities/manager.js";
import {
    BindingProjectScopeProvider,
    type ToolScopeProvider,
    type ToolScopeTryProvider,
} from "./project-router.js";
import type { ProjectRegistry } from "../projects/registry.js";
import type { BindingStore } from "../projects/bindings.js";
import type { ProjectRuntimeManager } from "../projects/runtime.js";
import { PACKAGE_VERSION } from "./version.js";

const INITIALIZE_RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_INITIALIZES_PER_WINDOW = 60;
const LOCAL_PROCESS_OWNER_ID = "local:noauth";
const DAEMON_STARTED_AT = Date.now();

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export interface CreateHttpServerOptions {
    /** Shared downstream MCP hub; defaults to an empty hub. */
    hub?: DownstreamMcpHub;
    /** Shared imported skill registry; defaults to an empty registry. */
    skills?: SkillRegistry;
    /** External capability source manager used by reload/status tools. */
    capabilities?: CapabilityManager;
    /** Scoped AGENTS.md registry; defaults to one bound to projectRoot. */
    agents?: AgentInstructionRegistry;
    /** Optional goal storage directory override, primarily for isolated tests. */
    goalStorageDir?: string;
    /** Optional UI settings store; defaults to ~/.codex-mcp/config.json persistence. */
    uiSettings?: UiSettingsStore;
    /** Optional per-client tool policy resolver; omitted means all tools. */
    allowedToolsResolver?: (clientId?: string) => ReadonlySet<string> | undefined;
    /** Optional permission persistence backend; defaults to ~/.codex-mcp/config.json. */
    permissionStore?: PermissionGrantStore;
    /** Multi-project daemon mode: registers control routes and resolves project scope per tool call. */
    daemon?: DaemonServerOptions;
}

export interface DaemonServerOptions {
    registry: ProjectRegistry;
    bindings: BindingStore;
    runtimes: ProjectRuntimeManager;
    /** Random loopback-only control token for /daemon/* routes. */
    controlToken: string;
    /** Reports whether the Cloudflare sidecar is currently running. */
    tunnelStatus: () => { running: boolean };
    /** Runs the daemon shutdown sequence (stop tunnel, close server, remove daemon state). */
    onShutdown: () => Promise<void>;
}

export interface RunningHttpServer {
    config: ServerConfig;
    project: ProjectContext;
    hub: DownstreamMcpHub;
    skills: SkillRegistry;
    capabilities?: CapabilityManager;
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

export function createHttpServer(
    config: ServerConfig,
    options: CreateHttpServerOptions = {},
): RunningHttpServer {
    const daemonOptions = options.daemon;
    const hub = options.hub ?? DownstreamMcpHub.empty();
    const skills = options.skills ?? SkillRegistry.empty();
    const project = new ProjectContext(config.projectRoot, config.workspaceRoots ?? [config.projectRoot]);
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
    const rootProcesses = new ProcessSessionManager();
    const processOwners = new ProcessOwnerPool(rootProcesses);
    const permissionRuntime = new PermissionRuntime();
    const mcpHandler = createMcpHandler(
        (context) => {
            const authClientId = config.oauthRequired ? context.authInfo?.clientId : undefined;
            const processOwnerId = resolveProcessOwnerId(config.oauthRequired, authClientId);
            const permissionOwnerId = resolvePermissionOwnerId(
                config.oauthRequired,
                authClientId,
                context.authInfo?.extra,
                context.requestInfo,
            );
            const processes = new CurrentOwnerProcessSessions(
                rootProcesses,
                processOwners,
                processOwnerId,
            );
            if (daemonOptions) {
                const provider = new BindingProjectScopeProvider(
                    daemonOptions.registry,
                    daemonOptions.bindings,
                    daemonOptions.runtimes,
                    processOwnerId,
                );
                const scope: ToolScopeProvider = () => provider.resolveProject();
                const tryScope: ToolScopeTryProvider = () => provider.tryResolveProject();
                return createMcpServer({
                    config,
                    scope,
                    tryScope,
                    hub,
                    skills,
                    capabilities: options.capabilities,
                    uiSettings,
                    allowedTools: allowedToolsResolver(authClientId),
                    permissionStore: options.permissionStore,
                    permissionRuntime,
                    permissionOwnerId,
                    projectTools: {
                        registry: daemonOptions.registry,
                        bindings: daemonOptions.bindings,
                        runtimes: daemonOptions.runtimes,
                        fallbackOwnerId: processOwnerId,
                    },
                });
            }
            return createMcpServer({
                config,
                scope: () => ({ project, workspace, agents, goals, processes }),
                tryScope: () => ({ project, workspace, agents, goals, processes }),
                hub,
                skills,
                capabilities: options.capabilities,
                uiSettings,
                allowedTools: allowedToolsResolver(authClientId),
                permissionStore: options.permissionStore,
                permissionRuntime,
                permissionOwnerId,
            });
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
    const instanceId = randomBytes(18).toString("base64url");
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
        res.setHeader("Cache-Control", "no-store");
        res.json({ ok: true, instance: instanceId });
    });

    // A high-entropy path and independent high-entropy response let the local CLI prove that
    // the public hostname reaches this exact process. This catches a Cloudflare DNS/route that
    // accidentally points at another tunnel even when proxied CNAME flattening hides the target.
    app.get(tunnelProbe.path, (_req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.send(tunnelProbe.expectedBody);
    });

    if (daemonOptions) {
        registerDaemonControlRoutes(app, config, daemonOptions, () => boundPort);
    }

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
        ...(options.capabilities ? { capabilities: options.capabilities } : {}),
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
            permissionRuntime.clear();
            await hub.close();
            if (daemonOptions) {
                await daemonOptions.runtimes.shutdownAll();
            }
            await closeNodeServer(httpServer);
            httpServer = undefined;
        },
    };
}

function registerDaemonControlRoutes(
    app: ReturnType<typeof createMcpExpressApp>,
    config: ServerConfig,
    daemon: DaemonServerOptions,
    boundPort: () => number,
): void {
    // Loopback-only + control token gate for every /daemon/* route.
    app.use("/daemon", (req, res, next) => {
        const remote = req.socket.remoteAddress ?? "";
        if (!isLoopbackAddress(remote)) {
            res.status(403).json({ error: "forbidden" });
            return;
        }
        const token = req.header("x-codex-control-token");
        if (token !== daemon.controlToken) {
            res.status(401).json({ error: "unauthorized" });
            return;
        }
        next();
    });

    app.get("/daemon/status", (_req, res) => {
        const now = Date.now();
        const projects = daemon.registry
            .list()
            .map((project) => ({
                ...project,
                boundSessions: daemon.bindings.countForProject(project.id),
            }))
            .sort((left, right) => left.name.localeCompare(right.name));
        res.json({
            ok: true,
            version: PACKAGE_VERSION,
            mode: config.local ? "local" : "public",
            pid: process.pid,
            startedAt: DAEMON_STARTED_AT,
            uptimeMs: now - DAEMON_STARTED_AT,
            localUrl: `http://${config.host}:${boundPort()}/mcp`,
            ...(config.publicMcpUrl ? { publicMcpUrl: config.publicMcpUrl } : {}),
            tunnel: { running: daemon.tunnelStatus().running },
            projects,
        });
    });

    app.post("/daemon/projects", async (req, res) => {
        try {
            const body = (req.body ?? {}) as { path?: unknown; name?: unknown };
            if (typeof body.path !== "string" || !body.path.trim()) {
                res.status(400).json({ error: "path is required" });
                return;
            }
            const name = typeof body.name === "string" ? body.name : undefined;
            const project = daemon.registry.register({ path: body.path, name });
            logMcpEvent("daemon_project_registered", { project: project.id });
            res.json({ ok: true, project, projects: daemon.registry.list() });
        } catch (error) {
            res.status(400).json({ error: errorMessage(error) });
        }
    });

    app.delete("/daemon/projects/:id", async (req, res) => {
        try {
            const id = decodeURIComponent(req.params.id);
            const byPath =
                typeof req.query.path === "string" ? decodeURIComponent(req.query.path) : undefined;
            const target = daemon.registry.getById(id) ?? (byPath ? daemon.registry.getByPath(byPath) : undefined);
            if (!target) {
                res.status(404).json({ error: `project not found: ${id}` });
                return;
            }
            const removed = daemon.registry.deactivateById(target.id);
            if (removed) {
                const invalidated = daemon.bindings.invalidateProject(target.id);
                await daemon.runtimes.remove(target.id);
                logMcpEvent("daemon_project_deactivated", {
                    project: target.id,
                    bindingsInvalidated: invalidated,
                });
            }
            res.json({ ok: true, removed: Boolean(removed), project: removed, projects: daemon.registry.list() });
        } catch (error) {
            res.status(400).json({ error: errorMessage(error) });
        }
    });

    app.post("/daemon/shutdown", (_req, res) => {
        res.json({ ok: true });
        setImmediate(() => {
            void daemon.onShutdown().catch((error: unknown) => {
                logMcpEvent("daemon_shutdown_failed", { error: errorMessage(error) });
            });
        });
    });
}

function isLoopbackAddress(remote: string): boolean {
    const normalized = remote.replace(/^::ffff:/, "");
    return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
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

function resolvePermissionOwnerId(
    oauthRequired: boolean,
    authClientId: string | undefined,
    authExtra: Record<string, unknown> | undefined,
    requestInfo?: Request,
): string {
    const transportSessionId = requestInfo?.headers.get("mcp-session-id")?.trim();
    if (transportSessionId) {
        return `mcp-session:${transportSessionId}`;
    }
    if (!oauthRequired) return LOCAL_PROCESS_OWNER_ID;
    const oauthSessionId = authExtra?.codexMcpSessionId;
    if (typeof oauthSessionId === "string" && oauthSessionId.length > 0) {
        return `oauth-session:${oauthSessionId}`;
    }
    return resolveProcessOwnerId(true, authClientId);
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

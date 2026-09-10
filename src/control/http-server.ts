import { randomBytes } from "node:crypto";
import type { Server as NodeHttpServer } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { controllerPanelUrl, type ControllerState } from "./state.js";
import { OperationManager } from "./operations.js";
import {
    addProject,
    configureCloudflarePublicAccess,
    configureExternalPublicAccess,
    discoverCloudflareForSetup,
    generateConnectionPassword,
    getControlStatus,
    getProject,
    getSetupSummary,
    listProjects,
    readLogs,
    removeProject,
    restartRuntime,
    runDoctorService,
    saveCapabilities,
    selfUpdate,
    setConnectionPassword,
    startRuntime,
    stopRuntime,
    verifyPublicAccess,
    type RuntimeStartInput,
} from "./services.js";
import { spawnReplacementController } from "./control.js";
import { localConsoleHtml } from "../ui/local-console.js";
import { PACKAGE_VERSION } from "../server/version.js";

const SESSION_COOKIE = "codex_console";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BROWSER_SESSIONS = 16;
const SSE_HEARTBEAT_MS = 15_000;
const POLL_MS = 300;

interface BrowserSession {
    id: string;
    csrf: string;
    expiresAt: number;
}

export interface ControllerHttpServerOptions {
    state: Omit<ControllerState, "port">;
    onShutdown: () => Promise<void>;
    onReplaced: () => Promise<void>;
}

export interface RunningControllerHttpServer {
    listen: () => Promise<NodeHttpServer>;
    close: () => Promise<void>;
    getPort: () => number;
}

export function createControllerHttpServer(options: ControllerHttpServerOptions): RunningControllerHttpServer {
    const app = express();
    app.disable("x-powered-by");
    app.use(express.json({ limit: "64kb" }));
    const operations = new OperationManager();
    const sessions = new Map<string, BrowserSession>();
    let server: NodeHttpServer | undefined;
    let port = 0;

    app.use((req, res, next) => {
        if (!isLocalRequest(req, port)) {
            res.status(403).type("text/plain").send("forbidden");
            return;
        }
        res.setHeader("cache-control", "no-store");
        res.setHeader("x-content-type-options", "nosniff");
        res.setHeader("referrer-policy", "no-referrer");
        next();
    });

    app.get("/", (_req, res) => {
        const session = createBrowserSession(sessions);
        const nonce = randomBytes(18).toString("base64url");
        res.setHeader(
            "content-security-policy",
            `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        );
        res.setHeader(
            "set-cookie",
            `${SESSION_COOKIE}=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
        );
        res.type("html").send(localConsoleHtml({ nonce, csrfToken: session.csrf, version: PACKAGE_VERSION }));
    });

    app.use("/api", (req, res, next) => {
        const control = req.header("x-codex-controller-token");
        if (control === options.state.controlToken) {
            (req as AuthenticatedRequest).controllerAuth = true;
            next();
            return;
        }
        const session = readBrowserSession(req, sessions);
        if (!session) {
            res.status(401).json({ error: "unauthorized" });
            return;
        }
        (req as AuthenticatedRequest).browserSession = session;
        if (!isReadMethod(req.method)) {
            if (!sameOriginMutation(req, port) || req.header("x-csrf-token") !== session.csrf) {
                res.status(403).json({ error: "invalid origin or csrf token" });
                return;
            }
        }
        next();
    });

    app.get("/api/controller/status", async (_req, res) => {
        try {
            const runtime = await getControlStatus();
            res.json({
                apiVersion: options.state.apiVersion,
                ok: true,
                pid: process.pid,
                version: PACKAGE_VERSION,
                startedAt: options.state.startedAt,
                uptimeMs: Date.now() - Date.parse(options.state.startedAt),
                panelUrl: controllerPanelUrl({ host: options.state.host, port }),
                runtime,
            });
        } catch (error) {
            sendError(res, error);
        }
    });

    app.post("/api/runtime/start", async (req, res) => {
        try {
            res.json({ ok: true, status: await startRuntime(parseRuntimeStart(req.body)) });
        } catch (error) {
            sendError(res, error, 400);
        }
    });

    app.post("/api/runtime/stop", async (_req, res) => {
        try {
            res.json({ ok: true, stopped: await stopRuntime(), status: await getControlStatus() });
        } catch (error) {
            sendError(res, error);
        }
    });

    app.post("/api/runtime/restart", async (_req, res) => {
        try {
            res.json({ ok: true, status: await restartRuntime() });
        } catch (error) {
            sendError(res, error, 400);
        }
    });

    app.get("/api/projects", async (_req, res) => {
        try { res.json({ ok: true, projects: await listProjects() }); }
        catch (error) { sendError(res, error); }
    });

    app.get("/api/projects/:target", async (req, res) => {
        try {
            const project = await getProject(req.params.target);
            if (!project) { res.status(404).json({ error: "project not found" }); return; }
            res.json({ ok: true, project });
        } catch (error) { sendError(res, error, 400); }
    });

    app.post("/api/projects", async (req, res) => {
        try {
            const body = asRecord(req.body);
            const path = requiredString(body.path, "path");
            const intent = parseIntent(body);
            const project = await addProject(path, intent);
            res.json({ ok: true, project, projects: await listProjects() });
        } catch (error) { sendError(res, error, 400); }
    });

    app.delete("/api/projects/:target", async (req, res) => {
        try {
            const result = await removeProject(req.params.target);
            res.json({ ok: true, ...result, projects: await listProjects() });
        } catch (error) { sendError(res, error, 400); }
    });

    app.get("/api/logs", (req, res) => {
        try {
            const raw = Number.parseInt(String(req.query.lines ?? "100"), 10);
            res.json({ ok: true, ...readLogs(Number.isInteger(raw) ? raw : 100) });
        } catch (error) { sendError(res, error); }
    });

    app.get("/api/logs/stream", async (req, res) => {
        openSse(res);
        let previous = "";
        const heartbeat = setInterval(() => res.write(": keepalive\n\n"), SSE_HEARTBEAT_MS);
        try {
            while (!req.destroyed && !res.destroyed) {
                const current = readLogs(250);
                if (current.text !== previous) {
                    previous = current.text;
                    writeSse(res, "logs", current);
                }
                await sleep(500);
            }
        } finally {
            clearInterval(heartbeat);
            res.end();
        }
    });

    app.get("/api/setup/summary", async (req, res) => {
        try {
            const workspace = typeof req.query.workspace === "string" ? req.query.workspace : process.cwd();
            res.json({ ok: true, ...(await getSetupSummary(workspace)) });
        } catch (error) { sendError(res, error); }
    });

    app.post("/api/setup/capabilities", (req, res) => {
        try {
            const body = asRecord(req.body);
            const config = body.config;
            if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("config is required");
            res.json({ ok: true, capabilities: saveCapabilities(config) });
        } catch (error) { sendError(res, error, 400); }
    });

    app.post("/api/auth/password", async (req, res) => {
        try {
            const password = requiredString(asRecord(req.body).password, "password");
            await setConnectionPassword(password);
            res.json({ ok: true });
        } catch (error) { sendError(res, error, 400); }
    });

    app.post("/api/auth/generate", async (_req, res) => {
        try { res.json({ ok: true, password: await generateConnectionPassword() }); }
        catch (error) { sendError(res, error); }
    });

    app.post("/api/doctor", (req, res) => {
        const body = asRecord(req.body);
        const fix = body.fix === true;
        res.status(202).json({
            ok: true,
            operation: operations.start(fix ? "doctor-fix" : "doctor", async (context) => {
                context.phase(fix ? "执行安全本机修复" : "运行诊断");
                return await runDoctorService(fix);
            }),
        });
    });

    app.post("/api/setup/public/check", (_req, res) => {
        res.status(202).json({
            ok: true,
            operation: operations.start("public-check", async (context) => {
                context.phase("验证公网连接");
                return await verifyPublicAccess();
            }),
        });
    });

    app.post("/api/setup/cloudflare/discover", (req, res) => {
        const forceLogin = asRecord(req.body).forceLogin === true;
        res.status(202).json({
            ok: true,
            operation: operations.start("cloudflare-discover", async (context) => {
                context.phase(forceLogin ? "打开 Cloudflare 登录" : "读取 Cloudflare 登录");
                const result = await discoverCloudflareForSetup(forceLogin, {
                    signal: context.signal,
                    onLoginOutput: (text) => {
                        for (const line of text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
                            context.note(line.slice(0, 1000));
                        }
                    },
                });
                context.phase("Cloudflare 域名已读取");
                return result;
            }),
        });
    });

    app.post("/api/setup/public/external", (req, res) => {
        try {
            const domain = requiredString(asRecord(req.body).domain, "domain");
            res.status(202).json({
                ok: true,
                operation: operations.start("setup-external", async (context) =>
                    await configureExternalPublicAccess(domain, {
                        signal: context.signal,
                        onPhase: context.phase,
                    })),
            });
        } catch (error) { sendError(res, error, 400); }
    });

    app.post("/api/setup/public/cloudflare", (req, res) => {
        try {
            const body = asRecord(req.body);
            const zone = requiredString(body.zone, "zone");
            const prefix = requiredString(body.prefix, "prefix");
            const allowDnsOverwrite = body.allowDnsOverwrite === true;
            res.status(202).json({
                ok: true,
                operation: operations.start("setup-cloudflare", async (context) =>
                    await configureCloudflarePublicAccess(
                        { zone, prefix, allowDnsOverwrite },
                        { signal: context.signal, onPhase: context.phase },
                    )),
            });
        } catch (error) { sendError(res, error, 400); }
    });

    app.post("/api/update", (_req, res) => {
        res.status(202).json({
            ok: true,
            operation: operations.start("update", async (context) => {
                const before = await getControlStatus();
                const intent = before.runtime?.runtimeIntent;
                context.phase("安装新版本");
                await selfUpdate({
                    signal: context.signal,
                    onOutput: (text) => {
                        for (const line of text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
                            context.note(line.slice(0, 1000));
                        }
                    },
                });
                context.signal.throwIfAborted();
                if (intent) {
                    context.phase("重启 MCP Runtime");
                    await stopRuntime();
                    await startRuntime({ ...intent, intentSpecified: true });
                }
                context.phase("启动新版 Controller");
                const replacement = await spawnReplacementController();
                const reloadUrl = controllerPanelUrl(replacement.state);
                setTimeout(() => { void options.onReplaced(); }, 5_000).unref?.();
                return { version: replacement.state.version, reloadUrl };
            }),
        });
    });

    app.get("/api/operations/:id", (req, res) => {
        const operation = operations.get(req.params.id);
        if (!operation) { res.status(404).json({ error: "operation not found" }); return; }
        res.json({ ok: true, operation });
    });

    app.get("/api/operations/:id/events", async (req, res) => {
        const initial = operations.get(req.params.id);
        if (!initial) { res.status(404).json({ error: "operation not found" }); return; }
        openSse(res);
        let previous = "";
        const heartbeat = setInterval(() => res.write(": keepalive\n\n"), SSE_HEARTBEAT_MS);
        try {
            while (!req.destroyed && !res.destroyed) {
                const current = operations.get(req.params.id);
                if (!current) break;
                const encoded = JSON.stringify(current);
                if (encoded !== previous) {
                    previous = encoded;
                    writeSse(res, "operation", current);
                }
                if (current.state !== "running") break;
                await sleep(POLL_MS);
            }
        } finally {
            clearInterval(heartbeat);
            res.end();
        }
    });

    app.delete("/api/operations/:id", (req, res) => {
        const operation = operations.cancel(req.params.id);
        if (!operation) { res.status(404).json({ error: "operation not found" }); return; }
        res.json({ ok: true, operation });
    });

    app.post("/api/controller/shutdown", (req, res) => {
        if (!(req as AuthenticatedRequest).controllerAuth) {
            res.status(403).json({ error: "control token required" });
            return;
        }
        res.json({ ok: true });
        setImmediate(() => { void options.onShutdown(); });
    });

    app.post("/api/controller/retire", (req, res) => {
        if (!(req as AuthenticatedRequest).controllerAuth) {
            res.status(403).json({ error: "control token required" });
            return;
        }
        res.json({ ok: true });
        setImmediate(() => { void options.onReplaced(); });
    });

    app.use((_req, res) => res.status(404).json({ error: "not found" }));

    return {
        getPort: () => port,
        listen: async () => {
            server = await new Promise<NodeHttpServer>((resolve, reject) => {
                const listening = app.listen(0, options.state.host, (error?: Error) => {
                    if (error) { reject(error); return; }
                    const address = listening.address();
                    if (!address || typeof address === "string") {
                        reject(new Error("Controller 没有获得 TCP 监听地址"));
                        return;
                    }
                    port = address.port;
                    resolve(listening);
                });
            });
            return server;
        },
        close: async () => {
            if (!server?.listening) return;
            await new Promise<void>((resolveClose, reject) => {
                server!.close((error) => error ? reject(error) : resolveClose());
            });
            server = undefined;
        },
    };
}

interface AuthenticatedRequest extends Request {
    controllerAuth?: boolean;
    browserSession?: BrowserSession;
}

function parseRuntimeStart(value: unknown): RuntimeStartInput {
    const body = asRecord(value);
    return {
        ...parseIntent(body),
        ...(typeof body.projectPath === "string" && body.projectPath.trim() ? { projectPath: body.projectPath.trim() } : {}),
    };
}

function parseIntent(body: Record<string, unknown>): RuntimeStartInput {
    return {
        local: body.local === true,
        noTunnel: body.noTunnel === true,
        tunnelLogs: body.tunnelLogs === true,
        intentSpecified: body.intentSpecified === true,
    };
}

function asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
    return value.trim();
}

function createBrowserSession(sessions: Map<string, BrowserSession>): BrowserSession {
    const now = Date.now();
    for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
    while (sessions.size >= MAX_BROWSER_SESSIONS) sessions.delete(sessions.keys().next().value as string);
    const session: BrowserSession = {
        id: randomBytes(24).toString("base64url"),
        csrf: randomBytes(24).toString("base64url"),
        expiresAt: now + SESSION_TTL_MS,
    };
    sessions.set(session.id, session);
    return session;
}

function readBrowserSession(req: Request, sessions: Map<string, BrowserSession>): BrowserSession | undefined {
    const id = readCookie(req.header("cookie"), SESSION_COOKIE);
    if (!id) return undefined;
    const session = sessions.get(id);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
        sessions.delete(id);
        return undefined;
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return session;
}

function sameOriginMutation(req: Request, port: number): boolean {
    const origin = req.header("origin");
    if (!origin) return false;
    try {
        const parsed = new URL(origin);
        const host = parsed.hostname.toLowerCase();
        return parsed.protocol === "http:" &&
            (host === "127.0.0.1" || host === "localhost" || host === "::1") &&
            Number(parsed.port || "80") === port;
    } catch {
        return false;
    }
}

function isLocalRequest(req: Request, port: number): boolean {
    const remote = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    if (remote !== "127.0.0.1" && remote !== "::1") return false;
    const rawHost = req.header("host")?.trim().toLowerCase();
    if (!rawHost) return false;
    let host: string;
    let hostPort = "";
    if (rawHost.startsWith("[")) {
        const close = rawHost.indexOf("]");
        if (close < 0) return false;
        host = rawHost.slice(1, close);
        hostPort = rawHost.slice(close + 1).replace(/^:/, "");
    } else {
        const parts = rawHost.split(":");
        host = parts[0] ?? "";
        hostPort = parts[1] ?? "";
    }
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return false;
    return port === 0 || hostPort === "" || hostPort === String(port);
}

function readCookie(header: string | undefined, name: string): string | undefined {
    if (!header) return undefined;
    for (const part of header.split(";")) {
        const [key, ...rest] = part.trim().split("=");
        if (key === name) return rest.join("=") || undefined;
    }
    return undefined;
}

function isReadMethod(method: string): boolean {
    return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function openSse(res: Response): void {
    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders();
}

function writeSse(res: Response, event: string, value: unknown): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

function sendError(res: Response, error: unknown, status = 500): void {
    res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

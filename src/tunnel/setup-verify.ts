import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { isIP } from "node:net";
import { safeHttpGet } from "../lib/http/safe-http.js";
import { CloudflaredSidecar } from "./sidecar.js";
import { verifyTunnelRoute, type TunnelProbe } from "./verify.js";

export interface SetupPublicRoute {
    domain: string;
    useCloudflared: boolean;
    bin?: string;
    tunnelId?: string;
    configPath?: string;
}

export interface SetupPublicVerificationResult {
    publicMcpUrl: string;
    tunnel?: { protocol?: string; location?: string };
}

export interface SetupPublicVerificationOptions {
    /** Runs only after the local origin and candidate connector are ready. */
    beforePublicVerify?: () => Promise<void>;
    totalTimeoutMs?: number;
    signal?: AbortSignal;
}

export type SetupPortState = "available" | "codex-mcp" | "occupied";

class SetupPortInUseError extends Error {}

/**
 * Verify setup end-to-end before reporting success.
 *
 * A minimal HTTP server temporarily occupies the configured local service port and
 * exposes only an unpredictable probe route. Cloudflare mode also starts the same
 * managed sidecar/config that normal `codex-mcp` startup will use. The public HTTPS
 * fetch must return the exact random probe response from this process.
 */
export async function verifySetupPublicRoute(
    route: SetupPublicRoute,
    host: string,
    port: number,
    options: SetupPublicVerificationOptions = {},
): Promise<SetupPublicVerificationResult> {
    const probe: TunnelProbe = {
        path: `/.well-known/codex-mcp-tunnel-check/${randomBytes(24).toString("base64url")}`,
        expectedBody: randomBytes(32).toString("base64url"),
    };
    const listenHost = localServiceHost(host);
    const server = createProbeServer(probe);
    let sidecar: CloudflaredSidecar | undefined;

    try {
        await listenProbeServer(server, listenHost, port);

        let tunnel: SetupPublicVerificationResult["tunnel"];
        if (route.useCloudflared) {
            if (!route.bin || !route.tunnelId || !route.configPath) {
                throw new Error("Cloudflare Tunnel 配置不完整，无法验证公网连接");
            }
            sidecar = new CloudflaredSidecar({
                bin: route.bin,
                tunnelId: route.tunnelId,
                configPath: route.configPath,
            });
            tunnel = await sidecar.start();
        }

        await options.beforePublicVerify?.();
        const publicMcpUrl = `https://${route.domain}/mcp`;
        await verifyTunnelRoute(publicMcpUrl, probe, {
            totalTimeoutMs: options.totalTimeoutMs ?? 300_000,
            signal: options.signal,
        });
        return { publicMcpUrl, tunnel };
    } finally {
        await sidecar?.stop().catch(() => undefined);
        await closeProbeServer(server);
    }
}

export async function verifyRunningPublicRoute(
    domain: string,
    host: string,
    port: number,
    options: { totalTimeoutMs?: number } = {},
): Promise<SetupPublicVerificationResult> {
    const totalTimeoutMs = options.totalTimeoutMs ?? 120_000;
    if (!Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs < 1_000) {
        throw new Error("totalTimeoutMs must be an integer greater than or equal to 1000");
    }
    const localHealthUrl = `http://${formatHost(localServiceHost(host))}:${port}/healthz`;
    const publicHealthUrl = `https://${domain}/healthz`;
    const [localHealth, publicHealth] = await Promise.all([
        readHealthInstance(localHealthUrl, true, totalTimeoutMs),
        readHealthInstance(publicHealthUrl, false, totalTimeoutMs),
    ]);
    if (localHealth !== publicHealth) {
        throw new Error(
            "本机端口已经有 codex-mcp 在运行，但公网地址没有指向同一个实例。请停止当前服务后重新运行 setup，或检查 Tunnel / DNS 配置。",
        );
    }
    return { publicMcpUrl: `https://${domain}/mcp` };
}

/** Fail before any Cloudflare mutation if setup cannot own the local port. */
export async function assertSetupPortAvailable(
    host: string,
    port: number,
): Promise<void> {
    const state = await inspectSetupPort(host, port);
    if (state === "available") return;
    if (state === "codex-mcp") {
        throw new Error(
            `本机端口 ${port} 上有 codex-mcp 在运行，但缺少可用的 daemon 状态，无法安全停止。` +
            "请先结束这个旧进程，再重新运行 setup；尚未修改 Cloudflare。",
        );
    }
    throw new Error(`本机端口 ${port} 已被其它程序占用；尚未修改 Cloudflare`);
}

/** Read-only classification used to recognize a supported foreground instance. */
export async function inspectSetupPort(
    host: string,
    port: number,
): Promise<SetupPortState> {
    const listenHost = localServiceHost(host);
    const server = createServer((_req, res) => {
        res.statusCode = 503;
        res.end();
    });
    try {
        await listenProbeServer(server, listenHost, port);
        return "available";
    } catch (error) {
        if (!(error instanceof SetupPortInUseError)) throw error;
        try {
            await readHealthInstance(`http://${formatHost(listenHost)}:${port}/healthz`, true, 5_000);
            return "codex-mcp";
        } catch {
            return "occupied";
        }
    } finally {
        await closeProbeServer(server);
    }
}

async function readHealthInstance(
    url: string,
    allowPrivate: boolean,
    timeoutMs: number,
): Promise<string> {
    const response = await safeHttpGet(url, {
        allowPrivate,
        httpsOnly: !allowPrivate,
        maxBytes: 4 * 1024,
        timeoutMs,
        maxRedirects: 0,
        headers: { Accept: "application/json" },
    });
    if (response.status !== 200) {
        throw new Error(`codex-mcp 健康检查失败：${url} 返回 HTTP ${response.status}`);
    }
    let payload: unknown;
    try {
        payload = JSON.parse(response.body.toString("utf8"));
    } catch {
        throw new Error(`codex-mcp 健康检查返回了无法识别的内容：${url}`);
    }
    if (
        !payload ||
        typeof payload !== "object" ||
        (payload as { ok?: unknown }).ok !== true ||
        typeof (payload as { instance?: unknown }).instance !== "string" ||
        (payload as { instance: string }).instance.length < 16
    ) {
        throw new Error(`端口上的服务不是支持 setup 验证的当前版 codex-mcp：${url}。如果是升级前启动的旧进程，请重启后再检查。`);
    }
    return (payload as { instance: string }).instance;
}

export function localServiceHost(host: string): string {
    return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

function formatHost(host: string): string {
    return isIP(host) === 6 ? `[${host}]` : host;
}

function createProbeServer(probe: TunnelProbe): Server {
    return createServer((req, res) => {
        if (req.method === "GET" && req.url === probe.path) {
            res.statusCode = 200;
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end(probe.expectedBody);
            return;
        }
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Not Found");
    });
}

async function listenProbeServer(server: Server, host: string, port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException): void => {
            server.off("listening", onListening);
            if (error.code === "EADDRINUSE") {
                reject(new SetupPortInUseError(`本机端口 ${port} 已被占用`));
                return;
            }
            reject(error);
        };
        const onListening = (): void => {
            server.off("error", onError);
            resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
    });
}

async function closeProbeServer(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve) => {
        server.close(() => resolve());
    });
}

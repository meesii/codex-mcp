import { safeHttpGet } from "../lib/http/safe-http.js";

export const TUNNEL_ROUTE_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 512;

export interface TunnelProbe {
    path: string;
    expectedBody: string;
}

export interface VerifyTunnelRouteOptions {
    /** Tests only: permit a loopback HTTP public URL. */
    allowPrivate?: boolean;
    /** One deadline for all DNS/edge/request attempts. */
    totalTimeoutMs?: number;
    retryDelayMs?: number;
    /** Optional cancellation signal used by interactive setup. */
    signal?: AbortSignal;
}

/**
 * Prove that a public hostname reaches the exact local codex-mcp process.
 *
 * Cloudflare proxied CNAMEs are flattened, so public DNS cannot reliably reveal
 * which tunnel UUID a hostname targets. The server therefore exposes an
 * unguessable per-process probe path with an independent random response. A
 * successful end-to-end fetch is a stronger postcondition than DNS inspection.
 */
export async function verifyTunnelRoute(
    publicMcpUrl: string,
    probe: TunnelProbe,
    options: VerifyTunnelRouteOptions = {},
): Promise<void> {
    const mcpUrl = new URL(publicMcpUrl);
    if (!options.allowPrivate && mcpUrl.protocol !== "https:") {
        throw new Error("公网连接必须使用 HTTPS");
    }
    if (!probe.path.startsWith("/.well-known/codex-mcp-tunnel-check/")) {
        throw new Error("Invalid tunnel verification probe path");
    }
    if (probe.expectedBody.length < 32) {
        throw new Error("Invalid tunnel verification probe response");
    }

    const target = new URL(probe.path, mcpUrl);
    const totalTimeoutMs = positiveSafeInteger(
        options.totalTimeoutMs ?? TUNNEL_ROUTE_TIMEOUT_MS,
        1_000,
        "totalTimeoutMs",
    );
    const retryDelayMs = positiveSafeInteger(options.retryDelayMs ?? 500, 0, "retryDelayMs");
    const deadline = Date.now() + totalTimeoutMs;
    let lastDetail = "没有收到响应";

    while (Date.now() < deadline) {
        throwIfAborted(options.signal);
        const remainingMs = deadline - Date.now();
        try {
            const response = await safeHttpGet(target, {
                httpsOnly: !options.allowPrivate,
                allowPrivate: options.allowPrivate,
                maxBytes: MAX_BODY_BYTES,
                timeoutMs: remainingMs,
                signal: options.signal,
                maxRedirects: 0,
                headers: { Accept: "text/plain" },
            });
            const body = response.body.toString("utf8");
            if (response.status === 200 && body === probe.expectedBody) return;
            lastDetail = `HTTP ${response.status}，但返回的不是当前 codex-mcp 实例`;
        } catch (error) {
            throwIfAborted(options.signal);
            lastDetail = error instanceof Error ? error.message : "未知网络错误";
        }

        const delayMs = Math.min(retryDelayMs, Math.max(0, deadline - Date.now()));
        if (delayMs > 0) {
            await delay(delayMs, options.signal);
        }
    }

    throw new Error(tunnelVerificationFailureMessage(mcpUrl.origin, lastDetail));
}

export function tunnelVerificationFailureMessage(origin: string, detail: string): string {
    const prefix = `无法通过公网地址访问当前 codex-mcp（${origin}）：${detail}。`;
    if (isTlsHandshakeFailure(detail)) {
        return (
            prefix +
            "HTTPS TLS 握手在到达 Tunnel 之前失败。若使用 Cloudflare 默认 Universal SSL，请确认 hostname 仅比所选 Cloudflare 域名多一级（例如 codex-mcp.example.com，而不是 codex.mcp.example.com）；否则请为该 hostname 配置可覆盖它的 Cloudflare Edge Certificate。"
        );
    }
    return prefix + "请检查域名是否指向当前 Tunnel，以及 Tunnel 是否已经启动。";
}

function isTlsHandshakeFailure(detail: string): boolean {
    return /(?:\bEPROTO\b|handshake failure|tls handshake|ssl routines|alert number 40|ssl3_read_bytes)/i.test(
        detail,
    );
}

function positiveSafeInteger(
    value: number,
    min: number,
    name: string,
): number {
    if (!Number.isSafeInteger(value) || value < min) {
        throw new Error(`${name} must be an integer greater than or equal to ${min}`);
    }
    return value;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            reject(cancellationError(signal));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw cancellationError(signal);
}

function cancellationError(signal?: AbortSignal): Error {
    return signal?.reason instanceof Error ? signal.reason : new Error("已取消公网配置");
}

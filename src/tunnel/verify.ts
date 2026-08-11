import { safeHttpGet } from "../lib/http/safe-http.js";

const DEFAULT_ATTEMPTS = 10;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 512;

export interface TunnelProbe {
    path: string;
    expectedBody: string;
}

export interface VerifyTunnelRouteOptions {
    /** Tests only: permit a loopback HTTP public URL. */
    allowPrivate?: boolean;
    attempts?: number;
    requestTimeoutMs?: number;
    retryDelayMs?: number;
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
    const attempts = clampPositiveInteger(options.attempts ?? DEFAULT_ATTEMPTS, 1, 30, "attempts");
    const requestTimeoutMs = clampPositiveInteger(
        options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        250,
        30_000,
        "requestTimeoutMs",
    );
    const retryDelayMs = clampPositiveInteger(options.retryDelayMs ?? 500, 0, 5_000, "retryDelayMs");
    let lastDetail = "没有收到响应";

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const response = await safeHttpGet(target, {
                httpsOnly: !options.allowPrivate,
                allowPrivate: options.allowPrivate,
                maxBytes: MAX_BODY_BYTES,
                timeoutMs: requestTimeoutMs,
                maxRedirects: 0,
                headers: { Accept: "text/plain" },
            });
            const body = response.body.toString("utf8");
            if (response.status === 200 && body === probe.expectedBody) return;
            lastDetail = `HTTP ${response.status}，但返回的不是当前 codex-mcp 实例`;
        } catch (error) {
            lastDetail = error instanceof Error ? error.message : "未知网络错误";
        }

        if (attempt < attempts && retryDelayMs > 0) {
            await delay(retryDelayMs);
        }
    }

    throw new Error(
        `无法通过公网地址访问当前 codex-mcp（${mcpUrl.origin}）：${lastDetail}。` +
            "请检查域名是否指向当前 Tunnel，以及 Tunnel 是否已经启动。",
    );
}

function clampPositiveInteger(
    value: number,
    min: number,
    max: number,
    name: string,
): number {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer between ${min} and ${max}`);
    }
    return value;
}

async function delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

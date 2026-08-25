import { execFile } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type Agent } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { promisify } from "node:util";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DOH_MAX_BYTES = 64 * 1024;
const DOH_TIMEOUT_MS = 60_000;
const SYSTEM_PROXY_CACHE_MS = 30_000;
const MAX_PROXY_AGENTS = 8;

const blockedIpv4 = new BlockList();
for (const [address, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
] as const) {
    blockedIpv4.addSubnet(address, prefix, "ipv4");
}
const blockedIpv6 = new BlockList();
for (const [address, prefix] of [
    ["::", 96],
    ["::ffff:0:0", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 32],
    ["2001:2::", 48],
    ["2001:10::", 28],
    ["2001:20::", 28],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
    ["fc00::", 7],
    ["fec0::", 10],
    ["fe80::", 10],
    ["ff00::", 8],
] as const) {
    blockedIpv6.addSubnet(address, prefix, "ipv6");
}

export interface SafeHttpOptions {
    maxBytes?: number;
    timeoutMs?: number;
    maxRedirects?: number;
    httpsOnly?: boolean;
    headers?: Record<string, string>;
    /** Tests or explicitly trusted local integrations only. */
    allowPrivate?: boolean;
    /** Disable automatic HTTP(S) proxy discovery for a specific trusted call. */
    useProxy?: boolean;
    /** Optional caller cancellation; timeout is only the final hang guard. */
    signal?: AbortSignal;
}

export interface SafeHttpRequestOptions extends SafeHttpOptions {
    method: "GET" | "POST" | "DELETE";
    body?: string | Buffer;
    maxRequestBytes?: number;
}

export interface SafeHttpResponse {
    url: string;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: Buffer;
}

interface ResolvedAddress {
    address: string;
    family: 4 | 6;
}

interface SystemProxyCache {
    expiresAt: number;
    protocol: "http:" | "https:";
    proxies: URL[];
}

interface RequestDeadline {
    expiresAt: number;
    timeoutMs: number;
}

let systemProxyCache: SystemProxyCache | undefined;
const proxyAgents = new Map<string, Agent>();

/**
 * Fetch an HTTP(S) resource while enforcing SSRF, redirect, timeout, response-size,
 * and DNS-rebinding policy. Public HTTP(S) requests prefer discovered proxies (environment first,
 * then the operating system's proxy settings) and fall back to a direct connection.
 * When a proxy is used, public DNS resolution is independently checked through
 * DNS-over-HTTPS and the proxied destination is pinned to one of those validated public
 * IPs. TLS SNI and certificate validation still use the original hostname. This keeps
 * proxy support from weakening the public-target SSRF / DNS-rebinding boundary.
 */
export async function safeHttpGet(
    input: string | URL,
    options: SafeHttpOptions = {},
): Promise<SafeHttpResponse> {
    return await safeHttpRequest(input, { ...options, method: "GET" });
}

/** Same network policy as safeHttpGet, with a bounded request body and explicit method. */
export async function safeHttpRequest(
    input: string | URL,
    options: SafeHttpRequestOptions,
): Promise<SafeHttpResponse> {
    const url = input instanceof URL ? new URL(input.href) : new URL(input);
    const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0) {
        throw new Error("maxRequestBytes must be a positive integer");
    }
    if (options.body !== undefined && Buffer.byteLength(options.body) > maxRequestBytes) {
        throw new Error(`Request body exceeds ${maxRequestBytes} bytes`);
    }
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error("timeoutMs must be positive");
    }
    return requestOne(url, options, maxRedirects, {
        expiresAt: Date.now() + timeoutMs,
        timeoutMs,
    });
}

async function requestOne(
    url: URL,
    options: SafeHttpRequestOptions,
    redirectsRemaining: number,
    deadline: RequestDeadline,
): Promise<SafeHttpResponse> {
    throwIfAborted(options.signal);
    assertAllowedUrl(url, options);
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new Error("maxBytes must be a positive integer");
    }
    remainingTimeoutMs(deadline);

    const proxies =
        !options.allowPrivate && options.useProxy !== false
            ? await withinRequestDeadline(resolveProxies(url), deadline, options.signal)
            : [];
    const requestHeaders = {
        "User-Agent": "codex-mcp/0.1",
        "Accept-Encoding": "identity",
        ...(options.body !== undefined
            ? { "Content-Length": String(Buffer.byteLength(options.body)) }
            : {}),
        ...(options.headers ?? {}),
    };

    const proxyErrors: string[] = [];
    for (const proxy of proxies) {
        try {
            return await requestThroughProxy(
                url,
                proxy,
                options,
                redirectsRemaining,
                maxBytes,
                deadline,
                requestHeaders,
            );
        } catch (error) {
            proxyErrors.push(`${proxy.host}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    remainingTimeoutMs(deadline);
    const lookup = options.allowPrivate ? undefined : createSafeLookup(deadline, options.signal);
    const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = requestFn(url, {
        method: options.method,
        lookup,
        headers: requestHeaders,
    });
    try {
        return await finishRequest(req, url, options, redirectsRemaining, maxBytes, deadline);
    } catch (error) {
        if (proxyErrors.length === 0) throw error;
        const directDetail = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Proxy attempts failed (${proxyErrors.join("; ")}); direct connection failed: ${directDetail}`,
        );
    }
}

async function requestThroughProxy(
    url: URL,
    proxy: URL,
    options: SafeHttpRequestOptions,
    redirectsRemaining: number,
    maxBytes: number,
    deadline: RequestDeadline,
    requestHeaders: Record<string, string>,
): Promise<SafeHttpResponse> {
    const addresses = await resolvePublicAddresses(url.hostname, proxy, deadline, options.signal);
    const targets = addresses
        .sort((left, right) => left.family - right.family)
        .slice(0, 2);
    if (targets.length === 0) {
        throw new Error(`No public addresses found for ${url.hostname}`);
    }

    const attempts = [...targets, ...targets];
    let lastError: unknown;
    for (const target of attempts) {
        remainingTimeoutMs(deadline);
        const port = Number(url.port || (url.protocol === "https:" ? "443" : "80"));
        const agent = getProxyAgent(proxy, url.protocol);
        const common = {
            protocol: url.protocol,
            hostname: target.address,
            port,
            path: `${url.pathname}${url.search}`,
            method: options.method,
            agent,
            headers: {
                Host: url.host,
                ...requestHeaders,
            },
        };
        const req =
            url.protocol === "https:"
                ? httpsRequest({ ...common, servername: url.hostname })
                : httpRequest(common);
        try {
            return await finishRequest(
                req,
                url,
                options,
                redirectsRemaining,
                maxBytes,
                deadline,
            );
        } catch (error) {
            lastError = error;
            if (!isRetryableProxyConnectionError(error)) throw error;
        }
    }
    throw lastError instanceof Error
        ? lastError
        : new Error(`Unable to connect to ${url.hostname} through configured proxy`);
}

function finishRequest(
    req: ReturnType<typeof httpRequest>,
    url: URL,
    options: SafeHttpRequestOptions,
    redirectsRemaining: number,
    maxBytes: number,
    deadline: RequestDeadline,
): Promise<SafeHttpResponse> {
    return new Promise<SafeHttpResponse>((resolve, reject) => {
        const timeoutMs = remainingTimeoutMs(deadline);
        let settled = false;
        const cleanup = (): void => {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
        };
        const fail = (error: Error): void => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };

        const timer = setTimeout(() => {
            req.destroy(new Error(`Request timed out after ${deadline.timeoutMs}ms`));
        }, timeoutMs);
        timer.unref();
        const onAbort = (): void => {
            req.destroy(abortError(options.signal));
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });

        req.once("response", (res) => {
            const status = res.statusCode ?? 0;
            const location = res.headers.location;
            if (location && [301, 302, 303, 307, 308].includes(status)) {
                res.resume();
                if (options.method !== "GET") {
                    fail(new Error("Non-GET redirects are not allowed"));
                    return;
                }
                if (redirectsRemaining <= 0) {
                    fail(new Error("Too many redirects"));
                    return;
                }
                let next: URL;
                try {
                    next = new URL(location, url);
                } catch {
                    fail(new Error("Invalid redirect URL"));
                    return;
                }
                settled = true;
                cleanup();
                void requestOne(next, options, redirectsRemaining - 1, deadline).then(resolve, reject);
                return;
            }

            const declaredLength = Number.parseInt(String(res.headers["content-length"] ?? ""), 10);
            if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
                res.destroy();
                fail(new Error(`Response exceeds ${maxBytes} bytes`));
                return;
            }

            const chunks: Buffer[] = [];
            let total = 0;
            res.on("data", (chunk: Buffer | string) => {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                total += buffer.byteLength;
                if (total > maxBytes) {
                    res.destroy(new Error(`Response exceeds ${maxBytes} bytes`));
                    return;
                }
                chunks.push(buffer);
            });
            res.on("error", (error) => fail(error));
            res.on("end", () => {
                if (settled) return;
                settled = true;
                cleanup();
                const headers: Record<string, string> = {};
                for (const [key, value] of Object.entries(res.headers)) {
                    if (value === undefined) continue;
                    headers[key.toLowerCase()] = Array.isArray(value)
                        ? value.join(", ")
                        : String(value);
                }
                resolve({
                    url: url.href,
                    status,
                    statusText: res.statusMessage ?? "",
                    headers,
                    body: Buffer.concat(chunks, total),
                });
            });
        });

        req.on("error", (error) => fail(error));
        req.on("close", cleanup);
        req.end(options.body);
    });
}

/** @internal Exported for deterministic security regression coverage. */
export function isRetryableProxyConnectionError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
    if (
        new Set([
            "ECONNRESET",
            "ECONNREFUSED",
            "ETIMEDOUT",
            "EHOSTUNREACH",
            "ENETUNREACH",
            "EPIPE",
        ]).has(code)
    ) {
        return true;
    }
    // finishRequest() creates its own bounded timeout error without a Node errno.
    // Treat only that exact transport timeout class as retryable; HTTP/TLS validation
    // failures remain fail-closed and are never retried against another destination.
    return error instanceof Error && /^Request timed out after \d+ms$/.test(error.message);
}

function assertAllowedUrl(url: URL, options: SafeHttpOptions): void {
    if (url.username || url.password) {
        throw new Error("URL credentials are not allowed");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("URL must use http or https");
    }
    if (options.httpsOnly && url.protocol !== "https:") {
        throw new Error("URL must use https");
    }
    if (!url.hostname) {
        throw new Error("URL hostname is required");
    }
    const hostname = normalizeHostname(url.hostname);
    if (!options.allowPrivate && isIP(hostname)) {
        assertPublicAddress(hostname);
    }
}

function createSafeLookup(deadline: RequestDeadline, signal?: AbortSignal): LookupFunction {
    return ((hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
        void resolvePublicAddresses(hostname, undefined, deadline, signal)
            .then((addresses) => {
                const wantsAll =
                    typeof options === "object" &&
                    options !== null &&
                    "all" in options &&
                    (options as { all?: boolean }).all === true;
                if (wantsAll) {
                    callback(null, addresses);
                    return;
                }

                const requestedFamily =
                    typeof options === "object" && options !== null && "family" in options
                        ? Number((options as { family?: number }).family)
                        : 0;
                const selected =
                    addresses.find((entry) => !requestedFamily || entry.family === requestedFamily) ??
                    addresses[0];
                if (!selected) throw new Error(`No public addresses found for ${hostname}`);
                callback(null, selected.address, selected.family);
            })
            .catch((error) => callback(error));
    }) as LookupFunction;
}

async function resolvePublicAddresses(
    hostname: string,
    proxy?: URL,
    deadline?: RequestDeadline,
    signal?: AbortSignal,
): Promise<ResolvedAddress[]> {
    throwIfAborted(signal);
    if (deadline) remainingTimeoutMs(deadline);
    const normalized = normalizeHostname(hostname);
    if (isIP(normalized)) {
        assertPublicAddress(normalized);
        return [{ address: normalized, family: isIP(normalized) as 4 | 6 }];
    }

    const addresses = proxy
        ? await resolveWithDohThroughProxy(normalized, proxy, deadline, signal)
        : await withAbortSignal(dnsLookup(normalized, { all: true, verbatim: true }), signal);
    if (addresses.length === 0) {
        throw new Error(`No addresses found for ${hostname}`);
    }
    const unique = new Map<string, ResolvedAddress>();
    for (const entry of addresses) {
        assertPublicAddress(entry.address);
        unique.set(entry.address, { address: entry.address, family: entry.family as 4 | 6 });
    }
    return [...unique.values()];
}

async function resolveWithDohThroughProxy(
    hostname: string,
    proxy: URL,
    deadline?: RequestDeadline,
    signal?: AbortSignal,
): Promise<ResolvedAddress[]> {
    const providers = [
        { host: "cloudflare-dns.com", path: "/dns-query", style: "cloudflare" as const },
        { host: "dns.google", path: "/resolve", style: "google" as const },
    ];
    let lastError: unknown;
    for (const provider of providers) {
        try {
            const [ipv4, ipv6] = await Promise.all([
                queryDoh(provider, hostname, "A", proxy, deadline, signal),
                queryDoh(provider, hostname, "AAAA", proxy, deadline, signal),
            ]);
            const combined = [...ipv4, ...ipv6];
            if (combined.length > 0) return combined;
        } catch (error) {
            lastError = error;
        }
    }
    throw new Error(
        `Public DNS resolution through configured HTTPS proxy failed for ${hostname}: ${
            lastError instanceof Error ? lastError.message : "unknown error"
        }`,
    );
}

async function queryDoh(
    provider: { host: string; path: string; style: "cloudflare" | "google" },
    hostname: string,
    type: "A" | "AAAA",
    proxy: URL,
    deadline?: RequestDeadline,
    signal?: AbortSignal,
): Promise<ResolvedAddress[]> {
    const query = new URLSearchParams({ name: hostname, type });
    const path = `${provider.path}?${query.toString()}`;
    const agent = getProxyAgent(proxy, "https:");
    const body = await new Promise<Buffer>((resolve, reject) => {
        throwIfAborted(signal);
        const req = httpsRequest({
            protocol: "https:",
            hostname: provider.host,
            port: 443,
            path,
            method: "GET",
            agent,
            headers: {
                Host: provider.host,
                Accept: "application/dns-json",
                "Accept-Encoding": "identity",
                "User-Agent": "codex-mcp/0.1",
            },
        });
        let total = 0;
        const chunks: Buffer[] = [];
        const timeoutMs = deadline
            ? Math.min(DOH_TIMEOUT_MS, remainingTimeoutMs(deadline))
            : DOH_TIMEOUT_MS;
        const timer = setTimeout(() => {
            req.destroy(new Error(`DNS-over-HTTPS timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref();
        const onAbort = (): void => {
            req.destroy(abortError(signal));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        req.on("response", (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`DNS-over-HTTPS returned HTTP ${res.statusCode ?? 0}`));
                return;
            }
            res.on("data", (chunk: Buffer | string) => {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                total += buffer.byteLength;
                if (total > DOH_MAX_BYTES) {
                    res.destroy(new Error("DNS-over-HTTPS response is too large"));
                    return;
                }
                chunks.push(buffer);
            });
            res.on("error", reject);
            res.on("end", () => resolve(Buffer.concat(chunks, total)));
        });
        req.on("error", reject);
        req.on("close", () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        });
        req.end();
    });

    const payload = JSON.parse(body.toString("utf8")) as {
        Status?: number;
        Answer?: Array<{ type?: number; data?: string }>;
    };
    if (payload.Status !== 0 && payload.Status !== undefined) {
        if (payload.Status === 3) return [];
        throw new Error(`DNS-over-HTTPS returned DNS status ${payload.Status}`);
    }
    const wantedType = type === "A" ? 1 : 28;
    const family = type === "A" ? 4 : 6;
    const out: ResolvedAddress[] = [];
    for (const answer of payload.Answer ?? []) {
        if (answer.type !== wantedType || typeof answer.data !== "string") continue;
        if (isIP(answer.data) !== family) continue;
        assertPublicAddress(answer.data);
        out.push({ address: answer.data, family });
    }
    return out;
}

async function resolveProxies(url: URL): Promise<URL[]> {
    if (matchesNoProxy(url)) return [];
    const protocol = url.protocol === "https:" ? "https:" : "http:";
    const proxies = proxyEnvironmentCandidates(process.env, protocol);
    proxies.push(...(await getSystemProxies(protocol)));
    return dedupeProxyUrls(proxies);
}

/** @internal Exported for deterministic proxy-priority regression coverage. */
export function proxyEnvironmentCandidates(
    env: NodeJS.ProcessEnv,
    protocol: "http:" | "https:" = "https:",
): URL[] {
    const values =
        protocol === "https:"
            ? [
                  env.HTTPS_PROXY,
                  env.https_proxy,
                  env.HTTP_PROXY,
                  env.http_proxy,
                  env.ALL_PROXY,
                  env.all_proxy,
              ]
            : [env.HTTP_PROXY, env.http_proxy, env.ALL_PROXY, env.all_proxy];
    const proxies: URL[] = [];
    for (const value of values) {
        if (!value?.trim()) continue;
        try {
            proxies.push(parseProxyUrl(value.trim(), "proxy environment variable"));
        } catch {
            // Ignore malformed entries and continue with other discovered proxies/direct fallback.
        }
    }
    return dedupeProxyUrls(proxies);
}

function matchesNoProxy(url: URL): boolean {
    const raw = process.env.NO_PROXY ?? process.env.no_proxy;
    if (!raw?.trim()) return false;
    const hostname = normalizeHostname(url.hostname).toLowerCase();
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    for (const part of raw.split(",")) {
        const token = part.trim().toLowerCase();
        if (!token) continue;
        if (token === "*") return true;
        const [rawHost, rawPort] = splitNoProxyToken(token);
        if (rawPort && rawPort !== port) continue;
        const candidate = rawHost.replace(/^\*\./, ".");
        if (candidate.startsWith(".")) {
            const suffix = candidate.slice(1);
            if (hostname === suffix || hostname.endsWith(`.${suffix}`)) return true;
        } else if (hostname === candidate) {
            return true;
        }
    }
    return false;
}

function splitNoProxyToken(token: string): [string, string | undefined] {
    if (token.startsWith("[")) {
        const close = token.indexOf("]");
        if (close >= 0) {
            const host = token.slice(1, close);
            const port = token[close + 1] === ":" ? token.slice(close + 2) : undefined;
            return [host, port];
        }
    }
    const lastColon = token.lastIndexOf(":");
    if (lastColon > 0 && token.indexOf(":") === lastColon) {
        return [token.slice(0, lastColon), token.slice(lastColon + 1)];
    }
    return [token, undefined];
}

async function getSystemProxies(protocol: "http:" | "https:"): Promise<URL[]> {
    const now = Date.now();
    if (
        systemProxyCache &&
        systemProxyCache.protocol === protocol &&
        systemProxyCache.expiresAt > now
    ) {
        return systemProxyCache.proxies;
    }

    let proxies: URL[] = [];
    try {
        if (process.platform === "darwin") {
            proxies = await getMacProxies(protocol);
        } else if (process.platform === "win32") {
            proxies = await getWindowsProxies(protocol);
        } else if (process.platform === "linux") {
            proxies = await getLinuxProxies(protocol);
        }
    } catch {
        proxies = [];
    }

    systemProxyCache = {
        expiresAt: now + SYSTEM_PROXY_CACHE_MS,
        protocol,
        proxies: dedupeProxyUrls(proxies),
    };
    return systemProxyCache.proxies;
}

async function getMacProxies(protocol: "http:" | "https:"): Promise<URL[]> {
    const { stdout } = await execFileAsync("/usr/sbin/scutil", ["--proxy"], {
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
    });
    return parseMacSystemProxies(stdout, protocol);
}

async function getWindowsProxies(protocol: "http:" | "https:"): Promise<URL[]> {
    const script = [
        "$p=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction Stop;",
        "[pscustomobject]@{ProxyEnable=$p.ProxyEnable;ProxyServer=$p.ProxyServer}|ConvertTo-Json -Compress",
    ].join("");
    const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
            timeout: 10_000,
            maxBuffer: 64 * 1024,
            encoding: "utf8",
            windowsHide: true,
        },
    );
    return parseWindowsSystemProxies(stdout, protocol);
}

async function getLinuxProxies(protocol: "http:" | "https:"): Promise<URL[]> {
    const { stdout: modeOut } = await execFileAsync(
        "gsettings",
        ["get", "org.gnome.system.proxy", "mode"],
        {
            timeout: 10_000,
            maxBuffer: 8 * 1024,
            encoding: "utf8",
        },
    );
    if (stripGsettingsString(modeOut) !== "manual") return [];

    const [httpsHost, httpsPort, httpHost, httpPort, socksHost, socksPort] = await Promise.all([
        readGsettingsValue("org.gnome.system.proxy.https", "host"),
        readGsettingsValue("org.gnome.system.proxy.https", "port"),
        readGsettingsValue("org.gnome.system.proxy.http", "host"),
        readGsettingsValue("org.gnome.system.proxy.http", "port"),
        readGsettingsValue("org.gnome.system.proxy.socks", "host"),
        readGsettingsValue("org.gnome.system.proxy.socks", "port"),
    ]);
    const httpsPair: [string | undefined, number | undefined] = [
        stripGsettingsString(httpsHost),
        parseProxyPort(httpsPort),
    ];
    const httpPair: [string | undefined, number | undefined] = [
        stripGsettingsString(httpHost),
        parseProxyPort(httpPort),
    ];
    const proxies = proxyUrlsFromHostPortPairs(
        protocol === "https:" ? [httpsPair, httpPair] : [httpPair],
    );
    const socksHostValue = stripGsettingsString(socksHost);
    const socksPortValue = parseProxyPort(socksPort);
    if (socksHostValue && socksPortValue) {
        proxies.push(...parseProxyCandidates([`socks5://${socksHostValue}:${socksPortValue}`]));
    }
    return dedupeProxyUrls(proxies);
}

async function readGsettingsValue(schema: string, key: string): Promise<string> {
    const { stdout } = await execFileAsync("gsettings", ["get", schema, key], {
        timeout: 10_000,
        maxBuffer: 8 * 1024,
        encoding: "utf8",
    });
    return stdout.trim();
}

/** @internal Exported for deterministic proxy-discovery regression coverage. */
export function parseMacSystemProxies(
    stdout: string,
    protocol: "http:" | "https:" = "https:",
): URL[] {
    const pairs: Array<[string | undefined, number | undefined]> = [];
    if (protocol === "https:" && /^\s*HTTPSEnable\s*:\s*1\s*$/m.test(stdout)) {
        pairs.push([
            /^\s*HTTPSProxy\s*:\s*(\S+)\s*$/m.exec(stdout)?.[1],
            parseProxyPort(/^\s*HTTPSPort\s*:\s*(\d+)\s*$/m.exec(stdout)?.[1]),
        ]);
    }
    if (/^\s*HTTPEnable\s*:\s*1\s*$/m.test(stdout)) {
        pairs.push([
            /^\s*HTTPProxy\s*:\s*(\S+)\s*$/m.exec(stdout)?.[1],
            parseProxyPort(/^\s*HTTPPort\s*:\s*(\d+)\s*$/m.exec(stdout)?.[1]),
        ]);
    }
    const proxies = proxyUrlsFromHostPortPairs(pairs);
    if (/^\s*SOCKSEnable\s*:\s*1\s*$/m.test(stdout)) {
        const host = /^\s*SOCKSProxy\s*:\s*(\S+)\s*$/m.exec(stdout)?.[1];
        const port = parseProxyPort(/^\s*SOCKSPort\s*:\s*(\d+)\s*$/m.exec(stdout)?.[1]);
        if (host && port) {
            proxies.push(...parseProxyCandidates([`socks5://${host}:${port}`]));
        }
    }
    return dedupeProxyUrls(proxies);
}

/** @internal Exported for deterministic proxy-discovery regression coverage. */
export function parseWindowsSystemProxies(
    stdout: string,
    protocol: "http:" | "https:" = "https:",
): URL[] {
    let payload: { ProxyEnable?: unknown; ProxyServer?: unknown };
    try {
        payload = JSON.parse(stdout.trim()) as { ProxyEnable?: unknown; ProxyServer?: unknown };
    } catch {
        return [];
    }
    if (Number(payload.ProxyEnable) !== 1 || typeof payload.ProxyServer !== "string") return [];

    const raw = payload.ProxyServer.trim();
    if (!raw) return [];
    if (!raw.includes("=")) return parseProxyCandidates([raw]);

    const entries = new Map<string, string>();
    for (const part of raw.split(";")) {
        const separator = part.indexOf("=");
        if (separator <= 0) continue;
        entries.set(part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim());
    }
    const proxies = parseProxyCandidates(
        protocol === "https:"
            ? [entries.get("https"), entries.get("http")]
            : [entries.get("http")],
    );
    const socks = entries.get("socks");
    if (socks) {
        const value = /^[a-z][a-z0-9+.-]*:\/\//i.test(socks) ? socks : `socks5://${socks}`;
        proxies.push(...parseProxyCandidates([value]));
    }
    return dedupeProxyUrls(proxies);
}

function parseProxyCandidates(values: Array<string | undefined>): URL[] {
    const proxies: URL[] = [];
    for (const value of values) {
        if (!value) continue;
        try {
            proxies.push(parseProxyUrl(value, "system proxy"));
        } catch {
            // Ignore malformed system entries; direct fallback remains available.
        }
    }
    return dedupeProxyUrls(proxies);
}

function proxyUrlsFromHostPortPairs(
    pairs: Array<[string | undefined, number | undefined]>,
): URL[] {
    return parseProxyCandidates(
        pairs.map(([host, port]) => (host && port ? `http://${host}:${port}` : undefined)),
    );
}

function stripGsettingsString(value: string): string {
    const trimmed = value.trim();
    if (
        (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
        (trimmed.startsWith('"') && trimmed.endsWith('"'))
    ) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

function parseProxyPort(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const port = Number.parseInt(value.trim(), 10);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

function dedupeProxyUrls(proxies: URL[]): URL[] {
    const seen = new Set<string>();
    const out: URL[] = [];
    for (const proxy of proxies) {
        if (seen.has(proxy.href)) continue;
        seen.add(proxy.href);
        out.push(proxy);
    }
    return out;
}

function getProxyAgent(proxy: URL, targetProtocol: string): Agent {
    const key = `${targetProtocol}|${proxy.href}`;
    const existing = proxyAgents.get(key);
    if (existing) return existing;
    if (proxyAgents.size >= MAX_PROXY_AGENTS) {
        const oldest = proxyAgents.entries().next().value as [string, Agent] | undefined;
        if (oldest) {
            oldest[1].destroy();
            proxyAgents.delete(oldest[0]);
        }
    }
    const options = {
        keepAlive: true,
        maxSockets: 8,
        maxFreeSockets: 2,
    };
    const agent = isSocksProxy(proxy)
        ? new SocksProxyAgent(proxy.href, options)
        : targetProtocol === "https:"
          ? new HttpsProxyAgent(proxy, options)
          : new HttpProxyAgent(proxy, options);
    proxyAgents.set(key, agent);
    return agent;
}

function parseProxyUrl(value: string, source: string): URL {
    const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
    let proxy: URL;
    try {
        proxy = new URL(normalized);
    } catch {
        throw new Error(`Invalid ${source}`);
    }
    if (!isSupportedProxyProtocol(proxy.protocol)) {
        throw new Error(`${source} must use http, https, socks4, socks4a, socks5, or socks5h`);
    }
    if (!proxy.hostname || (proxy.pathname && proxy.pathname !== "/") || proxy.search || proxy.hash) {
        throw new Error(`Invalid ${source}`);
    }
    return proxy;
}

function isSupportedProxyProtocol(protocol: string): boolean {
    return new Set(["http:", "https:", "socks:", "socks4:", "socks4a:", "socks5:", "socks5h:"]).has(
        protocol,
    );
}

function isSocksProxy(proxy: URL): boolean {
    return proxy.protocol.startsWith("socks");
}

function normalizeHostname(hostname: string): string {
    return hostname.replace(/^\[|\]$/g, "");
}

function remainingTimeoutMs(deadline: RequestDeadline): number {
    const remaining = deadline.expiresAt - Date.now();
    if (remaining <= 0) {
        throw new Error(`Request timed out after ${deadline.timeoutMs}ms`);
    }
    return remaining;
}

async function withinRequestDeadline<T>(
    operation: Promise<T>,
    deadline: RequestDeadline,
    signal?: AbortSignal,
): Promise<T> {
    const timeoutMs = remainingTimeoutMs(deadline);
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            withAbortSignal(operation, signal),
            new Promise<T>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`Request timed out after ${deadline.timeoutMs}ms`)),
                    timeoutMs,
                );
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function withAbortSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    if (!signal) return await operation;
    return await new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(abortError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
        operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortError(signal);
}

function abortError(signal?: AbortSignal): Error {
    return signal?.reason instanceof Error ? signal.reason : new Error("Request cancelled");
}

export function assertPublicAddress(address: string): void {
    const family = isIP(address);
    if (family === 0) {
        throw new Error(`Invalid IP address: ${address}`);
    }

    if (family === 6) {
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
        if (mapped) {
            assertPublicAddress(mapped);
            return;
        }
    }

    const isBlocked =
        family === 4
            ? blockedIpv4.check(address, "ipv4")
            : blockedIpv6.check(address, "ipv6");
    if (isBlocked) {
        throw new Error(`Private or reserved network address is not allowed: ${address}`);
    }
}

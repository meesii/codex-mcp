import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { expandHomePath } from "../config/loader.js";
import { normalizeHostname } from "../config/user-config.js";
import { safeHttpGet } from "../lib/http/safe-http.js";
import {
    getCredentialsPath,
    getManagedCloudflareDir,
    getManagedCloudflaredStateDir,
} from "./yml.js";

const ARGO_TUNNEL_TOKEN_RE =
    /-----BEGIN ARGO TUNNEL TOKEN-----\s*([A-Za-z0-9+/=_\-\s]+?)\s*-----END ARGO TUNNEL TOKEN-----/;
const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const ZONES_PER_PAGE = 50;
const MAX_ZONE_PAGES = 20;

export interface CloudflareOriginToken {
    accountID: string;
    apiToken: string;
    zoneID: string;
}

export interface CloudflareZoneDiscovery {
    zones: string[];
    /** False when account-wide listing failed and we could only resolve the selected login zone. */
    complete: boolean;
}

interface CloudflareApiEnvelope<T> {
    success?: boolean;
    result?: T;
    errors?: Array<{ message?: string }>;
    result_info?: { total_pages?: number };
}

interface CloudflareZone {
    id?: string;
    name?: string;
    status?: string;
}

export function getCloudflareOriginCertPath(): string {
    return join(getManagedCloudflaredStateDir(), "cert.pem");
}

export function hasManagedCloudflareLogin(): boolean {
    const certPath = getCloudflareOriginCertPath();
    if (!existsSync(certPath)) return false;
    try {
        parseCloudflareOriginToken(readFileSync(certPath, "utf8"));
        return true;
    } catch {
        return false;
    }
}

export function clearManagedCloudflareLogin(): boolean {
    const certPath = getCloudflareOriginCertPath();
    const existed = existsSync(certPath);
    rmSync(certPath, { force: true });
    return existed;
}

export function getLegacyCloudflareOriginCertPath(): string {
    return expandHomePath("~/.cloudflared/cert.pem");
}

export function getLegacyTunnelCredentialsPath(tunnelId: string): string {
    return expandHomePath(`~/.cloudflared/${tunnelId}.json`);
}

export interface CloudflareStateMigrationResult {
    certMigrated: boolean;
    credentialsMigrated: boolean;
}

export function migrateLegacyCloudflareState(
    tunnelId?: string,
): CloudflareStateMigrationResult {
    const result: CloudflareStateMigrationResult = {
        certMigrated: false,
        credentialsMigrated: false,
    };
    if (!tunnelId) return result;

    const managedCertPath = getCloudflareOriginCertPath();
    const legacyCertPath = getLegacyCloudflareOriginCertPath();
    const legacyCredentialsPath = getLegacyTunnelCredentialsPath(tunnelId);
    const managedCredentialsPath = getCredentialsPath(tunnelId);

    const certSource = existsSync(managedCertPath)
        ? managedCertPath
        : existsSync(legacyCertPath)
          ? legacyCertPath
          : undefined;
    if (!certSource || !existsSync(legacyCredentialsPath)) return result;

    let accountID: string;
    let credentials: { AccountTag?: unknown; TunnelID?: unknown };
    try {
        accountID = parseCloudflareOriginToken(readFileSync(certSource, "utf8")).accountID;
        credentials = JSON.parse(readFileSync(legacyCredentialsPath, "utf8")) as {
            AccountTag?: unknown;
            TunnelID?: unknown;
        };
    } catch {
        return result;
    }

    if (credentials.AccountTag !== accountID) return result;
    if (
        typeof credentials.TunnelID === "string" &&
        credentials.TunnelID.toLowerCase() !== tunnelId.toLowerCase()
    ) {
        return result;
    }

    mkdirSync(getManagedCloudflareDir(), { recursive: true });
    if (!existsSync(managedCertPath) && certSource === legacyCertPath) {
        copyPrivateFile(legacyCertPath, managedCertPath);
        result.certMigrated = true;
    }
    if (!existsSync(managedCredentialsPath)) {
        copyPrivateFile(legacyCredentialsPath, managedCredentialsPath);
        result.credentialsMigrated = true;
    }
    return result;
}

function copyPrivateFile(source: string, destination: string): void {
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    if (process.platform !== "win32") {
        chmodSync(destination, 0o600);
    }
}

export function parseCloudflareOriginToken(pem: string): CloudflareOriginToken {
    const match = pem.match(ARGO_TUNNEL_TOKEN_RE);
    if (!match?.[1]) {
        throw new Error("Cloudflare 登录凭据里没有找到 ARGO TUNNEL TOKEN");
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(match[1].replace(/\s+/g, ""), "base64").toString("utf8"));
    } catch {
        throw new Error("Cloudflare 登录凭据格式无法识别");
    }

    if (!parsed || typeof parsed !== "object") {
        throw new Error("Cloudflare 登录凭据格式无法识别");
    }
    const record = parsed as Record<string, unknown>;
    const accountID = typeof record.accountID === "string" ? record.accountID.trim() : "";
    const apiToken = typeof record.apiToken === "string" ? record.apiToken.trim() : "";
    const zoneID = typeof record.zoneID === "string" ? record.zoneID.trim() : "";
    if (!accountID || !apiToken || !zoneID) {
        throw new Error("Cloudflare 登录凭据缺少 accountID、apiToken 或 zoneID");
    }
    return { accountID, apiToken, zoneID };
}

export async function discoverCloudflareZones(
    certPath: string = getCloudflareOriginCertPath(),
): Promise<CloudflareZoneDiscovery> {
    const token = parseCloudflareOriginToken(readFileSync(certPath, "utf8"));
    try {
        const zones = await listAccountZones(token);
        if (zones.length > 0) {
            return { zones, complete: true };
        }
    } catch (listError) {
        try {
            const selected = await getSelectedZone(token);
            return { zones: selected ? [selected] : [], complete: false };
        } catch {
            throw new Error(
                `无法读取 Cloudflare 域名：${listError instanceof Error ? listError.message : String(listError)}`,
            );
        }
    }

    const selected = await getSelectedZone(token);
    return { zones: selected ? [selected] : [], complete: false };
}

async function listAccountZones(token: CloudflareOriginToken): Promise<string[]> {
    const zones = new Set<string>();
    for (let page = 1; page <= MAX_ZONE_PAGES; page += 1) {
        const url = new URL(`${CLOUDFLARE_API_BASE}/zones`);
        url.searchParams.set("account.id", token.accountID);
        url.searchParams.set("status", "active");
        url.searchParams.set("order", "name");
        url.searchParams.set("direction", "asc");
        url.searchParams.set("page", String(page));
        url.searchParams.set("per_page", String(ZONES_PER_PAGE));
        const payload = await cloudflareGet<CloudflareZone[]>(url, token.apiToken);
        for (const zone of payload.result ?? []) {
            const name = normalizeZoneName(zone.name);
            if (name) zones.add(name);
        }

        const totalPages = payload.result_info?.total_pages;
        if (
            (typeof totalPages === "number" && page >= totalPages) ||
            (payload.result?.length ?? 0) < ZONES_PER_PAGE
        ) {
            break;
        }
    }
    return [...zones].sort((left, right) => left.localeCompare(right));
}

async function getSelectedZone(token: CloudflareOriginToken): Promise<string | undefined> {
    const zoneId = encodeURIComponent(token.zoneID);
    const payload = await cloudflareGet<CloudflareZone>(
        new URL(`${CLOUDFLARE_API_BASE}/zones/${zoneId}`),
        token.apiToken,
    );
    return normalizeZoneName(payload.result?.name);
}

async function cloudflareGet<T>(
    url: URL,
    apiToken: string,
): Promise<CloudflareApiEnvelope<T>> {
    const response = await safeHttpGet(url, {
        httpsOnly: true,
        maxRedirects: 0,
        maxBytes: 2 * 1024 * 1024,
        timeoutMs: 30_000,
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${apiToken}`,
        },
    });
    let payload: CloudflareApiEnvelope<T>;
    try {
        payload = JSON.parse(response.body.toString("utf8")) as CloudflareApiEnvelope<T>;
    } catch {
        throw new Error(`Cloudflare API 返回了无法识别的内容（HTTP ${response.status}）`);
    }
    if (response.status !== 200 || payload.success !== true) {
        const detail = payload.errors
            ?.map((error) => error.message?.trim())
            .filter((message): message is string => Boolean(message))
            .join("；");
        throw new Error(detail || `Cloudflare API 请求失败（HTTP ${response.status}）`);
    }
    return payload;
}

function normalizeZoneName(value: unknown): string | undefined {
    if (typeof value !== "string" || !value.trim()) return undefined;
    try {
        return normalizeHostname(value);
    } catch {
        return undefined;
    }
}

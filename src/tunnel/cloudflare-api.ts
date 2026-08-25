import { readManagedCloudflareOriginToken } from "./cloudflare-account.js";
import { safeHttpRequest } from "../lib/http/safe-http.js";
import { normalizeTunnelId } from "./id.js";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const API_TIMEOUT_MS = 120_000;
const MAX_API_BODY_CHARS = 2 * 1024 * 1024;
const DNS_TYPES_WITH_DATA = new Set([
    "CAA", "CERT", "DNSKEY", "DS", "HTTPS", "LOC", "NAPTR",
    "SMIMEA", "SRV", "SSHFP", "SVCB", "TLSA", "URI",
]);

interface CloudflareApiEnvelope<T> {
    success?: boolean;
    result?: T;
    errors?: Array<{ message?: string }>;
}

export interface CloudflareDnsRecordSnapshot {
    id: string;
    type: string;
    name: string;
    ttl: number;
    content?: string;
    proxied?: boolean;
    private_routing?: boolean;
    priority?: number | null;
    data?: unknown;
    /** Cloudflare list responses use null when a record has no comment. */
    comment?: string | null;
    tags?: string[] | null;
    settings?: Record<string, unknown> | null;
}

export interface CloudflareDnsSnapshot {
    zoneId: string;
    hostname: string;
    records: CloudflareDnsRecordSnapshot[];
}

export interface CloudflareDnsCutoverResult {
    changed: boolean;
    /** Exact readback after the candidate record was committed. */
    committed: CloudflareDnsSnapshot;
}

export interface CloudflareTunnelObserved {
    exists: boolean;
    status?: "inactive" | "degraded" | "healthy" | "down";
    connectorCount?: number;
}

/** Read every DNS record at the exact hostname before a possible cutover. */
export async function snapshotCloudflareDns(
    zoneId: string,
    hostname: string,
): Promise<CloudflareDnsSnapshot> {
    const query = new URLSearchParams({ "name.exact": hostname, per_page: "5000000" });
    const records = await cloudflareApiRequest<CloudflareDnsRecordSnapshot[]>(
        "GET",
        `/zones/${encodeURIComponent(zoneId)}/dns_records?${query.toString()}`,
    );
    return {
        zoneId,
        hostname: hostname.toLowerCase(),
        records: records.filter((record) => record.name.toLowerCase() === hostname.toLowerCase()),
    };
}

export function dnsSnapshotPointsToTunnel(
    snapshot: CloudflareDnsSnapshot,
    tunnelId: string,
): boolean {
    return snapshot.records.length === 1 &&
        snapshot.records[0]?.proxied === true &&
        dnsRecordTargetsTunnel(snapshot.records[0], tunnelId);
}

export function dnsSnapshotReferencesTunnel(
    snapshot: CloudflareDnsSnapshot,
    tunnelId: string,
): boolean {
    return snapshot.records.some((record) => dnsRecordTargetsTunnel(record, tunnelId));
}

function dnsRecordTargetsTunnel(
    record: CloudflareDnsRecordSnapshot,
    tunnelId: string,
): boolean {
    const expected = `${tunnelId}.cfargotunnel.com`;
    return record.type === "CNAME" &&
        record.content?.toLowerCase().replace(/\.$/, "") === expected;
}

/** Replace the exact-name DNS set with one proxied Tunnel CNAME. */
export async function cutoverCloudflareDns(
    snapshot: CloudflareDnsSnapshot,
    tunnelId: string,
): Promise<CloudflareDnsCutoverResult> {
    if (dnsSnapshotPointsToTunnel(snapshot, tunnelId)) {
        return { changed: false, committed: snapshot };
    }
    const current = await snapshotCloudflareDns(snapshot.zoneId, snapshot.hostname);
    if (!dnsRecordsEquivalent(current.records, snapshot.records)) {
        throw new Error("DNS 记录在确认后又发生了变化，已停止切换；请重新运行 setup 检查最新状态");
    }
    try {
        await deleteDnsRecords(snapshot.zoneId, current.records);
        await createDnsRecord(snapshot.zoneId, {
            type: "CNAME",
            name: snapshot.hostname,
            content: `${tunnelId}.cfargotunnel.com`,
            ttl: 1,
            proxied: true,
        });
        const committed = await snapshotCloudflareDns(snapshot.zoneId, snapshot.hostname);
        if (!dnsSnapshotPointsToTunnel(committed, tunnelId)) {
            throw new Error("DNS 写入后读取校验不一致");
        }
        return { changed: true, committed };
    } catch (error) {
        try {
            await restorePartialCloudflareDns(snapshot, tunnelId);
        } catch (restoreError) {
            throw partialDnsError("DNS 切换失败，且旧记录恢复失败", error, restoreError);
        }
        throw new Error(`DNS 切换失败，已恢复旧记录：${readableError(error)}`);
    }
}

/**
 * Restore the old set only when no actor changed the fully committed candidate.
 * This is the post-cutover/public-verification compensation boundary.
 */
export async function restoreCloudflareDns(
    snapshot: CloudflareDnsSnapshot,
    expectedCurrent: CloudflareDnsSnapshot,
): Promise<void> {
    if (
        snapshot.zoneId !== expectedCurrent.zoneId ||
        snapshot.hostname !== expectedCurrent.hostname
    ) {
        throw new Error("DNS 补偿快照不属于同一个 hostname");
    }
    const current = await snapshotCloudflareDns(snapshot.zoneId, snapshot.hostname);
    if (dnsRecordsEquivalent(current.records, snapshot.records)) return;
    if (!dnsRecordsEquivalent(current.records, expectedCurrent.records)) {
        throw new Error(
            "DNS 在切换后被其它操作修改，拒绝覆盖新的记录；请在 Cloudflare 控制台核对后手动恢复",
        );
    }
    await replaceDnsRecords(snapshot, current);
}

/** Internal recovery while this process is still in the middle of cutover. */
async function restorePartialCloudflareDns(
    snapshot: CloudflareDnsSnapshot,
    expectedTunnelId: string,
): Promise<void> {
    const current = await snapshotCloudflareDns(snapshot.zoneId, snapshot.hostname);
    const safeRecoveryState =
        current.records.length === 0 ||
        dnsRecordsEquivalent(current.records, snapshot.records) ||
        dnsRecordsAreSubset(current.records, snapshot.records) ||
        dnsSnapshotPointsToTunnel(current, expectedTunnelId);
    if (!safeRecoveryState) {
        throw new Error(
            "DNS 在切换期间被其它操作修改，拒绝覆盖新的记录；请在 Cloudflare 控制台核对后手动恢复",
        );
    }
    if (dnsRecordsEquivalent(current.records, snapshot.records)) return;
    await replaceDnsRecords(snapshot, current);
}

async function replaceDnsRecords(
    snapshot: CloudflareDnsSnapshot,
    current: CloudflareDnsSnapshot,
): Promise<void> {
    await deleteDnsRecords(snapshot.zoneId, current.records);
    for (const record of snapshot.records) {
        await createDnsRecord(snapshot.zoneId, dnsCreateBody(record));
    }
    const restored = await snapshotCloudflareDns(snapshot.zoneId, snapshot.hostname);
    if (!dnsRecordsEquivalent(restored.records, snapshot.records)) {
        throw new Error("DNS 恢复请求完成，但读取校验仍与原快照不一致");
    }
}

export async function inspectCloudflareTunnel(
    accountId: string,
    tunnelId: string,
): Promise<CloudflareTunnelObserved> {
    const normalizedTunnelId = normalizeTunnelId(tunnelId);
    try {
        const tunnel = await cloudflareApiRequest<{ status?: unknown }>(
            "GET",
            `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(normalizedTunnelId)}`,
        );
        const connections = await cloudflareApiRequest<unknown[]>(
            "GET",
            `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(normalizedTunnelId)}/connections`,
        );
        const status = isTunnelStatus(tunnel.status) ? tunnel.status : undefined;
        return { exists: true, ...(status ? { status } : {}), connectorCount: connections.length };
    } catch (error) {
        if (/not found|HTTP 404/i.test(readableError(error))) return { exists: false };
        throw error;
    }
}

async function deleteDnsRecords(
    zoneId: string,
    records: CloudflareDnsRecordSnapshot[],
): Promise<void> {
    for (const record of records) {
        await cloudflareApiRequest<unknown>(
            "DELETE",
            `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(record.id)}`,
        );
    }
}

function dnsRecordsEquivalent(
    left: CloudflareDnsRecordSnapshot[],
    right: CloudflareDnsRecordSnapshot[],
): boolean {
    return recordFingerprints(left).join("\n") === recordFingerprints(right).join("\n");
}

function dnsRecordsAreSubset(
    subset: CloudflareDnsRecordSnapshot[],
    superset: CloudflareDnsRecordSnapshot[],
): boolean {
    const remaining = recordFingerprints(superset);
    for (const fingerprint of recordFingerprints(subset)) {
        const index = remaining.indexOf(fingerprint);
        if (index < 0) return false;
        remaining.splice(index, 1);
    }
    return true;
}

function recordFingerprints(records: CloudflareDnsRecordSnapshot[]): string[] {
    return records.map((record) => stableStringify(dnsCreateBody(record))).sort();
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    if (value && typeof value === "object") {
        const fields = Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, field]) => `${JSON.stringify(key)}:${stableStringify(field)}`);
        return `{${fields.join(",")}}`;
    }
    return JSON.stringify(value);
}

async function createDnsRecord(
    zoneId: string,
    body: Record<string, unknown>,
): Promise<void> {
    await cloudflareApiRequest<unknown>(
        "POST",
        `/zones/${encodeURIComponent(zoneId)}/dns_records`,
        body,
    );
}

function dnsCreateBody(record: CloudflareDnsRecordSnapshot): Record<string, unknown> {
    const usesData = DNS_TYPES_WITH_DATA.has(record.type.toUpperCase());
    return {
        type: record.type,
        name: record.name,
        ttl: record.ttl,
        ...(!usesData && typeof record.content === "string" ? { content: record.content } : {}),
        ...(typeof record.proxied === "boolean" ? { proxied: record.proxied } : {}),
        ...(typeof record.private_routing === "boolean" ? { private_routing: record.private_routing } : {}),
        ...(typeof record.priority === "number" ? { priority: record.priority } : {}),
        ...(usesData && isRecordObject(record.data) ? { data: record.data } : {}),
        ...(typeof record.comment === "string" ? { comment: record.comment } : {}),
        ...(Array.isArray(record.tags) && record.tags.every((tag) => typeof tag === "string")
            ? { tags: record.tags }
            : {}),
        ...(isRecordObject(record.settings) ? { settings: record.settings } : {}),
    };
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function cloudflareApiRequest<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
): Promise<T> {
    const token = readManagedCloudflareOriginToken();
    try {
        const requestBody = body ? JSON.stringify(body) : undefined;
        const response = await safeHttpRequest(`${CLOUDFLARE_API_BASE}${path}`, {
            method,
            httpsOnly: true,
            maxRedirects: 0,
            maxBytes: MAX_API_BODY_CHARS,
            timeoutMs: API_TIMEOUT_MS,
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${token.apiToken}`,
                ...(body ? { "Content-Type": "application/json" } : {}),
            },
            ...(requestBody ? { body: requestBody } : {}),
        });
        const text = response.body.toString("utf8");
        let payload: CloudflareApiEnvelope<T>;
        try {
            payload = JSON.parse(text) as CloudflareApiEnvelope<T>;
        } catch {
            throw new Error(`Cloudflare API 返回了无法识别的内容（HTTP ${response.status}）`);
        }
        if (response.status < 200 || response.status >= 300 || payload.success !== true || payload.result === undefined) {
            const detail = payload.errors
                ?.map((item) => item.message?.trim())
                .filter((value): value is string => Boolean(value))
                .join("；");
            throw new Error(detail || `Cloudflare API 请求失败（HTTP ${response.status}）`);
        }
        return payload.result;
    } catch (error) {
        if (/timed out|timeout/i.test(readableError(error))) {
            throw new Error("Cloudflare API 请求在 30 秒内没有完成");
        }
        throw error;
    }
}

function partialDnsError(prefix: string, original: unknown, restore: unknown): Error {
    return new Error(
        `${prefix}。原始错误：${readableError(original)}；恢复错误：${readableError(restore)}。` +
        "Cloudflare 可能处于部分变更状态，请先运行 `codex-mcp doctor`，不要重复覆盖 DNS。",
    );
}

function readableError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isTunnelStatus(
    value: unknown,
): value is "inactive" | "degraded" | "healthy" | "down" {
    return value === "inactive" || value === "degraded" || value === "healthy" || value === "down";
}

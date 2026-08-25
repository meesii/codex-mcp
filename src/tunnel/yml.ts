import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { expandHomePath } from "../config/loader.js";
import { getUserConfigDir, type CloudflarePublicAccessConfig } from "../config/user-config.js";
import { writePrivateFileAtomic } from "../lib/fs/atomic-file.js";
import { normalizeTunnelId } from "./id.js";

export interface CloudflaredYml {
    tunnelId: string;
    credentialsFile: string;
    hostname: string;
    serviceUrl: string;
    raw: string;
}

export function getCloudflaredConfigPath(): string {
    return join(getUserConfigDir(), "cloudflared.yml");
}

export function getCloudflaredManagementConfigPath(): string {
    return join(getUserConfigDir(), "cloudflared-management.yml");
}

export function getCloudflaredRevisionDir(): string {
    return join(getUserConfigDir(), "tunnel-configs");
}

export function getCloudflaredRevisionPath(revision: string): string {
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(revision)) {
        throw new Error("Tunnel 配置 revision 格式不正确");
    }
    return join(getCloudflaredRevisionDir(), `${revision}.yml`);
}

export function resolveCloudflaredRuntimeConfigPath(
    access: CloudflarePublicAccessConfig,
): string {
    return access.configRevision
        ? getCloudflaredRevisionPath(access.configRevision)
        : getCloudflaredConfigPath();
}

export function getManagedCloudflareDir(): string {
    return join(getUserConfigDir(), "cloudflare");
}

export function getManagedCloudflaredStateDir(): string {
    return join(getManagedCloudflareDir(), ".cloudflared");
}

export function ensureCloudflaredManagementConfig(): string {
    const filePath = getCloudflaredManagementConfigPath();
    mkdirSync(dirname(filePath), { recursive: true });
    // Always pass an explicit config to cloudflared management commands so an
    // unrelated ~/.cloudflared/config.yml from an older Tunnel setup cannot leak in.
    writePrivateFileAtomic(filePath, "no-autoupdate: true\n");
    return filePath;
}

export function getCredentialsPath(tunnelId: string): string {
    return join(getManagedCloudflaredStateDir(), `${normalizeTunnelId(tunnelId)}.json`);
}

export function readCloudflaredYml(
    filePath: string = getCloudflaredConfigPath(),
): CloudflaredYml {
    if (!existsSync(filePath)) {
        throw new Error(`没有找到 cloudflared 配置：${filePath}`);
    }
    const raw = readFileSync(filePath, "utf8");
    const tunnelId = matchLine(raw, /^tunnel:\s*(.+)$/m);
    const credentialsRaw = matchLine(raw, /^credentials-file:\s*(.+)$/m);
    const credentialsFile = credentialsRaw
        ? stripQuotes(credentialsRaw)
        : undefined;
    const hostname = matchLine(raw, /^\s*-\s*hostname:\s*(.+)$/m);
    const serviceUrl = matchLine(raw, /^\s*service:\s*(https?:\/\/.+)$/m);

    if (!tunnelId) {
        throw new Error(`Tunnel 配置里缺少 ID：${filePath}`);
    }
    if (!credentialsFile) {
        throw new Error(`Tunnel 配置里缺少凭据文件：${filePath}`);
    }
    if (!hostname) {
        throw new Error(`Tunnel 配置里缺少域名：${filePath}`);
    }
    if (!serviceUrl) {
        throw new Error(`Tunnel 配置里缺少本机服务地址：${filePath}`);
    }

    return {
        tunnelId: normalizeTunnelId(tunnelId),
        credentialsFile: expandHomePath(credentialsFile.trim()),
        hostname: hostname.trim().toLowerCase(),
        serviceUrl: serviceUrl.trim(),
        raw,
    };
}

export function writeCloudflaredYml(
    input: {
        tunnelId: string;
        credentialsFile: string;
        hostname: string;
        serviceUrl: string;
    },
    filePath: string = getCloudflaredConfigPath(),
): void {
    mkdirSync(dirname(filePath), { recursive: true });
    const credentials = quoteYamlScalar(input.credentialsFile);
    // Keep the IPv4 workaround for broken dual-stack networks, but leave the
    // transport protocol on cloudflared's default auto mode so it can try QUIC
    // and fall back to HTTP/2 when needed.
    const body = [
        `tunnel: ${input.tunnelId}`,
        `credentials-file: ${credentials}`,
        "edge-ip-version: 4",
        "",
        "ingress:",
        `  - hostname: ${input.hostname}`,
        `    service: ${input.serviceUrl}`,
        "  - service: http_status:404",
        "",
    ].join("\n");
    writePrivateFileAtomic(filePath, body);
}

export function writeCloudflaredRevision(input: {
    tunnelId: string;
    credentialsFile: string;
    hostname: string;
    serviceUrl: string;
}): { revision: string; path: string } {
    const revision = randomUUID().replace(/-/g, "");
    const path = getCloudflaredRevisionPath(revision);
    writeCloudflaredYml(input, path);
    return { revision, path };
}

export function removeCloudflaredRevision(revision: string): void {
    rmSync(getCloudflaredRevisionPath(revision), { force: true });
}

function matchLine(text: string, pattern: RegExp): string | undefined {
    const match = text.match(pattern);
    return match?.[1]?.trim();
}

function stripQuotes(value: string): string {
    if (value.startsWith("'") && value.endsWith("'")) {
        return value.slice(1, -1).replace(/''/g, "'");
    }
    if (value.startsWith('"') && value.endsWith('"')) {
        return value.slice(1, -1);
    }
    return value;
}

function quoteYamlScalar(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expandHomePath } from "../config/loader.js";
import { getUserConfigDir } from "../config/user-config.js";

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

export function getCredentialsPath(tunnelId: string): string {
    return expandHomePath(`~/.cloudflared/${tunnelId}.json`);
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
        tunnelId: tunnelId.trim(),
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
    // Prefer HTTP/2 over IPv4: some dual-stack networks advertise IPv6 first
    // while outbound IPv6 TCP/7844 is unusable, causing cloudflared auto mode
    // to time out even though IPv4 TCP/7844 works.
    const body = [
        `tunnel: ${input.tunnelId}`,
        `credentials-file: ${credentials}`,
        "protocol: http2",
        "edge-ip-version: 4",
        "",
        "ingress:",
        `  - hostname: ${input.hostname}`,
        `    service: ${input.serviceUrl}`,
        "  - service: http_status:404",
        "",
    ].join("\n");
    writeFileSync(filePath, body, "utf8");
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

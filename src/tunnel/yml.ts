import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expandHomePath } from "../config.js";

export interface CloudflaredYml {
    tunnelId: string;
    credentialsFile: string;
    hostname: string;
    serviceUrl: string;
    raw: string;
}

/**
 * Default path to the cloudflared config file.
 *
 * @returns Absolute path (`~/.cloudflared/config.yml`)
 */
export function getCloudflaredConfigPath(): string {
    return expandHomePath("~/.cloudflared/config.yml");
}

/**
 * Default credentials JSON path for a tunnel UUID.
 *
 * @param tunnelId - Tunnel UUID
 * @returns Absolute credentials path
 */
export function getCredentialsPath(tunnelId: string): string {
    return expandHomePath(`~/.cloudflared/${tunnelId}.json`);
}

/**
 * Parse the subset of cloudflared config.yml fields we manage.
 *
 * @param filePath - Config path
 * @returns Parsed fields
 */
export function readCloudflaredYml(
    filePath: string = getCloudflaredConfigPath(),
): CloudflaredYml {
    if (!existsSync(filePath)) {
        throw new Error(`Missing cloudflared config: ${filePath}`);
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
        throw new Error(`No tunnel id in ${filePath}`);
    }
    if (!credentialsFile) {
        throw new Error(`No credentials-file in ${filePath}`);
    }
    if (!hostname) {
        throw new Error(`No ingress hostname in ${filePath}`);
    }
    if (!serviceUrl) {
        throw new Error(`No ingress http(s) service in ${filePath}`);
    }

    return {
        tunnelId: tunnelId.trim(),
        credentialsFile: expandHomePath(credentialsFile.trim()),
        hostname: hostname.trim().toLowerCase(),
        serviceUrl: serviceUrl.trim(),
        raw,
    };
}

/**
 * Write a minimal named-tunnel config.yml for this MCP server.
 *
 * @param input - Tunnel binding fields
 * @param filePath - Output path
 */
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
    // Prefer http2: many networks (CGNAT / firewalls) block QUIC UDP 7844,
    // which otherwise leaves the tunnel offline and Cloudflare returns 1033.
    const body = [
        `tunnel: ${input.tunnelId}`,
        `credentials-file: ${credentials}`,
        "protocol: http2",
        "",
        "ingress:",
        `  - hostname: ${input.hostname}`,
        `    service: ${input.serviceUrl}`,
        "  - service: http_status:404",
        "",
    ].join("\n");
    writeFileSync(filePath, body, "utf8");
}

/**
 * @param text - File contents
 * @param pattern - Regex with one capture group
 * @returns Captured group or undefined
 */
function matchLine(text: string, pattern: RegExp): string | undefined {
    const match = text.match(pattern);
    return match?.[1]?.trim();
}

/**
 * @param value - Possibly quoted YAML scalar
 * @returns Unquoted value
 */
function stripQuotes(value: string): string {
    if (
        (value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"'))
    ) {
        return value.slice(1, -1);
    }
    return value;
}

/**
 * Quote a path so Windows backslashes stay literal in YAML.
 *
 * @param value - Path string
 * @returns Single-quoted YAML scalar
 */
function quoteYamlScalar(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

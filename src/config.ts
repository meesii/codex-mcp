import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { UserConfig } from "./user-config.js";

export interface ServerConfig {
    host: string;
    port: number;
    /** Local inspector mode: loopback only and OAuth is not required. */
    local: boolean;
    /** Require embedded OAuth before `/mcp` requests reach the transport. */
    oauthRequired: boolean;
    /** Public MCP resource URL used by OAuth (e.g. https://mcp.example.com/mcp). */
    publicMcpUrl?: string;
    /** Absolute project directory bound at process start. */
    projectRoot: string;
    /**
     * Hostnames allowed in the HTTP Host header (for tunnels / public DNS).
     * When empty, localhost bindings keep the SDK default localhost-only check.
     */
    allowedHosts: string[];
    /**
     * Unique HTTPS origin for the ChatGPT widget sandbox (`_meta.ui.domain`).
     * Required to silence submission warnings; must be unique per app.
     */
    widgetDomain: string;
}

export interface LoadConfigOptions {
    /** Override project root (CLI `--root` or interactive choice). */
    projectRoot?: string;
    /** Values from `~/.codex-mcp/config.json`. */
    userConfig?: UserConfig;
    /**
     * When true, do not require a public domain / allowed hosts
     * (local MCP Inspector use).
     */
    local?: boolean;
}

/**
 * Expand a leading `~` to the user home directory.
 *
 * @param pathValue - Absolute or home-relative path
 * @returns Expanded absolute path when possible
 */
export function expandHomePath(pathValue: string): string {
    if (pathValue === "~") {
        return homedir();
    }
    if (pathValue.startsWith("~/") || pathValue.startsWith("~\\")) {
        return resolve(homedir(), pathValue.slice(2));
    }
    return pathValue;
}

/**
 * Resolve and validate the startup-bound project root directory.
 *
 * Order: explicit root → `process.cwd()`.
 *
 * @param explicitRoot - Optional CLI / interactive override
 * @returns Absolute project root
 */
export function resolveProjectRoot(explicitRoot?: string): string {
    if (explicitRoot?.trim()) {
        return assertProjectDirectory(explicitRoot.trim());
    }
    return assertProjectDirectory(process.cwd());
}

/**
 * Load server config from `~/.codex-mcp/config.json` and CLI options.
 *
 * @param options - CLI / user-config overlays
 * @returns Parsed server configuration
 */
export function loadConfig(options: LoadConfigOptions = {}): ServerConfig {
    const user = options.userConfig ?? {};
    const local = options.local === true;
    // `--local` is a security boundary, not just a tunnel toggle.
    const host = local ? "127.0.0.1" : user.host?.trim() || "127.0.0.1";
    const port = user.port ?? 3920;
    if (!Number.isFinite(port) || port < 0 || port > 65535) {
        throw new Error(`配置里的端口不正确：${port}`);
    }

    const projectRoot = resolveProjectRoot(options.projectRoot);
    const allowedHosts = !local && user.domain ? [user.domain.toLowerCase()] : [];
    const publicMcpUrl =
        !local && user.domain ? `https://${user.domain.toLowerCase()}/mcp` : undefined;

    return {
        host,
        port,
        local,
        oauthRequired: !local,
        ...(publicMcpUrl ? { publicMcpUrl } : {}),
        projectRoot,
        allowedHosts,
        widgetDomain: resolveWidgetDomain(allowedHosts, host, port),
    };
}

/**
 * Build the ChatGPT widget origin from the public host (or localhost).
 *
 * Always `https://codex-mcp.<first-allowed-host>` when a tunnel host exists.
 *
 * @param allowedHosts - Tunnel hostnames
 * @param host - Bind host
 * @param port - Bind port
 * @returns Absolute https/http origin
 */
export function resolveWidgetDomain(
    allowedHosts: string[],
    host: string,
    port: number,
): string {
    if (allowedHosts.length > 0) {
        return `https://codex-mcp.${allowedHosts[0]}`;
    }
    const localHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    return `http://${localHost}:${port}`;
}

/**
 * Resolve a path and require it to be an existing directory.
 *
 * @param pathValue - Candidate project root
 * @returns Absolute directory path
 */
function assertProjectDirectory(pathValue: string): string {
    const absolutePath = resolve(expandHomePath(pathValue));
    if (!existsSync(absolutePath) || !statSync(absolutePath).isDirectory()) {
        throw new Error(`这个项目目录不存在或不是文件夹：${pathValue}`);
    }
    return absolutePath;
}

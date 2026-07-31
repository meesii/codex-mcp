import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface ServerConfig {
    host: string;
    port: number;
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
 * Prefers `CODING_MCP_PROJECT_ROOT`. Falls back to a single-entry
 * `CODING_MCP_ALLOWED_ROOTS` for older env files.
 *
 * @param env - Environment map
 * @returns Absolute project root
 */
export function resolveProjectRoot(env: NodeJS.ProcessEnv): string {
    const projectRaw = env.CODING_MCP_PROJECT_ROOT?.trim();
    if (projectRaw) {
        return assertProjectDirectory(projectRaw);
    }

    const legacyRaw = env.CODING_MCP_ALLOWED_ROOTS?.trim();
    if (legacyRaw) {
        const parts = legacyRaw
            .split(";")
            .map((part) => part.trim())
            .filter(Boolean);
        if (parts.length === 1) {
            return assertProjectDirectory(parts[0]!);
        }
        if (parts.length > 1) {
            throw new Error(
                "CODING_MCP_ALLOWED_ROOTS no longer supports multiple roots. Set CODING_MCP_PROJECT_ROOT to a single project directory.",
            );
        }
    }

    throw new Error(
        "CODING_MCP_PROJECT_ROOT is required (absolute path to the project directory).",
    );
}

/**
 * Parse allowed HTTP Host header hostnames from a semicolon-separated env string.
 *
 * @param raw - Raw env value (hostnames without ports)
 * @returns Hostname list
 */
export function parseAllowedHosts(raw: string | undefined): string[] {
    if (!raw || raw.trim() === "") {
        return [];
    }

    return raw
        .split(";")
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean);
}

/**
 * Load server config from process environment.
 *
 * @param env - Environment map (defaults to `process.env`)
 * @returns Parsed server configuration
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
    const host = env.CODING_MCP_HOST?.trim() || "127.0.0.1";
    const portRaw = env.CODING_MCP_PORT?.trim() || "3920";
    const port = Number.parseInt(portRaw, 10);
    if (!Number.isFinite(port) || port < 0 || port > 65535) {
        throw new Error(`Invalid CODING_MCP_PORT: ${portRaw}`);
    }

    const projectRoot = resolveProjectRoot(env);
    const allowedHosts = parseAllowedHosts(env.CODING_MCP_ALLOWED_HOSTS);
    const widgetDomain = resolveWidgetDomain(env, allowedHosts, host, port);

    return { host, port, projectRoot, allowedHosts, widgetDomain };
}

/**
 * Resolve the unique widget origin for ChatGPT MCP Apps.
 *
 * Prefers `CODING_MCP_WIDGET_DOMAIN`. Falls back to the first allowed host,
 * then localhost.
 *
 * @param env - Environment map
 * @param allowedHosts - Tunnel hostnames
 * @param host - Bind host
 * @param port - Bind port
 * @returns Absolute https/http origin
 */
export function resolveWidgetDomain(
    env: NodeJS.ProcessEnv,
    allowedHosts: string[],
    host: string,
    port: number,
): string {
    const raw = env.CODING_MCP_WIDGET_DOMAIN?.trim();
    if (raw) {
        return normalizeOrigin(raw);
    }
    if (allowedHosts.length > 0) {
        // Unique per app: subdomain-style label under the tunnel host.
        return `https://codex-mcp.${allowedHosts[0]}`;
    }
    const localHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    return `http://${localHost}:${port}`;
}

/**
 * Normalize a URL or hostname into an origin string.
 *
 * @param value - URL or host
 * @returns Origin like https://example.com
 */
function normalizeOrigin(value: string): string {
    if (value.includes("://")) {
        const parsed = new URL(value);
        return parsed.origin;
    }
    return `https://${value.replace(/^\/+/, "").replace(/\/+$/, "")}`;
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
        throw new Error(`CODING_MCP_PROJECT_ROOT is not a directory: ${pathValue}`);
    }
    return absolutePath;
}

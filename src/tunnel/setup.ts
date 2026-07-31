import { existsSync } from "node:fs";
import { resolveCname } from "node:dns/promises";
import { expandHomePath } from "../config.js";
import {
    ensureStarterUserConfig,
    ensureUserConfigDirs,
    getUserConfigPath,
    loadUserConfig,
    normalizeHostname,
    saveUserConfig,
    type UserConfig,
} from "../user-config.js";
import {
    probeCloudflaredVersion,
    resolveCloudflaredBin,
    suggestCloudflaredBin,
} from "./bin.js";
import { runCloudflared, runCloudflaredInherit } from "./exec.js";
import { askLine, askYesNo, canPromptInteractively } from "./prompt.js";
import {
    getCloudflaredConfigPath,
    getCredentialsPath,
    readCloudflaredYml,
    writeCloudflaredYml,
} from "./yml.js";

const TUNNEL_ID_RE =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export interface TunnelSetupResult {
    userConfig: UserConfig;
    domain: string;
    useCloudflared: boolean;
    bin?: string;
    tunnelId?: string;
    configPath?: string;
}

export interface TunnelSetupOptions {
    /** Force the interactive question flow even when domain exists. */
    force?: boolean;
    host?: string;
    port?: number;
}

/**
 * Ensure machine config exists; run the first-time wizard when needed.
 *
 * Flow:
 * 1. Create `~/.codex-mcp/config.json` if missing
 * 2. Ask for public domain
 * 3. Ask whether to use cloudflared
 * 4. If yes: ask binary path, then login / create / DNS / write yml
 *
 * @param options - Force / bind hints
 * @returns Resolved settings (sidecar fields only when useCloudflared)
 */
export async function ensureTunnelSetup(
    options: TunnelSetupOptions = {},
): Promise<TunnelSetupResult> {
    const host = options.host ?? loadUserConfig().host ?? "127.0.0.1";
    const port = options.port ?? loadUserConfig().port ?? 3920;

    ensureUserConfigDirs();
    let userConfig = ensureStarterUserConfig(host, port);

    if (!options.force && userConfig.domain) {
        if (userConfig.useCloudflared === false) {
            return {
                userConfig,
                domain: userConfig.domain,
                useCloudflared: false,
            };
        }
        // Fully configured cloudflared → just refresh yml / resolve bin.
        if (
            userConfig.useCloudflared === true &&
            userConfig.cloudflaredBin &&
            userConfig.tunnelId
        ) {
            return await finalizeCloudflared(userConfig, host, port);
        }
        // Domain saved but tunnel setup was interrupted → resume wizard.
    }

    if (!canPromptInteractively()) {
        throw new Error(
            "No domain in ~/.codex-mcp/config.json. Run `codex-mcp` in an interactive terminal (not `tsx watch`), or set domain manually.",
        );
    }

    return await runConfigWizard(userConfig, host, port);
}

/**
 * Re-run the full interactive wizard (`codex-mcp tunnel`).
 *
 * @returns Setup result
 */
export async function runTunnelWizard(): Promise<TunnelSetupResult> {
    return ensureTunnelSetup({ force: true });
}

/**
 * @param userConfig - Current config (starter file already on disk)
 * @param host - Bind host
 * @param port - Bind port
 * @returns Wizard result
 */
async function runConfigWizard(
    userConfig: UserConfig,
    host: string,
    port: number,
): Promise<TunnelSetupResult> {
    const configPath = getUserConfigPath();
    const existingYml = tryReadExistingYml();

    console.log("");
    console.log("=== codex-mcp setup ===");
    console.log(`Config file: ${configPath}`);
    console.log("");

    // 1) Domain first — always.
    const domainDefault =
        userConfig.domain ?? existingYml?.hostname ?? undefined;
    let domainRaw = "";
    while (!domainRaw) {
        domainRaw = (
            await askLine(
                "Public domain for ChatGPT (e.g. mcp.example.com)",
                domainDefault,
            )
        ).trim();
        if (!domainRaw) {
            console.log("Domain is required.");
        }
    }
    const domain = normalizeHostname(domainRaw);

    userConfig = saveUserConfig({
        host,
        port,
        domain,
    });
    console.log(`Saved domain → ${configPath}`);
    console.log("");

    // 2) Optional cloudflared.
    const useCloudflared = await askYesNo(
        "Use cloudflared to expose this server?",
        true,
    );
    if (!useCloudflared) {
        userConfig = saveUserConfig({ useCloudflared: false });
        console.log(
            "OK. Domain saved. Start cloudflared yourself, or re-run: codex-mcp tunnel",
        );
        console.log("");
        return { userConfig, domain, useCloudflared: false };
    }

    // 3) Binary path, then tunnel ops.
    const bin = await askAndResolveCloudflaredBin(userConfig.cloudflaredBin);
    const tunnelName =
        (
            await askLine(
                "Tunnel name",
                userConfig.tunnelName ?? "codex-mcp",
            )
        ).trim() || "codex-mcp";

    await ensureLogin(bin);
    const tunnelId = await ensureTunnelCreated(
        bin,
        tunnelName,
        userConfig.tunnelId ?? existingYml?.tunnelId,
    );
    await ensureDnsRoute(bin, tunnelName, domain, tunnelId);

    const credentialsFile = getCredentialsPath(tunnelId);
    if (!existsSync(credentialsFile)) {
        throw new Error(
            `Tunnel credentials missing: ${credentialsFile}. Re-run create or check ~/.cloudflared.`,
        );
    }

    const serviceUrl = localServiceUrl(host, port);
    const cloudflaredConfigPath = getCloudflaredConfigPath();
    writeCloudflaredYml(
        {
            tunnelId,
            credentialsFile,
            hostname: domain,
            serviceUrl,
        },
        cloudflaredConfigPath,
    );
    console.log(`Wrote ${cloudflaredConfigPath}`);

    userConfig = saveUserConfig({
        useCloudflared: true,
        cloudflaredBin: bin,
        tunnelName,
        tunnelId,
    });
    console.log(`Saved ${configPath}`);
    console.log("");

    return {
        userConfig,
        domain,
        useCloudflared: true,
        bin,
        tunnelId,
        configPath: cloudflaredConfigPath,
    };
}

/**
 * Refresh yml / resolve bin for an already-configured cloudflared setup.
 *
 * @param userConfig - Saved config with domain + tunnel
 * @param host - Bind host
 * @param port - Bind port
 * @returns Sidecar-ready result
 */
async function finalizeCloudflared(
    userConfig: UserConfig,
    host: string,
    port: number,
): Promise<TunnelSetupResult> {
    const domain = userConfig.domain!;
    if (!userConfig.cloudflaredBin) {
        throw new Error(
            "useCloudflared is on but cloudflaredBin is missing. Run: codex-mcp tunnel",
        );
    }
    const bin = await resolveCloudflaredBin(userConfig.cloudflaredBin);
    const configPath = getCloudflaredConfigPath();

    let tunnelId = userConfig.tunnelId;
    if (!tunnelId) {
        if (!existsSync(configPath)) {
            throw new Error(
                `domain is set but ${configPath} is missing. Run: codex-mcp tunnel`,
            );
        }
        tunnelId = readCloudflaredYml(configPath).tunnelId;
        saveUserConfig({ tunnelId });
    }

    const credentialsFile = getCredentialsPath(tunnelId);
    if (!existsSync(credentialsFile)) {
        throw new Error(
            `Tunnel credentials missing: ${credentialsFile}. Run: codex-mcp tunnel`,
        );
    }

    writeCloudflaredYml(
        {
            tunnelId,
            credentialsFile,
            hostname: domain,
            serviceUrl: localServiceUrl(host, port),
        },
        configPath,
    );

    return {
        userConfig: { ...userConfig, tunnelId, useCloudflared: true },
        domain,
        useCloudflared: true,
        bin,
        tunnelId,
        configPath,
    };
}

/**
 * @param host - Bind host
 * @param port - Bind port
 * @returns Local upstream URL for ingress
 */
function localServiceUrl(host: string, port: number): string {
    const localHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    return `http://${localHost}:${port}`;
}

/**
 * @param bin - cloudflared path
 */
async function ensureLogin(bin: string): Promise<void> {
    const certPath = expandHomePath("~/.cloudflared/cert.pem");
    if (existsSync(certPath)) {
        console.log("Cloudflare cert already present (login skipped).");
        return;
    }
    console.log("Opening Cloudflare login (browser)...");
    const code = await runCloudflaredInherit(bin, ["tunnel", "login"]);
    if (code !== 0) {
        throw new Error("cloudflared tunnel login failed");
    }
    if (!existsSync(certPath)) {
        throw new Error(`Login finished but cert not found: ${certPath}`);
    }
}

/**
 * Resolve a tunnel UUID that has local credentials under `~/.cloudflared`.
 *
 * Cloudflare may list a tunnel by name while the credentials JSON is gone
 * (other machine, deleted file, interrupted create). In that case we delete
 * and recreate so `tunnel create` downloads a fresh `*.json`.
 *
 * @param bin - cloudflared path
 * @param tunnelName - Tunnel name
 * @param knownId - Previously saved UUID
 * @returns Tunnel UUID with local credentials present
 */
async function ensureTunnelCreated(
    bin: string,
    tunnelName: string,
    knownId?: string,
): Promise<string> {
    if (knownId && existsSync(getCredentialsPath(knownId))) {
        console.log(`Reusing tunnel ${tunnelName} (${knownId})`);
        return knownId;
    }

    const existing = await findTunnelIdByName(bin, tunnelName);
    if (existing && existsSync(getCredentialsPath(existing))) {
        console.log(`Reusing tunnel ${tunnelName} (${existing})`);
        return existing;
    }

    if (existing) {
        console.log(
            `Tunnel "${tunnelName}" exists in Cloudflare (${existing}) but local credentials JSON is missing.`,
        );
        console.log("Deleting and recreating to download new credentials...");
        await deleteTunnel(bin, tunnelName, existing);
    }

    console.log(`Creating tunnel ${tunnelName}...`);
    const result = await runCloudflared(
        bin,
        ["tunnel", "create", tunnelName],
        { allowFailure: true },
    );
    const combined = `${result.stdout}\n${result.stderr}`;
    const created = combined.match(TUNNEL_ID_RE)?.[0];
    if (result.code === 0 && created) {
        if (!existsSync(getCredentialsPath(created))) {
            throw new Error(
                `Tunnel created (${created}) but credentials file was not written to ~/.cloudflared.`,
            );
        }
        console.log(`Created tunnel id ${created}`);
        return created;
    }

    const again = await findTunnelIdByName(bin, tunnelName);
    if (again && existsSync(getCredentialsPath(again))) {
        console.log(`Using tunnel ${tunnelName} (${again})`);
        return again;
    }

    throw new Error(
        `Failed to create tunnel ${tunnelName}: ${(result.stderr || result.stdout).trim()}`,
    );
}

/**
 * Force-delete a tunnel by name, then by id if needed.
 *
 * @param bin - cloudflared path
 * @param tunnelName - Tunnel name
 * @param tunnelId - Tunnel UUID
 */
async function deleteTunnel(
    bin: string,
    tunnelName: string,
    tunnelId: string,
): Promise<void> {
    const byName = await runCloudflared(
        bin,
        ["tunnel", "delete", "-f", tunnelName],
        { allowFailure: true, timeoutMs: 120_000 },
    );
    if (byName.code === 0) {
        return;
    }
    const byId = await runCloudflared(
        bin,
        ["tunnel", "delete", "-f", tunnelId],
        { allowFailure: true, timeoutMs: 120_000 },
    );
    if (byId.code !== 0) {
        const detail = (byId.stderr || byName.stderr || byId.stdout || byName.stdout).trim();
        throw new Error(
            `Could not delete tunnel ${tunnelName} (${tunnelId}) to recreate credentials: ${detail}`,
        );
    }
}

/**
 * @param bin - cloudflared path
 * @param tunnelName - Name to resolve
 * @returns UUID or undefined
 */
async function findTunnelIdByName(
    bin: string,
    tunnelName: string,
): Promise<string | undefined> {
    const jsonAttempt = await runCloudflared(
        bin,
        ["tunnel", "list", "--output", "json"],
        { allowFailure: true, timeoutMs: 60_000 },
    );
    if (jsonAttempt.code === 0 && jsonAttempt.stdout.trim()) {
        try {
            const rows = JSON.parse(jsonAttempt.stdout) as Array<{
                id?: string;
                name?: string;
            }>;
            const hit = rows.find((row) => row.name === tunnelName);
            if (hit?.id) {
                return hit.id;
            }
        } catch {
            // fall through to text table
        }
    }

    const list = await runCloudflared(bin, ["tunnel", "list"], {
        allowFailure: true,
        timeoutMs: 60_000,
    });
    const text = `${list.stdout}\n${list.stderr}`;
    for (const line of text.split(/\r?\n/)) {
        if (!line.includes(tunnelName)) continue;
        const id = line.match(TUNNEL_ID_RE)?.[0];
        if (id) return id;
    }
    return undefined;
}

/**
 * Prompt for cloudflared path; default from config, PATH, or package `bin/`.
 *
 * @param configured - Existing cloudflaredBin from user config
 * @returns Absolute validated binary path
 */
async function askAndResolveCloudflaredBin(
    configured?: string,
): Promise<string> {
    const hint = await suggestCloudflaredBin(configured);
    if (!hint) {
        console.log(
            "Tip: on Windows you can use the repo binary, e.g. D:\\tmp\\codex-mcp\\bin\\cloudflared.exe",
        );
    }
    let answer = "";
    while (!answer) {
        answer = (
            await askLine("cloudflared binary path", hint || undefined)
        ).trim();
        if (!answer) {
            console.log("Path is required when using cloudflared.");
        }
    }
    const bin = await resolveCloudflaredBin(answer);
    const version = await probeCloudflaredVersion(bin);
    console.log(`Using ${version}`);
    console.log(`Binary: ${bin}`);
    return bin;
}

/**
 * @returns Parsed yml when present and valid
 */
function tryReadExistingYml():
    | { hostname: string; tunnelId: string }
    | undefined {
    const configPath = getCloudflaredConfigPath();
    if (!existsSync(configPath)) {
        return undefined;
    }
    try {
        const parsed = readCloudflaredYml(configPath);
        return { hostname: parsed.hostname, tunnelId: parsed.tunnelId };
    } catch {
        return undefined;
    }
}

/**
 * Ensure hostname DNS routes to this tunnel.
 *
 * cloudflared has no "list hostname routes" command, so we:
 * 1. Try `route dns` without overwrite
 * 2. On conflict, resolve public CNAME — skip if it already targets this tunnel
 * 3. Otherwise `route dns --overwrite-dns` (covers proxied CF records / old tunnels)
 *
 * @param bin - cloudflared path
 * @param tunnelName - Tunnel name
 * @param domain - Public hostname
 * @param tunnelId - Tunnel UUID (for CNAME target check)
 */
async function ensureDnsRoute(
    bin: string,
    tunnelName: string,
    domain: string,
    tunnelId: string,
): Promise<void> {
    console.log(`Routing DNS ${domain} → tunnel ${tunnelName}...`);
    const create = await runCloudflared(
        bin,
        ["tunnel", "route", "dns", tunnelName, domain],
        { allowFailure: true, timeoutMs: 120_000 },
    );
    if (create.code === 0) {
        console.log("DNS route created.");
        return;
    }

    if (!isDnsRecordConflict(create.stderr, create.stdout)) {
        throw new Error(
            `cloudflared tunnel route dns failed: ${(create.stderr || create.stdout).trim()}`,
        );
    }

    const pointsHere = await dnsPointsToTunnel(domain, tunnelId);
    if (pointsHere) {
        console.log(
            `DNS ${domain} already points to ${tunnelId}.cfargotunnel.com (ok).`,
        );
        return;
    }

    console.log(
        `DNS record for ${domain} exists but does not point to this tunnel; overwriting...`,
    );
    const overwrite = await runCloudflared(
        bin,
        ["tunnel", "route", "dns", "--overwrite-dns", tunnelName, domain],
        { allowFailure: true, timeoutMs: 120_000 },
    );
    if (overwrite.code === 0) {
        console.log("DNS route overwritten.");
        return;
    }
    throw new Error(
        `cloudflared tunnel route dns --overwrite-dns failed: ${(overwrite.stderr || overwrite.stdout).trim()}`,
    );
}

/**
 * @param stderr - Command stderr
 * @param stdout - Command stdout
 * @returns True when Cloudflare reports the hostname record already exists
 */
function isDnsRecordConflict(stderr: string, stdout: string): boolean {
    const detail = `${stderr}\n${stdout}`.toLowerCase();
    return (
        detail.includes("already exists") ||
        detail.includes("record with that host already exists") ||
        detail.includes("code: 1003")
    );
}

/**
 * Best-effort public DNS check. Proxied Cloudflare CNAMEs are often flattened
 * to A records, in which case this returns false and the caller overwrites.
 *
 * @param domain - Public hostname
 * @param tunnelId - Expected tunnel UUID
 * @returns True when a CNAME target is `<tunnelId>.cfargotunnel.com`
 */
async function dnsPointsToTunnel(
    domain: string,
    tunnelId: string,
): Promise<boolean> {
    const expected = `${tunnelId}.cfargotunnel.com`.toLowerCase();
    try {
        const names = await resolveCname(domain);
        return names.some(
            (name) => name.toLowerCase().replace(/\.$/, "") === expected,
        );
    } catch {
        return false;
    }
}

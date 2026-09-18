import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
    getUserConfigDir,
    getUserConfigPath,
    isLegacyUserConfigShape,
} from "./user-config.js";
import { normalizeTunnelId } from "../tunnel/id.js";
import { readTunnelCredentialIdentity } from "../tunnel/cloudflare-account.js";

export interface LegacyCleanupItem {
    path: string;
    kind: "file" | "directory";
    reason: string;
}

export interface LegacyCleanupPlan {
    breakingUpdate: boolean;
    items: LegacyCleanupItem[];
    preservedSystemPaths: string[];
}

const LEGACY_RUNTIME_CONFIG = "cloudflared.yml";
const MANAGEMENT_CONFIG = "cloudflared-management.yml";
const PRIVATE_CLOUDFLARE_DIR = "cloudflare";
const TUNNEL_CONFIG_DIR = "tunnel-configs";
const OAUTH_STATE_FILE = "oauth-state.json";

export function inspectLegacyCleanup(): LegacyCleanupPlan {
    const configDir = getUserConfigDir();
    const configPath = getUserConfigPath();
    const rawConfig = readConfigRecord(configPath);
    const legacyConfig = rawConfig ? isLegacyUserConfigShape(rawConfig) : false;
    const legacyRuntimePath = join(configDir, LEGACY_RUNTIME_CONFIG);
    const legacyTunnelId = findLegacyTunnelId(rawConfig, legacyRuntimePath);
    const oauthStatePath = join(configDir, OAUTH_STATE_FILE);
    const legacyOAuthState = isLegacyOAuthState(oauthStatePath);
    const items: LegacyCleanupItem[] = [];

    if (legacyConfig && existsSync(join(configDir, PRIVATE_CLOUDFLARE_DIR))) {
        items.push({
            path: join(configDir, PRIVATE_CLOUDFLARE_DIR),
            kind: "directory",
            reason: "旧版 codex-mcp 私有 Cloudflare 登录和 Tunnel 凭据，将由新版重新登录生成",
        });
    }
    if (legacyConfig && existsSync(join(configDir, TUNNEL_CONFIG_DIR))) {
        items.push({
            path: join(configDir, TUNNEL_CONFIG_DIR),
            kind: "directory",
            reason: "旧版生成的 Tunnel 运行配置，新版重新配置后会生成新的 revision",
        });
    }
    if (existsSync(legacyRuntimePath)) {
        items.push({
            path: legacyRuntimePath,
            kind: "file",
            reason: "1.0 之前使用的单文件 Tunnel 配置，新版不再读取",
        });
    }
    if (legacyConfig && existsSync(join(configDir, MANAGEMENT_CONFIG))) {
        items.push({
            path: join(configDir, MANAGEMENT_CONFIG),
            kind: "file",
            reason: "旧 Cloudflare 管理配置，可由新版按需重新生成",
        });
    }

    if (legacyOAuthState) {
        items.push({
            path: oauthStatePath,
            kind: "file",
            reason: "旧版 ChatGPT/OAuth 授权状态与当前版本不兼容；删除后需要在 ChatGPT 中重新连接 codex-mcp",
        });
    }

    const systemCloudflareDir = join(homedir(), ".cloudflared");
    if (legacyTunnelId) {
        const legacyCredential = join(systemCloudflareDir, `${legacyTunnelId}.json`);
        if (isMatchingTunnelCredential(legacyCredential, legacyTunnelId)) {
            items.push({
                path: legacyCredential,
                kind: "file",
                reason: `与旧版 codex-mcp Tunnel ID ${legacyTunnelId} 精确匹配的系统级 Tunnel 凭据`,
            });
        }
    }

    // Delete the legacy config last so a partial cleanup can still be retried deterministically.
    if (legacyConfig && existsSync(configPath)) {
        items.push({
            path: configPath,
            kind: "file",
            reason: "旧版用户配置；本版本不迁移，将重新进行 setup",
        });
    }

    return {
        breakingUpdate: legacyConfig || legacyOAuthState,
        items,
        preservedSystemPaths: [
            join(systemCloudflareDir, "cert.pem"),
            join(systemCloudflareDir, "config.yml"),
            join(systemCloudflareDir, "config.yaml"),
        ].filter((path) => existsSync(path)),
    };
}

export function applyLegacyCleanup(plan: LegacyCleanupPlan): string[] {
    const current = inspectLegacyCleanup();
    const displayed = plan.items.map((item) => `${item.kind}:${item.path}`);
    const now = current.items.map((item) => `${item.kind}:${item.path}`);
    if (JSON.stringify(displayed) !== JSON.stringify(now)) {
        throw new Error("旧版清理清单已经变化；为避免删除未确认的内容，请重新运行 `codex-mcp setup` 后再次确认");
    }

    const removed: string[] = [];
    for (const item of plan.items) {
        rmSync(item.path, { recursive: item.kind === "directory", force: true });
        removed.push(item.path);
    }
    return removed;
}

function readConfigRecord(path: string): Record<string, unknown> | undefined {
    if (!existsSync(path)) return undefined;
    try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
        return raw && typeof raw === "object" && !Array.isArray(raw)
            ? raw as Record<string, unknown>
            : undefined;
    } catch {
        return undefined;
    }
}

function isLegacyOAuthState(path: string): boolean {
    const state = readConfigRecord(path);
    return state?.version === 1;
}

function findLegacyTunnelId(
    rawConfig: Record<string, unknown> | undefined,
    legacyRuntimePath: string,
): string | undefined {
    const candidates: unknown[] = [
        rawConfig?.tunnelId,
        rawConfig?.publicAccess && typeof rawConfig.publicAccess === "object" && !Array.isArray(rawConfig.publicAccess)
            ? (rawConfig.publicAccess as Record<string, unknown>).tunnelId
            : undefined,
    ];
    if (existsSync(legacyRuntimePath)) {
        const match = readFileSync(legacyRuntimePath, "utf8").match(/^tunnel:\s*(.+)$/m)?.[1]?.trim();
        candidates.push(match);
    }
    for (const candidate of candidates) {
        if (typeof candidate !== "string" || !candidate.trim()) continue;
        try {
            return normalizeTunnelId(candidate, "旧版 Tunnel ID");
        } catch {
            // Keep looking for another trustworthy source.
        }
    }
    return undefined;
}

function isMatchingTunnelCredential(path: string, tunnelId: string): boolean {
    if (!existsSync(path)) return false;
    try {
        return readTunnelCredentialIdentity(path).tunnelId === tunnelId;
    } catch {
        return false;
    }
}

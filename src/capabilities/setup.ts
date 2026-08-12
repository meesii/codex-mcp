import { resolve } from "node:path";
import { CapabilityManager } from "./manager.js";
import { resolveCapabilitiesConfig } from "./config.js";
import type { CapabilitySourceDetection } from "./provider.js";
import {
    saveUserConfig,
    type CapabilitySourceConfig,
    type CapabilitySourceId,
    type UserCapabilitiesConfig,
} from "../config/user-config.js";
import { printInfo, printSummary } from "../lib/util/terminal.js";
import { askSelect } from "../tunnel/prompt.js";

const SOURCE_PRIORITY: CapabilitySourceId[] = ["agents", "codex", "claude"];

export interface CapabilitySetupResult {
    detections: CapabilitySourceDetection[];
    config?: UserCapabilitiesConfig;
    changed: boolean;
}

export async function configureCapabilitySources(
    primaryWorkspace = process.cwd(),
): Promise<CapabilitySetupResult> {
    const manager = new CapabilityManager(resolve(primaryWorkspace));
    const detections = await manager.detectSources();
    const detected = detections.filter((item) => item.detected);

    printSummary(
        "外部能力",
        detections.map((item) => ({
            label: item.label,
            value: item.detected
                ? describeDetection(item)
                : "未检测到",
        })),
    );

    if (detected.length === 0) {
        printInfo("没有检测到 Codex、Claude Code 或 Agent Skills；保持兼容默认设置，不写入额外配置。");
        return { detections, changed: false };
    }

    const action = await askSelect(
        "是否让 codex-mcp 使用这些已有能力？",
        [
            { value: "all", label: "使用检测到的全部能力", hint: "推荐；只读取源配置，不复制" },
            { value: "custom", label: "自定义", hint: "分别选择 MCP / Skills" },
            { value: "off", label: "都不使用" },
            { value: "keep", label: "保持当前设置" },
        ],
        "all",
    );

    if (action === "keep") return { detections, changed: false };

    const sources: Partial<Record<CapabilitySourceId, CapabilitySourceConfig>> = {};
    if (action === "all") {
        for (const item of detections) {
            sources[item.source] = detectedSourceDefaults(item);
        }
    } else if (action === "off") {
        for (const source of SOURCE_PRIORITY) {
            sources[source] = sourceDefaults(source, false);
        }
    } else {
        for (const item of detections) {
            sources[item.source] = item.detected
                ? await configureOneSource(item.source, item.label)
                : sourceDefaults(item.source, false);
        }
    }

    const anyEnabled = Object.values(sources).some((item) => item?.enabled === true);
    const sync = anyEnabled
        ? await askSelect(
              "外部能力变化时如何同步？",
              [
                  { value: "watch", label: "自动同步变化", hint: "推荐；源配置变化后热刷新" },
                  { value: "startup", label: "只在启动时读取", hint: "运行期间不监听文件变化" },
              ],
              "watch",
          )
        : "startup";

    const config: UserCapabilitiesConfig = {
        sync: sync as "watch" | "startup",
        priority: [...SOURCE_PRIORITY],
        sources,
    };
    saveUserConfig({ capabilities: config });
    return { detections, config, changed: true };
}

export function describeCapabilitiesConfig(config?: UserCapabilitiesConfig): string {
    const resolved = resolveCapabilitiesConfig(config);
    const enabled = resolved.priority
        .filter((source) => resolved.sources[source].enabled)
        .map(sourceLabel);
    const sync = resolved.sync === "startup" ? "仅启动读取" : "自动同步";
    return `${enabled.length > 0 ? enabled.join(" + ") : "未启用外部能力"} · ${sync}`;
}

function detectedSourceDefaults(item: CapabilitySourceDetection): CapabilitySourceConfig {
    if (!item.detected) return sourceDefaults(item.source, false);
    if (item.source === "agents") return { enabled: true, mcp: false, skills: true };
    if (item.source === "codex") {
        return {
            enabled: true,
            mcp: item.mcp,
            skills: item.skills || item.mcp,
        };
    }
    return { enabled: true, mcp: true, skills: true };
}

function sourceDefaults(source: CapabilitySourceId, enabled: boolean): CapabilitySourceConfig {
    return {
        enabled,
        mcp: enabled && source !== "agents",
        skills: enabled,
    };
}

async function configureOneSource(
    source: CapabilitySourceId,
    label: string,
): Promise<CapabilitySourceConfig> {
    if (source === "agents") {
        const choice = await askSelect(
            `${label}：`,
            [
                { value: "skills", label: "使用 Skills" },
                { value: "off", label: "不使用" },
            ],
            "skills",
        );
        return sourceDefaults(source, choice !== "off");
    }

    const choice = await askSelect(
        `${label}：`,
        [
            { value: "all", label: "使用 MCP + Skills" },
            { value: "mcp", label: "仅使用 MCP" },
            { value: "skills", label: "仅使用 Skills" },
            { value: "off", label: "不使用" },
        ],
        "all",
    );
    return {
        enabled: choice !== "off",
        mcp: choice === "all" || choice === "mcp",
        skills: choice === "all" || choice === "skills",
    };
}

function describeDetection(item: CapabilitySourceDetection): string {
    const parts: string[] = [];
    if (item.mcp) parts.push("MCP");
    if (item.skills) parts.push("Skills");
    if (parts.length === 0 && item.detail) parts.push(item.detail);
    return parts.length > 0 ? `已检测 · ${parts.join(" + ")}` : "已检测";
}

function sourceLabel(source: CapabilitySourceId): string {
    if (source === "agents") return "Agent Skills";
    if (source === "claude") return "Claude Code";
    return "Codex";
}

import { contactRunningDaemon } from "../daemon/control.js";
import { loadUserConfig } from "../config/user-config.js";
import { hasAdminPassword } from "../auth/password-store.js";
import { verifyRunningPublicRoute } from "../tunnel/setup-verify.js";
import { safeHttpGet } from "../lib/http/safe-http.js";

export interface ConnectionCheck {
    checkedAt: string;
    ready: boolean;
    checks: Array<{ id: string; label: string; state: "passed" | "failed" | "pending"; detail: string; action?: "start" | "connect" | "projects" | "repair" }>;
}

export async function checkConnection(): Promise<ConnectionCheck> {
    const checks: ConnectionCheck["checks"] = [];
    const daemon = await contactRunningDaemon();
    checks.push({ id: "service", label: "MCP 服务", state: daemon ? "passed" : "failed", detail: daemon ? "MCP 服务正在运行。" : "MCP 服务还没有启动，请先启动。", ...(!daemon ? { action: "start" as const } : {}) });
    if (daemon) {
        try {
            const result = await daemon.client.checkTools();
            checks.push({
                id: "tools",
                label: "工具与项目",
                state: result.projectCount ? "passed" : "failed",
                detail: result.projectCount
                    ? `工具可以正常使用，当前有 ${result.toolCount} 个工具、${result.projectCount} 个可用项目。`
                    : `工具可以正常使用（${result.toolCount} 个），但还没有可用项目。请先添加或重新启用一个项目。`,
                ...(!result.projectCount ? { action: "projects" as const } : {}),
            });
        } catch {
            checks.push({ id: "tools", label: "工具与项目", state: "failed", detail: "MCP 服务正在运行，但工具检查失败。请到“系统 → 检查与修复”查看具体原因。", action: "repair" });
        }
    }
    const access = loadUserConfig().publicAccess;
    const configured = Boolean(access);
    const password = await hasAdminPassword();
    checks.push({ id: "password", label: "连接密码", state: password ? "passed" : "pending", detail: password ? "已设置连接密码。" : "设置密码后才能安全连接 ChatGPT。", ...(!password ? { action: "connect" as const } : {}) });
    if (access && daemon) {
        try {
            const status = await daemon.client.status();
            if (!status.auth.required || status.publicMcpUrl !== `https://${access.domain}/mcp`) {
                checks.push({ id: "public", label: "ChatGPT 连接", state: "pending", detail: "公网地址已经配置，但当前 MCP 服务只在本机运行。切换到公网模式后 ChatGPT 才能连接。", action: "start" });
            } else {
                await verifyRunningPublicRoute(access.domain, daemon.state.host, daemon.state.port, { totalTimeoutMs: 10_000 });
                const challenge = await safeHttpGet(status.publicMcpUrl, { httpsOnly: true, maxBytes: 4096, maxRedirects: 0, timeoutMs: 10_000, headers: { Accept: "application/json, text/event-stream" } });
                if (challenge.status !== 401 || !challenge.headers["www-authenticate"]?.includes("Bearer")) throw new Error("登录保护未正常响应");
                checks.push({ id: "public", label: "ChatGPT 连接", state: "passed", detail: "公网地址已经确认连接到这台电脑，登录保护也正常。" });
            }
        } catch {
            checks.push({ id: "public", label: "ChatGPT 连接", state: "failed", detail: "公网地址目前无法连接到这台电脑。请到“连接”页面检查域名/Cloudflare 配置，或到“系统 → 检查与修复”查看具体原因。", action: "connect" });
        }
    } else {
        checks.push({ id: "public", label: "ChatGPT 连接", state: "pending", detail: configured ? "连接地址已经配置；启动 MCP 服务后才能继续验证。" : "还没有配置 ChatGPT 连接地址，请先完成连接设置。", action: configured ? "start" : "connect" });
    }
    return { checkedAt: new Date().toISOString(), ready: checks.every((item) => item.state === "passed"), checks };
}

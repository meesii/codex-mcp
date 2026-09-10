import { resolve } from "node:path";
import { generateAdminPassword, hasAdminPassword, setAdminPassword, verifyAdminPassword } from "../auth/password-store.js";
import { CapabilityManager } from "../capabilities/manager.js";
import { resolveCapabilitiesConfig } from "../capabilities/config.js";
import { ensureUserConfigDirs, loadUserConfig, saveUserConfig, type UserCapabilitiesConfig } from "../config/user-config.js";
import {
    cleanStaleDaemonState,
    contactRunningDaemon,
    startDaemonForIntent,
    stopDaemonContact,
    withDaemonLifecycleLock,
} from "../daemon/control.js";
import { loadProjectsFile, saveProjectsFile, type RegisteredProject, type RuntimeIntent } from "../daemon/state.js";
import { runDoctorChecks, type DoctorReport } from "../doctor/index.js";
import { runSelfUpdate } from "../doctor/update.js";
import { BindingStore } from "../projects/bindings.js";
import { canonicalProjectPath, detectProjectDisplayName } from "../projects/identity.js";
import { ProjectRegistry } from "../projects/registry.js";
import { readRecentLogLines } from "../lib/log-reader.js";
import {
    discoverCloudflareSetup,
    loadCommittedTunnelSetup,
    prepareCloudflareTunnelSetup,
    prepareExternalTunnelSetup,
} from "../tunnel/setup.js";
import { checkPublicAccess, configurePreparedPublicAccess } from "../tunnel/public-access-manager.js";

export interface RuntimeStartInput extends RuntimeIntent {
    /** When false, an existing daemon keeps its current intent. Mirrors CLI start without explicit mode flags. */
    intentSpecified?: boolean;
    projectPath?: string;
}

export interface ControlStatus {
    running: boolean;
    runtime?: Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof contactRunningDaemon>>>["client"]["status"]>>;
    projects: Array<RegisteredProject & { boundSessions?: number | null }>;
}

export interface DoctorServiceResult {
    fixes: string[];
    report: DoctorReport;
}

export async function getControlStatus(): Promise<ControlStatus> {
    const daemon = await contactRunningDaemon();
    if (!daemon) {
        cleanStaleDaemonState();
        return {
            running: false,
            projects: loadProjectsFile().map((item) => ({ ...item, boundSessions: null })),
        };
    }
    const runtime = await daemon.client.status();
    return { running: true, runtime, projects: runtime.projects };
}

export async function startRuntime(input: RuntimeStartInput): Promise<ControlStatus> {
    const desired: RuntimeIntent = {
        local: input.local,
        noTunnel: input.noTunnel,
        tunnelLogs: input.tunnelLogs,
    };
    const daemon = await ensureRuntime(desired, input.intentSpecified === true);
    if (input.projectPath) {
        const projectPath = canonicalProjectPath(resolve(input.projectPath));
        await daemon.client.registerProject({ path: projectPath, name: detectProjectDisplayName(projectPath) });
    }
    return await getControlStatus();
}

export async function stopRuntime(): Promise<boolean> {
    return await withDaemonLifecycleLock(async () => {
        const daemon = await contactRunningDaemon();
        if (!daemon) {
            cleanStaleDaemonState();
            return false;
        }
        await stopDaemonContact(daemon);
        return true;
    });
}

export async function restartRuntime(): Promise<ControlStatus> {
    await withDaemonLifecycleLock(async () => {
        const existing = await contactRunningDaemon();
        if (!existing) {
            cleanStaleDaemonState();
            throw new Error("守护进程没有在运行，无法重启");
        }
        const intent = existing.state.runtimeIntent;
        await assertIntentReady(intent);
        await stopDaemonContact(existing);
        await startDaemonForIntent(intent);
    });
    return await getControlStatus();
}

export async function listProjects(): Promise<Array<RegisteredProject & { boundSessions?: number | null }>> {
    return (await getControlStatus()).projects;
}

export async function addProject(pathValue: string, input: Omit<RuntimeStartInput, "projectPath">): Promise<RegisteredProject> {
    const projectPath = canonicalProjectPath(resolve(pathValue));
    const daemon = await ensureRuntime(
        { local: input.local, noTunnel: input.noTunnel, tunnelLogs: input.tunnelLogs },
        input.intentSpecified === true,
    );
    return await daemon.client.registerProject({ path: projectPath, name: detectProjectDisplayName(projectPath) });
}

export async function removeProject(target: string): Promise<{ removed: boolean; project: RegisteredProject }> {
    return await withDaemonLifecycleLock(async () => {
        const daemon = await contactRunningDaemon();
        const status = daemon ? await daemon.client.status() : undefined;
        const projects = status?.projects ?? loadProjectsFile();
        const project = resolveProjectSelection(projects, target);
        if (!project) throw new Error(`没有找到项目：${target}`);
        if (daemon) {
            const result = await daemon.client.deactivateProject(project.id, project.path);
            return { removed: result.removed, project };
        }
        await new BindingStore().invalidateProject(project.id);
        if (!project.active) return { removed: false, project };
        await saveProjectsFile(projects.map((item) => item.id === project.id ? { ...item, active: false } : item));
        return { removed: true, project };
    });
}

export async function getProject(target: string): Promise<(RegisteredProject & { boundSessions?: number | null }) | undefined> {
    const projects = await listProjects();
    return resolveProjectSelection(projects, target);
}

export async function runDoctorService(fix = false): Promise<DoctorServiceResult> {
    const fixes: string[] = [];
    if (fix) {
        const state = (await import("../daemon/state.js")).loadDaemonState();
        const stale = Boolean(state && !isPidAlive(state.pid));
        ensureUserConfigDirs();
        cleanStaleDaemonState();
        fixes.push("已确保 ~/.codex-mcp 和日志目录存在");
        if (stale) fixes.push("已清理失效的 daemon 状态文件");
    }
    return { fixes, report: await runDoctorChecks() };
}

export async function setConnectionPassword(password: string): Promise<void> {
    await setAdminPassword(password);
    if (!(await verifyAdminPassword(password))) throw new Error("连接密码保存后校验失败");
}

export async function generateConnectionPassword(): Promise<string> {
    const password = generateAdminPassword();
    await setConnectionPassword(password);
    return password;
}

export async function getSetupSummary(primaryWorkspace = process.cwd()): Promise<{
    config: ReturnType<typeof loadUserConfig>;
    passwordConfigured: boolean;
    capabilities: ReturnType<typeof resolveCapabilitiesConfig>;
    detections: Awaited<ReturnType<CapabilityManager["detectSources"]>>;
}> {
    const config = loadUserConfig();
    const manager = new CapabilityManager(resolve(primaryWorkspace));
    return {
        config,
        passwordConfigured: await hasAdminPassword(),
        capabilities: resolveCapabilitiesConfig(config.capabilities),
        detections: await manager.detectSources(),
    };
}

export function saveCapabilities(config: UserCapabilitiesConfig): ReturnType<typeof resolveCapabilitiesConfig> {
    const saved = saveUserConfig({ capabilities: config });
    return resolveCapabilitiesConfig(saved.capabilities);
}

export function readLogs(lines = 100): { path: string; text: string } {
    return readRecentLogLines(lines);
}

export async function discoverCloudflareForSetup(
    forceLogin = false,
    options: { signal?: AbortSignal; onLoginOutput?: (text: string) => void } = {},
) {
    return await discoverCloudflareSetup({ forceLogin, ...options });
}

export async function configureExternalPublicAccess(
    domain: string,
    options: { signal?: AbortSignal; onPhase?: (phase: string) => void } = {},
) {
    return await configurePreparedPublicAccess(
        ({ host, port }) => Promise.resolve(prepareExternalTunnelSetup(domain, { host, port })),
        options,
    );
}

export async function configureCloudflarePublicAccess(
    input: { zone: string; prefix: string; allowDnsOverwrite: boolean },
    options: { signal?: AbortSignal; onPhase?: (phase: string) => void } = {},
) {
    return await configurePreparedPublicAccess(
        ({ host, port }) => prepareCloudflareTunnelSetup({
            host,
            port,
            zone: input.zone,
            prefix: input.prefix,
        }),
        {
            ...options,
            confirmDnsOverwrite: async (domain) => {
                if (!input.allowDnsOverwrite) {
                    throw new Error(`域名 ${domain} 已有其它 DNS 记录；请在控制台确认允许替换后重试`);
                }
            },
        },
    );
}

export async function verifyPublicAccess() {
    return await checkPublicAccess();
}

export async function selfUpdate(options: { signal?: AbortSignal; onOutput?: (text: string) => void } = {}): Promise<void> {
    await runSelfUpdate(options);
}

async function ensureRuntime(intent: RuntimeIntent, intentSpecified: boolean) {
    const existing = await contactRunningDaemon();
    if (existing && !intentSpecified) return existing;
    if (existing && sameIntent(existing.state.runtimeIntent, intent)) return existing;
    return await withDaemonLifecycleLock(async () => {
        const current = await contactRunningDaemon();
        if (current && !intentSpecified) return current;
        if (current && sameIntent(current.state.runtimeIntent, intent)) return current;
        await assertIntentReady(intent);
        if (current) await stopDaemonContact(current);
        return await startDaemonForIntent(intent);
    });
}

async function assertIntentReady(intent: Pick<RuntimeIntent, "local" | "noTunnel">): Promise<void> {
    if (intent.local) return;
    const config = loadUserConfig();
    if (!config.publicAccess) throw new Error("还没有配置公网连接；请先完成 setup");
    if (!(await hasAdminPassword())) throw new Error("还没有设置连接密码；请先完成 setup 或 auth");
    if (!intent.noTunnel && config.publicAccess.kind === "cloudflare") {
        await loadCommittedTunnelSetup(config, config.host ?? "127.0.0.1", config.port ?? 3920);
    }
}

function sameIntent(left: RuntimeIntent, right: RuntimeIntent): boolean {
    return left.local === right.local && left.noTunnel === right.noTunnel && left.tunnelLogs === right.tunnelLogs;
}

function resolveProjectSelection<T extends RegisteredProject>(projects: T[], target: string): T | undefined {
    const byId = projects.find((item) => item.id === target);
    if (byId) return byId;
    const byName = projects.filter((item) => item.name === target);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) throw new Error(`项目名 ${target} 不唯一，请使用项目 ID 或完整目录`);
    try {
        const path = canonicalProjectPath(target);
        return projects.find((item) => item.path === path);
    } catch {
        return undefined;
    }
}

function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

// Keep the import live for consumers that need to construct registries in tests.
void ProjectRegistry;

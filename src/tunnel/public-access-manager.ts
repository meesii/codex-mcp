import { applyTunnelSetup, discardTunnelSetupCandidate } from "./apply-setup.js";
import { loadUserConfig } from "../config/user-config.js";
import {
    contactRunningDaemon,
    isProcessAlive,
    startDaemonForIntent,
    stopDaemonContact,
    withDaemonLifecycleLock,
    type DaemonContact,
} from "../daemon/control.js";
import type { RuntimeIntent } from "../daemon/state.js";
import { printInfo, printWarning } from "../lib/util/terminal.js";
import {
    ensureTunnelSetup,
    loadCommittedTunnelSetup,
    runTunnelWizard,
    type AppliedTunnelSetup,
    type TunnelSetupResult,
} from "./setup.js";
import {
    assertSetupPortAvailable,
    inspectSetupPort,
    verifyRunningPublicRoute,
    verifySetupPublicRoute,
    type SetupPublicVerificationResult,
} from "./setup-verify.js";

export interface ConfigurePublicAccessOptions {
    forceWizard: boolean;
    forceCloudflareLogin?: boolean;
}

export interface ConfigurePublicAccessResult extends AppliedTunnelSetup {
    daemonRestarted: boolean;
}

export interface ConfigurePreparedPublicAccessOptions {
    signal?: AbortSignal;
    onPhase?: (phase: string) => void;
    confirmDnsOverwrite?: (domain: string) => Promise<void>;
}

/** Single owner for interactive public configuration and daemon handoff. */
export async function configurePublicAccess(
    options: ConfigurePublicAccessOptions,
): Promise<ConfigurePublicAccessResult> {
    return await configurePreparedPublicAccess(async ({ host, port }) =>
        options.forceWizard
            ? await runTunnelWizard({
                  forceCloudflareLogin: options.forceCloudflareLogin,
                  host,
                  port,
              })
            : await ensureTunnelSetup({ host, port }),
    );
}

/** Transactional public-access orchestration shared by terminal setup and the local Web Console. */
export async function configurePreparedPublicAccess(
    prepareCandidate: (context: { host: string; port: number }) => Promise<TunnelSetupResult>,
    options: ConfigurePreparedPublicAccessOptions = {},
): Promise<ConfigurePublicAccessResult> {
    return await withDaemonLifecycleLock(async () => {
        const current = loadUserConfig();
        const host = current.host ?? "127.0.0.1";
        const port = current.port ?? 3920;
        const initialDaemon = await contactRunningDaemon();
        let previousIntent = initialDaemon?.state.runtimeIntent;

        options.signal?.throwIfAborted();
        options.onPhase?.("本机端口预检");
        // If no supported daemon owns the origin port, reject an unknown port
        // conflict before creating or changing any Cloudflare candidate resource.
        // A healthy daemon stays online while the candidate is prepared.
        if (!initialDaemon) {
            await assertSetupPortAvailable(host, port);
        }

        let candidate: TunnelSetupResult | undefined;
        let applyStarted = false;
        let stopAttempted: DaemonContact | undefined;
        let daemonStopped = false;
        let committed = false;
        try {
            options.onPhase?.("准备公网候选配置");
            candidate = await prepareCandidate({ host, port });
            options.signal?.throwIfAborted();

            const daemon = await contactRunningDaemon();
            if (daemon) {
                previousIntent = daemon.state.runtimeIntent;
                stopAttempted = daemon;
                printInfo(`公网候选配置已准备，正在短暂暂停后台服务（pid ${daemon.state.pid}）…`);
                await stopDaemonContact(daemon);
                daemonStopped = true;
            } else if (initialDaemon) {
                daemonStopped = true;
                printWarning("原后台服务在设置过程中已退出；完成后会按原运行模式重新启动。");
            }

            applyStarted = true;
            const applied = await applyTunnelSetup(candidate, {}, {
                signal: options.signal,
                onPhase: options.onPhase,
                confirmDnsOverwrite: options.confirmDnsOverwrite,
            });
            committed = true;
            if (previousIntent) {
                try {
                    options.onPhase?.("恢复后台服务");
                    await restartAfterSetup(previousIntent);
                } catch (restartError) {
                    throw new Error(
                        `公网配置已经提交并验证成功，但后台服务恢复失败：${readableError(restartError)}。` +
                        "请运行 `codex-mcp status` 和 `codex-mcp doctor` 检查，然后运行 `codex-mcp start` 重新启动。",
                    );
                }
            }
            return { ...applied, daemonRestarted: previousIntent !== undefined };
        } catch (error) {
            const recoveryErrors: string[] = [];
            if (candidate && !applyStarted) {
                try {
                    await discardTunnelSetupCandidate(candidate);
                } catch (discardError) {
                    recoveryErrors.push(`candidate 清理失败：${readableError(discardError)}`);
                }
            }
            if (previousIntent && !committed && (daemonStopped || stopAttempted)) {
                const originalStillAlive = stopAttempted
                    ? isProcessAlive(stopAttempted.state.pid)
                    : false;
                if (originalStillAlive) {
                    printWarning("公网配置没有完成；原后台服务仍在运行，无需重复启动。");
                } else {
                    try {
                        await restartAfterSetup(previousIntent);
                        printWarning("公网配置没有完成，已恢复原后台服务。");
                    } catch (restartError) {
                        recoveryErrors.push(`原后台服务恢复失败：${readableError(restartError)}`);
                    }
                }
            }
            if (recoveryErrors.length > 0) {
                throw new Error(`${readableError(error)}；${recoveryErrors.join("；")}`);
            }
            throw error;
        }
    });
}

/** Read-only public check. No login, migration, config write, or DNS mutation. */
export async function checkPublicAccess(): Promise<SetupPublicVerificationResult> {
    const config = loadUserConfig();
    const access = config.publicAccess;
    if (!access) throw new Error("还没有设置公网连接");
    const host = config.host ?? "127.0.0.1";
    const port = config.port ?? 3920;
    const committed = await loadCommittedTunnelSetup(config, host, port);
    const daemon = await contactRunningDaemon();
    if (daemon) {
        return await verifyRunningPublicRoute(access.domain, host, port);
    }
    const portState = await inspectSetupPort(host, port);
    if (portState === "codex-mcp") {
        return await verifyRunningPublicRoute(access.domain, host, port);
    }
    if (portState === "occupied") {
        throw new Error(`本机端口 ${port} 已被其它程序占用，无法检查公网连接`);
    }
    return await verifySetupPublicRoute(committed, host, port, {});
}

async function restartAfterSetup(intent: RuntimeIntent): Promise<DaemonContact> {
    printInfo("正在按原运行模式恢复后台服务…");
    return await startDaemonForIntent(intent);
}

function readableError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

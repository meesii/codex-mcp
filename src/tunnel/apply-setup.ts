import { printSuccess, printWarning } from "../lib/util/terminal.js";
import { withSpinner } from "./prompt.js";
import { getUserConfigPath, saveUserConfig } from "../config/user-config.js";
import { cutoverCloudflareDns, dnsSnapshotReferencesTunnel, dnsSnapshotPointsToTunnel, restoreCloudflareDns, snapshotCloudflareDns, type CloudflareDnsSnapshot } from "./cloudflare-api.js";
import { requireDnsOverwriteConfirmation } from "./confirm.js";
import { assertSetupPortAvailable, verifySetupPublicRoute } from "./setup-verify.js";
import { removeCloudflaredRevision } from "./yml.js";
import { cleanupCreatedTunnel } from "./cloudflare-session.js";
import type { AppliedTunnelSetup, TunnelSetupResult } from "./setup.js";

// Only external effects are replaceable. The transition order, commit decision,
// reference checks and compensation policy stay in this module.
const setupOperations = {
    assertSetupPortAvailable, verifySetupPublicRoute, snapshotCloudflareDns,
    cutoverCloudflareDns, restoreCloudflareDns, saveUserConfig,
    removeCloudflaredRevision, cleanupFailedCandidate, requireDnsOverwriteConfirmation,
};
type SetupOperations = typeof setupOperations;

export interface ApplyTunnelSetupOptions {
    signal?: AbortSignal;
    onPhase?: (phase: string) => void;
    confirmDnsOverwrite?: (domain: string) => Promise<void>;
}

/** Verify a candidate, compensate remote changes on failure, then commit locally. */
export async function applyTunnelSetup(
    candidate: TunnelSetupResult,
    overrides: Partial<SetupOperations> = {},
    options: ApplyTunnelSetupOptions = {},
): Promise<AppliedTunnelSetup> {
    const operations = { ...setupOperations, ...overrides };
    const host = candidate.userConfig.host ?? "127.0.0.1";
    const port = candidate.userConfig.port ?? 3920;
    const cancellation = installSetupCancellationGuard(options.signal);

    let dnsSnapshot: CloudflareDnsSnapshot | undefined;
    let committedDns: CloudflareDnsSnapshot | undefined;
    let dnsChanged = false;
    let phase = "本机端口预检";
    const setPhase = (next: string): void => {
        phase = next;
        options.onPhase?.(next);
    };
    options.onPhase?.(phase);
    try {
        await operations.assertSetupPortAvailable(host, port);
        cancellation.throwIfRequested();
        setPhase(candidate.useCloudflared ? "candidate connector 启动" : "公网验证");
        const verification = await operations.verifySetupPublicRoute(candidate, host, port, {
            signal: cancellation.signal,
            beforePublicVerify: candidate.useCloudflared
                ? async () => {
                      cancellation.throwIfRequested();
                      setPhase("DNS 快照");
                      if (!candidate.zoneId || !candidate.tunnelId) {
                          throw new Error("Cloudflare DNS 配置缺少 zone 或 Tunnel ID");
                      }
                      dnsSnapshot = await operations.snapshotCloudflareDns(candidate.zoneId, candidate.domain);
                      if (
                          dnsSnapshot.records.length > 0 &&
                          !dnsSnapshotPointsToTunnel(dnsSnapshot, candidate.tunnelId)
                      ) {
                          printWarning(`域名 ${candidate.domain} 已经有其它 DNS 记录，需要确认是否替换。`);
                          if (options.confirmDnsOverwrite) {
                              await options.confirmDnsOverwrite(candidate.domain);
                          } else {
                              await operations.requireDnsOverwriteConfirmation(candidate.domain);
                          }
                      }
                      cancellation.throwIfRequested();
                      setPhase("DNS cutover");
                      const cutover = await withSpinner(
                          `正在把域名 ${candidate.domain} 连接到已就绪的 Tunnel…`,
                          "DNS 路由切换完成",
                          () => operations.cutoverCloudflareDns(dnsSnapshot!, candidate.tunnelId!),
                      );
                      dnsChanged = cutover.changed;
                      committedDns = cutover.committed;
                      cancellation.throwIfRequested();
                      setPhase("公网验证");
                  }
                : undefined,
        });

        cancellation.throwIfRequested();
        setPhase("本机配置提交");
        const committedConfig = operations.saveUserConfig({
            host,
            port,
            publicAccess: candidate.publicAccess,
        });
        if (
            candidate.previousConfigRevision &&
            candidate.previousConfigRevision !== candidate.configRevision
        ) {
            try {
                operations.removeCloudflaredRevision(candidate.previousConfigRevision);
            } catch (error) {
                printWarning(`上一个 Tunnel 配置 revision 清理失败，可稍后手动检查：${readableError(error)}`);
            }
        }
        printSuccess(`codex-mcp 配置已原子提交：${getUserConfigPath()}`);
        return {
            result: { ...candidate, userConfig: committedConfig },
            verification,
        };
    } catch (error) {
        const recoveryErrors: string[] = [];
        let mayDeleteCreatedTunnel = !dnsSnapshot ||
            !candidate.tunnelId ||
            !dnsSnapshotPointsToTunnel(dnsSnapshot, candidate.tunnelId);
        if (dnsSnapshot && committedDns && dnsChanged) {
            mayDeleteCreatedTunnel = false;
            try {
                await operations.restoreCloudflareDns(dnsSnapshot, committedDns);
                mayDeleteCreatedTunnel = true;
                printWarning("公网验证失败，已恢复修改前的 DNS 记录。");
            } catch (restoreError) {
                recoveryErrors.push(`DNS 恢复失败：${readableError(restoreError)}`);
            }
        }
        if (
            dnsSnapshot &&
            candidate.candidateSession?.createdTunnel &&
            candidate.zoneId &&
            candidate.tunnelId
        ) {
            try {
                const latestDns = await operations.snapshotCloudflareDns(candidate.zoneId, candidate.domain);
                if (dnsSnapshotReferencesTunnel(latestDns, candidate.tunnelId)) {
                    mayDeleteCreatedTunnel = false;
                }
            } catch (inspectError) {
                mayDeleteCreatedTunnel = false;
                recoveryErrors.push(`candidate DNS 引用检查失败：${readableError(inspectError)}`);
            }
        }
        await operations.cleanupFailedCandidate(candidate, recoveryErrors, mayDeleteCreatedTunnel);
        if (recoveryErrors.length > 0) {
            throw new Error(
                `公网配置失败（阶段：${phase}）：${readableError(error)}；${recoveryErrors.join("；")}。` +
                "Cloudflare 可能处于部分变更状态，请先运行 `codex-mcp doctor`，不要重复覆盖 DNS。",
            );
        }
        throw new Error(`公网配置失败（阶段：${phase}）：${readableError(error)}`, {
            cause: error,
        });
    } finally {
        cancellation.dispose();
    }
}

export async function discardTunnelSetupCandidate(candidate: TunnelSetupResult): Promise<void> {
    const recoveryErrors: string[] = [];
    await cleanupFailedCandidate(candidate, recoveryErrors, true);
    if (recoveryErrors.length > 0) {
        throw new Error(recoveryErrors.join("；"));
    }
}

async function cleanupFailedCandidate(
    candidate: TunnelSetupResult,
    recoveryErrors: string[],
    mayDeleteCreatedTunnel: boolean,
): Promise<void> {
    if (candidate.candidateSession && candidate.configRevision) {
        try {
            removeCloudflaredRevision(candidate.configRevision);
        } catch (error) {
            recoveryErrors.push(`candidate YAML 清理失败：${readableError(error)}`);
        }
    }
    if (!candidate.candidateSession?.createdTunnel || !candidate.bin || !candidate.tunnelId) return;
    if (!mayDeleteCreatedTunnel) {
        recoveryErrors.push(
            "candidate Tunnel 仍可能被 DNS 引用，为避免扩大故障未自动删除",
        );
        return;
    }
    await cleanupCreatedTunnel(candidate.bin, candidate.tunnelId, recoveryErrors);
}

function installSetupCancellationGuard(externalSignal?: AbortSignal): {
    signal: AbortSignal;
    throwIfRequested: () => void;
    dispose: () => void;
} {
    const controller = new AbortController();
    let announced = false;
    const abort = (reason: unknown): void => {
        if (!controller.signal.aborted) {
            controller.abort(reason instanceof Error ? reason : new Error("已取消公网配置"));
        }
    };
    const onExternalAbort = (): void => abort(externalSignal?.reason);
    const onSigint = (): void => {
        abort(new Error("已取消公网配置"));
        if (!announced) {
            announced = true;
            printWarning("收到中断信号，正在安全结束本次公网配置；如已修改 DNS 会先尝试恢复。");
        }
    };
    if (externalSignal?.aborted) onExternalAbort();
    else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigint);
    return {
        signal: controller.signal,
        throwIfRequested: () => {
            if (controller.signal.aborted) {
                throw controller.signal.reason instanceof Error
                    ? controller.signal.reason
                    : new Error("已取消公网配置");
            }
        },
        dispose: () => {
            externalSignal?.removeEventListener("abort", onExternalAbort);
            process.off("SIGINT", onSigint);
            process.off("SIGTERM", onSigint);
        },
    };
}

function readableError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

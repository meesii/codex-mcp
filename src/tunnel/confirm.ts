import { askYesNo } from "./prompt.js";

export type ConfirmAction = (
    question: string,
    defaultValue?: boolean,
) => Promise<boolean>;

/** Require an explicit opt-in before deleting/recreating an existing remote tunnel. */
export async function requireTunnelDeleteConfirmation(
    tunnelName: string,
    confirm: ConfirmAction = askYesNo,
): Promise<void> {
    const approved = await confirm(
        `Cloudflare 上已有同名 Tunnel“${tunnelName}”，但这台电脑没有它的凭据。要删除并重新创建吗？这可能影响其它正在使用它的电脑。`,
        false,
    );
    if (!approved) {
        throw new Error("已取消。没有删除现有 Tunnel");
    }
}

/** Require an explicit opt-in before replacing an existing DNS record. */
export async function requireDnsOverwriteConfirmation(
    domain: string,
    confirm: ConfirmAction = askYesNo,
): Promise<void> {
    const approved = await confirm(
        `要把 ${domain} 现有的 DNS 记录改成当前 Tunnel 吗？这会改变这个域名现在指向的位置。`,
        false,
    );
    if (!approved) {
        throw new Error("已取消。没有修改现有 DNS 记录");
    }
}

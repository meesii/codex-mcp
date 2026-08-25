import { askYesNo } from "./prompt.js";

export type ConfirmAction = (
    question: string,
    defaultValue?: boolean,
) => Promise<boolean>;

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

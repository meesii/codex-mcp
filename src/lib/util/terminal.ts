import { styleText } from "node:util";

export type TerminalMessageKind = "info" | "warning" | "error" | "success";

const MESSAGE_STYLE: Record<
    TerminalMessageKind,
    { marker: string; color: Parameters<typeof styleText>[0] }
> = {
    info: { marker: "ℹ", color: "cyan" },
    warning: { marker: "!", color: "yellow" },
    error: { marker: "✗", color: "red" },
    success: { marker: "✓", color: "green" },
};

export function paintTerminal(
    format: Parameters<typeof styleText>[0],
    text: string,
): string {
    if (
        process.env.NO_COLOR !== undefined ||
        (process.stdout.isTTY !== true && process.stderr.isTTY !== true)
    ) {
        return text;
    }
    return styleText(format, text);
}

export function terminalMessage(kind: TerminalMessageKind, text: string): string {
    const style = MESSAGE_STYLE[kind];
    return paintTerminal(style.color, `${style.marker} ${text}`);
}

export function printInfo(text: string): void {
    console.log(terminalMessage("info", text));
}

export function printWarning(text: string): void {
    console.log(terminalMessage("warning", text));
}

export function printSuccess(text: string): void {
    console.log(terminalMessage("success", text));
}

export function printError(text: string): void {
    console.error(terminalMessage("error", text));
}

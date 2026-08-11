import {
    confirm,
    isCancel,
    password,
    text,
} from "@clack/prompts";
import { stdin as input, stdout as output } from "node:process";

/**
 * Whether stdin/stdout can drive an interactive wizard.
 *
 * @returns True when both are TTYs
 */
export function canPromptInteractively(): boolean {
    return input.isTTY === true && output.isTTY === true;
}

/**
 * Ask a yes/no question.
 *
 * @param question - Prompt text
 * @param defaultYes - Initially selected answer
 * @returns True for yes
 */
export async function askYesNo(
    question: string,
    defaultYes = true,
): Promise<boolean> {
    requireInteractiveTerminal();
    return promptValue(
        await confirm({
            message: question,
            initialValue: defaultYes,
            active: "是",
            inactive: "否",
        }),
    );
}

/**
 * Ask for a single line of input.
 *
 * @param question - Prompt text
 * @param defaultValue - Value when the user submits an empty input
 * @returns Trimmed answer (or default)
 */
export async function askLine(
    question: string,
    defaultValue?: string,
): Promise<string> {
    requireInteractiveTerminal();
    return promptValue(
        await text({
            message: question,
            ...(defaultValue !== undefined
                ? { placeholder: defaultValue, defaultValue }
                : {}),
        }),
    ).trim();
}

/**
 * Read a secret from an interactive TTY without echoing it.
 *
 * @param question - Prompt text
 * @returns Secret text without the trailing newline
 */
export async function askSecret(question: string): Promise<string> {
    requireInteractiveTerminal();
    return promptValue(await password({ message: question }));
}

function requireInteractiveTerminal(): void {
    if (!canPromptInteractively()) {
        throw new Error("这里需要在可以输入内容的终端里运行");
    }
}

function promptValue<T>(value: T | symbol): T {
    if (isCancel(value)) {
        throw new Error("已取消输入");
    }
    return value;
}

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { styleText } from "node:util";

/**
 * Whether stdin/stdout can drive an interactive wizard.
 *
 * @returns True when both are TTYs
 */
export function canPromptInteractively(): boolean {
    return input.isTTY === true && output.isTTY === true;
}

/**
 * Colorize prompt text when stdout is a TTY.
 *
 * @param format - Color format
 * @param text - Text
 * @returns Styled text
 */
function paint(format: Parameters<typeof styleText>[0], text: string): string {
    if (process.env.NO_COLOR !== undefined || output.isTTY !== true) {
        return text;
    }
    return styleText(format, text);
}

/**
 * Ask a yes/no question.
 *
 * @param question - Prompt text
 * @param defaultYes - Default when the user presses Enter
 * @returns True for yes
 */
export async function askYesNo(
    question: string,
    defaultYes = true,
): Promise<boolean> {
    const hint = defaultYes ? "回车=是 / n=否" : "y=是 / 回车=否";
    const answer = (await askLine(`${question} [${hint}]`)).trim().toLowerCase();
    if (!answer) {
        return defaultYes;
    }
    return answer === "y" || answer === "yes" || answer === "是";
}

/**
 * Ask for a single line of input.
 *
 * @param question - Prompt text
 * @param defaultValue - Value when the user presses Enter
 * @returns Trimmed answer (or default)
 */
export async function askLine(
    question: string,
    defaultValue?: string,
): Promise<string> {
    const rl = createInterface({ input, output });
    try {
        const suffix =
            defaultValue !== undefined && defaultValue !== ""
                ? ` (${paint(["dim", "underline"], defaultValue)})`
                : "";
        const answer = await rl.question(`${question}${suffix}: `);
        const trimmed = answer.trim();
        if (!trimmed && defaultValue !== undefined) {
            return defaultValue;
        }
        return trimmed;
    } finally {
        rl.close();
    }
}

/**
 * Read a secret from an interactive TTY without echoing it.
 *
 * @param question - Prompt text
 * @returns Secret text without the trailing newline
 */
export async function askSecret(question: string): Promise<string> {
    if (!canPromptInteractively() || typeof input.setRawMode !== "function") {
        throw new Error("这里需要在可以输入内容的终端里运行，才能安全输入密码");
    }

    output.write(`${question}: `);
    const wasRaw = input.isRaw === true;
    input.setRawMode(true);
    input.resume();

    try {
        return await new Promise<string>((resolve, reject) => {
            let value = "";
            const onData = (chunk: Buffer | string): void => {
                const text = chunk.toString();
                for (const char of text) {
                    if (char === "\r" || char === "\n") {
                        cleanup();
                        output.write("\n");
                        resolve(value);
                        return;
                    }
                    if (char === "\u0003") {
                        cleanup();
                        output.write("\n");
                        reject(new Error("已取消输入"));
                        return;
                    }
                    if (char === "\u007f" || char === "\b") {
                        value = value.slice(0, -1);
                        continue;
                    }
                    if (char >= " " && char !== "\u007f") {
                        value += char;
                    }
                }
            };
            const cleanup = (): void => {
                input.off("data", onData);
            };
            input.on("data", onData);
        });
    } finally {
        input.setRawMode(wasRaw);
        if (!wasRaw) input.pause();
    }
}

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
    const hint = defaultYes ? "Y/n" : "y/N";
    const answer = (await askLine(`${question} [${hint}]`)).trim().toLowerCase();
    if (!answer) {
        return defaultYes;
    }
    return answer === "y" || answer === "yes";
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

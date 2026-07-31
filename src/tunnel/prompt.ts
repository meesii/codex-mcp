import { createInterface } from "node:readline/promises";
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
                ? ` (${defaultValue})`
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

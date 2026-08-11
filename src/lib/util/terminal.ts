import {
    intro,
    log,
    note,
    outro,
} from "@clack/prompts";
import { stderr, stdout } from "node:process";
import type { Writable } from "node:stream";

export interface TerminalRow {
    label: string;
    value: string;
}

export type CompactLogKind = "error" | "info" | "success" | "warning";

export function printIntro(text: string, output: Writable = stdout): void {
    intro(text, { output });
}

export function printOutro(text: string, output: Writable = stdout): void {
    outro(text, { output });
}

export function printNote(
    title: string,
    message: string,
    output: Writable = stdout,
): void {
    note(message, title, { output });
}

export function printSummary(
    title: string,
    rows: TerminalRow[],
    output: Writable = stdout,
): void {
    printNote(
        title,
        rows.map((row) => `${row.label}  ${row.value}`).join("\n"),
        output,
    );
}

export function printInfo(text: string, output: Writable = stdout): void {
    log.info(text, { output });
}

export function printWarning(text: string, output: Writable = stdout): void {
    log.warn(text, { output });
}

export function printSuccess(text: string, output: Writable = stdout): void {
    log.success(text, { output });
}

export function printError(text: string, output: Writable = stderr): void {
    log.error(text, { output });
}

export function printCompactLog(
    kind: CompactLogKind,
    text: string,
    output: Writable = kind === "error" ? stderr : stdout,
): void {
    const options = { output, spacing: 0 };
    if (kind === "error") {
        log.error(text, options);
    } else if (kind === "warning") {
        log.warn(text, options);
    } else if (kind === "success") {
        log.success(text, options);
    } else {
        log.info(text, options);
    }
}

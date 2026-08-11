import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ProjectContext } from "../src/config/project.js";
import { readTextSlice } from "../src/tools/read.js";
import { listGlobFiles } from "../src/tools/glob.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";
import { ProcessSessionManager } from "../src/lib/process/sessions.js";

const DIRECTORY_COUNT = 100;
const FILES_PER_DIRECTORY = 100;
const LARGE_FILE_LINES = 50_000;
const REPEATS = 3;

interface BenchmarkRow {
    name: string;
    samplesMs: number[];
    medianMs: number;
}

async function measure(name: string, operation: () => Promise<unknown>): Promise<BenchmarkRow> {
    const samplesMs: number[] = [];
    for (let index = 0; index < REPEATS; index += 1) {
        const startedAt = performance.now();
        await operation();
        samplesMs.push(Number((performance.now() - startedAt).toFixed(2)));
    }
    const sorted = [...samplesMs].sort((left, right) => left - right);
    return {
        name,
        samplesMs,
        medianMs: sorted[Math.floor(sorted.length / 2)]!,
    };
}

async function createSyntheticWorkspace(root: string): Promise<string> {
    for (let directoryIndex = 0; directoryIndex < DIRECTORY_COUNT; directoryIndex += 1) {
        const directory = join(root, `pkg-${String(directoryIndex).padStart(3, "0")}`, "src");
        await mkdir(directory, { recursive: true });
        await Promise.all(
            Array.from({ length: FILES_PER_DIRECTORY }, async (_, fileIndex) => {
                const marker = fileIndex === 0 ? "needle-marker" : "ordinary-content";
                await writeFile(
                    join(directory, `file-${String(fileIndex).padStart(3, "0")}.ts`),
                    `export const value${fileIndex} = ${JSON.stringify(`${marker}-${directoryIndex}-${fileIndex}`)};\n`,
                    "utf8",
                );
            }),
        );
    }

    const largeFile = join(root, "large.ts");
    const lines = Array.from(
        { length: LARGE_FILE_LINES },
        (_, index) => `export const line${index} = ${index};\n`,
    ).join("");
    await writeFile(largeFile, lines, "utf8");
    return largeFile;
}

async function main(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "codex-mcp-perf-"));
    try {
        const largeFile = await createSyntheticWorkspace(root);
        const project = new ProjectContext(root);
        const workspace = new WorkspaceRegistry(project);

        // One warm-up prevents module/process startup from dominating the repeated samples.
        await workspace.search({ pattern: "needle-marker", maxMatches: 200 });
        await listGlobFiles(project, "**/*.ts");
        await readTextSlice(largeFile, 1, 200);

        const rows: BenchmarkRow[] = [];
        rows.push(
            await measure("workspace_search: 10k files / 100 hits", async () => {
                await workspace.search({ pattern: "needle-marker", maxMatches: 200 });
            }),
        );
        rows.push(
            await measure("workspace_search: high-hit / return 200", async () => {
                await workspace.search({ pattern: "export", maxMatches: 200 });
            }),
        );
        rows.push(
            await measure("glob: **/*.ts over 10k files", async () => {
                await listGlobFiles(project, "**/*.ts");
            }),
        );
        rows.push(
            await measure("read: first 200 lines", async () => {
                await readTextSlice(largeFile, 1, 200);
            }),
        );
        rows.push(
            await measure("read: lines 40k-40.2k", async () => {
                await readTextSlice(largeFile, 40_000, 200);
            }),
        );
        rows.push(
            await measure("process startup: true", async () => {
                const processes = new ProcessSessionManager();
                try {
                    await processes.start({
                        command: "true",
                        cwd: root,
                        yieldTimeMs: 30_000,
                    });
                } finally {
                    await processes.shutdown();
                }
            }),
        );
        const noisyScript = 'process.stdout.write("x".repeat(20 * 1024 * 1024))';
        const noisyCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(noisyScript)}`;
        rows.push(
            await measure("process buffer: capture 20 MiB rolling output", async () => {
                const processes = new ProcessSessionManager();
                try {
                    const snapshot = await processes.start({
                        command: noisyCommand,
                        cwd: root,
                        yieldTimeMs: 30_000,
                        maxOutputChars: 40_000,
                    });
                    if (snapshot.running && snapshot.processId) {
                        await processes.kill(snapshot.processId);
                    }
                } finally {
                    await processes.shutdown();
                }
            }),
        );

        console.log(
            JSON.stringify(
                {
                    fixture: {
                        files: DIRECTORY_COUNT * FILES_PER_DIRECTORY + 1,
                        directories: DIRECTORY_COUNT,
                        largeFileLines: LARGE_FILE_LINES,
                    },
                    results: rows,
                },
                null,
                2,
            ),
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

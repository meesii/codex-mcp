import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import type { DownstreamMcpHub, DownstreamReloadResult } from "../downstream/hub.js";
import { writeRuntimeLog } from "../lib/runtime-log.js";
import { printCompactLog } from "../lib/util/terminal.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { CapabilityManager } from "./manager.js";
import type { CapabilityWatchTarget } from "./provider.js";

const RELOAD_DEBOUNCE_MS = 400;

export interface CapabilityReloadResult {
    mcp: DownstreamReloadResult;
    skills: {
        generation: number;
        count: number;
    };
}

interface ActiveWatcher {
    watchedDirectory: string;
    recursive: boolean;
    watcher: FSWatcher;
}

export async function reloadCapabilities(
    manager: CapabilityManager,
    hub: DownstreamMcpHub,
    skills: SkillRegistry,
): Promise<CapabilityReloadResult> {
    const skillResult = manager.refreshSkills(skills);
    const mcpResult = await hub.reloadFromConfig(await manager.loadMcpConfig());
    return { mcp: mcpResult, skills: skillResult };
}

/**
 * Watch enabled external capability sources. Missing target directories are watched
 * through their nearest existing ancestor; after every reload watchers are reconciled
 * so newly created roots receive their own recursive watcher. In startup sync mode the
 * manager returns no watch targets and this class remains inert.
 */
export class CapabilityWatcher {
    private readonly watchers = new Map<string, ActiveWatcher>();
    private timer?: NodeJS.Timeout;
    private reloading = false;
    private reloadAgain = false;
    private started = false;

    constructor(
        private readonly manager: CapabilityManager,
        private readonly hub: DownstreamMcpHub,
        private readonly skills: SkillRegistry,
        private readonly onError: (error: unknown) => void = (error) => {
            const detail = error instanceof Error ? error.message : String(error);
            printCompactLog("error", `能力配置自动刷新失败：${detail}`);
            writeRuntimeLog("error", "capability_reload_failed", {
                reason: error instanceof Error ? error.name : "unknown",
            });
        },
    ) {}

    start(): void {
        if (this.started) return;
        this.started = true;
        this.refreshWatchers();
    }

    close(): void {
        this.started = false;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        for (const active of this.watchers.values()) active.watcher.close();
        this.watchers.clear();
    }

    private refreshWatchers(): void {
        if (!this.started) return;
        const targets = this.manager.getWatchTargets();
        const expected = new Set(targets.map((target) => target.key));

        for (const [key, active] of this.watchers) {
            if (expected.has(key)) continue;
            active.watcher.close();
            this.watchers.delete(key);
        }

        for (const target of targets) this.ensureWatcher(target);
    }

    private ensureWatcher(target: CapabilityWatchTarget): void {
        const exactExists = isDirectory(target.directory);
        const watchedDirectory = exactExists
            ? target.directory
            : nearestExistingDirectory(target.directory);
        if (!watchedDirectory) return;
        const recursive = exactExists && target.recursiveWhenExact;
        const fallbackEntry = exactExists
            ? undefined
            : relative(watchedDirectory, target.directory).split(sep).filter(Boolean)[0];
        const current = this.watchers.get(target.key);
        if (
            current?.watchedDirectory === watchedDirectory &&
            current.recursive === recursive
        ) {
            return;
        }
        if (current) {
            current.watcher.close();
            this.watchers.delete(target.key);
        }

        try {
            const watcher = watch(
                watchedDirectory,
                recursive ? { recursive: true } : undefined,
                (_event, changed) => {
                    const changedName = changed ? String(changed) : undefined;
                    if (
                        exactExists &&
                        target.fileName &&
                        changedName &&
                        changedName !== target.fileName
                    ) {
                        return;
                    }
                    if (!exactExists && fallbackEntry && changedName) {
                        const firstChangedSegment = changedName.split(/[\\/]/).filter(Boolean)[0];
                        if (firstChangedSegment !== fallbackEntry) return;
                    }
                    this.scheduleReload();
                },
            );
            watcher.on("error", this.onError);
            this.watchers.set(target.key, { watchedDirectory, recursive, watcher });
        } catch (error) {
            this.onError(error);
        }
    }

    private scheduleReload(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.runReload();
        }, RELOAD_DEBOUNCE_MS);
        this.timer.unref();
    }

    private async runReload(): Promise<void> {
        if (this.reloading) {
            this.reloadAgain = true;
            return;
        }
        this.reloading = true;
        try {
            await reloadCapabilities(this.manager, this.hub, this.skills);
        } catch (error) {
            this.onError(error);
        } finally {
            this.reloading = false;
            this.refreshWatchers();
            if (this.reloadAgain) {
                this.reloadAgain = false;
                this.scheduleReload();
            }
        }
    }
}

function nearestExistingDirectory(pathValue: string): string | undefined {
    let current = resolve(pathValue);
    while (!existsSync(current)) {
        const parent = dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
    return isDirectory(current) ? current : dirname(current);
}

function isDirectory(pathValue: string): boolean {
    try {
        return statSync(pathValue).isDirectory();
    } catch {
        return false;
    }
}

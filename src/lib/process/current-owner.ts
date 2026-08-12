import type { ProcessOwnerPool } from "./owner-pool.js";
import type {
    PollProcessInput,
    ProcessInfo,
    ProcessSessionAccess,
    ProcessSessionManager,
    ProcessSnapshot,
    StartProcessInput,
} from "./sessions.js";
import type { ProcessRuntimeStats } from "../util/telemetry.js";
import { currentToolOwnerId } from "../tool/context.js";

/**
 * Route process operations to the current tool-call owner. ChatGPT supplies a
 * per-conversation `openai/session` value in tool-call metadata; other MCP
 * clients fall back to the stable request/auth owner chosen by the HTTP layer.
 */
export class CurrentOwnerProcessSessions implements ProcessSessionAccess {
    constructor(
        private readonly root: ProcessSessionManager,
        private readonly owners: ProcessOwnerPool,
        private readonly fallbackOwnerId: string,
    ) {}

    start(input: StartProcessInput): Promise<ProcessSnapshot> {
        return this.withOwnerAsync((processes) => processes.start(input));
    }

    poll(input: PollProcessInput): Promise<ProcessSnapshot> {
        return this.withOwnerAsync((processes) => processes.poll(input));
    }

    kill(processId: number): Promise<ProcessSnapshot> {
        return this.withOwnerAsync((processes) => processes.kill(processId));
    }

    list(): ProcessInfo[] {
        return this.withOwner((processes) => processes.list());
    }

    status(processId: number): ProcessInfo {
        return this.withOwner((processes) => processes.status(processId));
    }

    peek(processId: number, maxOutputChars?: number): ProcessSnapshot {
        return this.withOwner((processes) => processes.peek(processId, maxOutputChars));
    }

    runtimeStats(): ProcessRuntimeStats {
        // runtime_status intentionally reports aggregate server telemetry rather
        // than exposing only the current conversation's process counts.
        return this.root.runtimeStats();
    }

    private withOwner<T>(run: (processes: ProcessSessionManager) => T): T {
        const lease = this.owners.acquire(currentToolOwnerId(this.fallbackOwnerId));
        try {
            return run(lease.processes);
        } finally {
            lease.release();
        }
    }

    private async withOwnerAsync<T>(
        run: (processes: ProcessSessionManager) => Promise<T>,
    ): Promise<T> {
        const lease = this.owners.acquire(currentToolOwnerId(this.fallbackOwnerId));
        try {
            return await run(lease.processes);
        } finally {
            lease.release();
        }
    }
}

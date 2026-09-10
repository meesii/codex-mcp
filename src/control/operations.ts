import { randomUUID } from "node:crypto";

export type OperationState = "running" | "succeeded" | "failed" | "cancelled";

export interface OperationSnapshot {
    id: string;
    kind: string;
    state: OperationState;
    phase: string;
    messages: string[];
    startedAt: string;
    finishedAt?: string;
    result?: unknown;
    error?: string;
}

export interface OperationContext {
    signal: AbortSignal;
    phase: (message: string) => void;
    note: (message: string) => void;
}

interface OperationRecord extends OperationSnapshot {
    controller: AbortController;
}

const MAX_OPERATIONS = 64;
const MAX_MESSAGES = 100;

export class OperationManager {
    private readonly records = new Map<string, OperationRecord>();

    start<T>(kind: string, run: (context: OperationContext) => Promise<T>): OperationSnapshot {
        this.prune();
        const id = randomUUID();
        const controller = new AbortController();
        const record: OperationRecord = {
            id,
            kind,
            state: "running",
            phase: "准备中",
            messages: [],
            startedAt: new Date().toISOString(),
            controller,
        };
        this.records.set(id, record);
        const context: OperationContext = {
            signal: controller.signal,
            phase: (message) => {
                record.phase = message;
                this.pushMessage(record, message);
            },
            note: (message) => this.pushMessage(record, message),
        };
        void run(context).then(
            (result) => {
                if (controller.signal.aborted) {
                    record.state = "cancelled";
                    record.error = readableAbortReason(controller.signal.reason);
                } else {
                    record.state = "succeeded";
                    record.result = result;
                    record.phase = "完成";
                }
                record.finishedAt = new Date().toISOString();
            },
            (error) => {
                record.state = controller.signal.aborted ? "cancelled" : "failed";
                record.error = error instanceof Error ? error.message : String(error);
                record.finishedAt = new Date().toISOString();
            },
        );
        return this.snapshot(record);
    }

    get(id: string): OperationSnapshot | undefined {
        const record = this.records.get(id);
        return record ? this.snapshot(record) : undefined;
    }

    cancel(id: string): OperationSnapshot | undefined {
        const record = this.records.get(id);
        if (!record) return undefined;
        if (record.state === "running" && !record.controller.signal.aborted) {
            record.controller.abort(new Error("用户取消了操作"));
            record.phase = "正在取消";
        }
        return this.snapshot(record);
    }

    private pushMessage(record: OperationRecord, message: string): void {
        record.messages.push(message);
        if (record.messages.length > MAX_MESSAGES) record.messages.splice(0, record.messages.length - MAX_MESSAGES);
    }

    private snapshot(record: OperationRecord): OperationSnapshot {
        const { controller: _controller, ...snapshot } = record;
        return { ...snapshot, messages: [...snapshot.messages] };
    }

    private prune(): void {
        if (this.records.size < MAX_OPERATIONS) return;
        const completed = [...this.records.values()]
            .filter((record) => record.state !== "running")
            .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
        while (this.records.size >= MAX_OPERATIONS && completed.length > 0) {
            this.records.delete(completed.shift()!.id);
        }
        if (this.records.size >= MAX_OPERATIONS) {
            throw new Error("当前正在执行的本机操作太多，请等待已有操作完成");
        }
    }
}

function readableAbortReason(reason: unknown): string {
    return reason instanceof Error ? reason.message : "操作已取消";
}

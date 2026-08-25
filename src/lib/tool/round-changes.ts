import { normalize } from "node:path";

export interface RoundFileChange {
    path: string;
    status: "added" | "deleted" | "modified";
    additions: number;
    deletions: number;
}

export interface RoundChangeSet {
    count: number;
    additions: number;
    deletions: number;
    files: RoundFileChange[];
}

interface TrackedFile {
    path: string;
    originalExists: boolean;
    originalContent: string | null;
    finalExists: boolean;
    finalContent: string | null;
}

export class RoundChangeTracker {
    private readonly files = new Map<string, TrackedFile>();

    recordCommitted(input: {
        relativePath: string;
        absolutePath: string;
        originalExists: boolean;
        originalContent: string | null;
        finalExists: boolean;
        finalContent: string | null;
    }): void {
        const key = process.platform === "win32" ? normalize(input.absolutePath).toLowerCase() : normalize(input.absolutePath);
        const current = this.files.get(key);
        if (current) {
            current.finalExists = input.finalExists;
            current.finalContent = input.finalContent;
            return;
        }
        this.files.set(key, {
            path: input.relativePath.replaceAll("\\", "/"),
            originalExists: input.originalExists,
            originalContent: input.originalContent,
            finalExists: input.finalExists,
            finalContent: input.finalContent,
        });
    }

    takeAndReset(): RoundChangeSet {
        const files: RoundFileChange[] = [];
        for (const tracked of this.files.values()) {
            const before = tracked.originalContent ?? "";
            const after = tracked.finalContent ?? "";
            if (tracked.originalExists === tracked.finalExists && normalizeText(before) === normalizeText(after)) continue;
            const [additions, deletions] = lineDiff(before, after);
            files.push({
                path: tracked.path,
                status: !tracked.originalExists ? "added" : !tracked.finalExists ? "deleted" : "modified",
                additions,
                deletions,
            });
        }
        this.files.clear();
        files.sort((a, b) => a.path.localeCompare(b.path));
        return {
            count: files.length,
            additions: files.reduce((sum, item) => sum + item.additions, 0),
            deletions: files.reduce((sum, item) => sum + item.deletions, 0),
            files,
        };
    }
}

export class RoundChangeStore {
    private readonly trackers = new Map<string, RoundChangeTracker>();

    forOwner(ownerKey: string): RoundChangeTracker {
        let tracker = this.trackers.get(ownerKey);
        if (!tracker) {
            tracker = new RoundChangeTracker();
            this.trackers.set(ownerKey, tracker);
        }
        return tracker;
    }
}

function lineDiff(before: string, after: string): [number, number] {
    const left = lines(before);
    const right = lines(after);
    let prefix = 0;
    while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
    let leftEnd = left.length;
    let rightEnd = right.length;
    while (leftEnd > prefix && rightEnd > prefix && left[leftEnd - 1] === right[rightEnd - 1]) {
        leftEnd -= 1;
        rightEnd -= 1;
    }
    const leftCount = leftEnd - prefix;
    const rightCount = rightEnd - prefix;
    if (leftCount === 0) return [rightCount, 0];
    if (rightCount === 0) return [0, leftCount];
    const distance = myersDistance(left, right, prefix, leftCount, rightCount);
    const common = Math.floor((leftCount + rightCount - distance) / 2);
    return [rightCount - common, leftCount - common];
}

function myersDistance(left: string[], right: string[], start: number, leftCount: number, rightCount: number): number {
    const max = leftCount + rightCount;
    const offset = max;
    const furthest = new Int32Array(max * 2 + 1);
    for (let distance = 0; distance <= max; distance += 1) {
        for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
            const index = offset + diagonal;
            let x = diagonal === -distance || (diagonal !== distance && furthest[index - 1]! < furthest[index + 1]!)
                ? furthest[index + 1]!
                : furthest[index - 1]! + 1;
            let y = x - diagonal;
            while (x < leftCount && y < rightCount && left[start + x] === right[start + y]) { x += 1; y += 1; }
            furthest[index] = x;
            if (x >= leftCount && y >= rightCount) return distance;
        }
    }
    return max;
}

function lines(value: string): string[] {
    if (!value) return [];
    const result = normalizeText(value).split("\n");
    if (result.at(-1) === "") result.pop();
    return result;
}

function normalizeText(value: string): string {
    return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

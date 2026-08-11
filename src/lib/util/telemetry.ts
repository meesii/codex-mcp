const MAX_RECENT_LATENCY_SAMPLES = 256;
const MAX_DOWNSTREAM_SERIES = 128;

export interface LatencyMetricSnapshot {
    calls: number;
    errors: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
    lastAt?: number;
}

export interface ToolMetricSnapshot extends LatencyMetricSnapshot {
    tool: string;
    responseBytes: {
        total: number;
        average: number;
        max: number;
    };
}

export interface HttpMetricSnapshot extends LatencyMetricSnapshot {
    requests: number;
    active: number;
    aborted: number;
    status4xx: number;
    status5xx: number;
}

export interface DownstreamMetricSnapshot extends LatencyMetricSnapshot {
    cacheHits: number;
    cacheMisses: number;
    reconnects: number;
    byServer: Array<LatencyMetricSnapshot & { server: string }>;
}

export interface ProcessRuntimeStats {
    running: number;
    retained: number;
    bufferedChars: number;
    starts: number;
    completions: number;
    outputTruncations: number;
}

export interface RuntimeTelemetrySnapshot {
    startedAt: number;
    uptimeMs: number;
    sampleWindow: number;
    tools: ToolMetricSnapshot[];
    http: HttpMetricSnapshot;
    downstream: DownstreamMetricSnapshot;
    processes: ProcessRuntimeStats;
}

class MetricSeries {
    private calls = 0;
    private errors = 0;
    private maxMs = 0;
    private lastAt: number | undefined;
    private readonly samples: number[] = [];
    private sampleCursor = 0;

    record(durationMs: number, isError: boolean): void {
        const boundedDuration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
        this.calls += 1;
        if (isError) this.errors += 1;
        this.maxMs = Math.max(this.maxMs, boundedDuration);
        this.lastAt = Date.now();

        if (this.samples.length < MAX_RECENT_LATENCY_SAMPLES) {
            this.samples.push(boundedDuration);
            return;
        }
        this.samples[this.sampleCursor] = boundedDuration;
        this.sampleCursor = (this.sampleCursor + 1) % MAX_RECENT_LATENCY_SAMPLES;
    }

    snapshot(): LatencyMetricSnapshot {
        const ordered = [...this.samples].sort((left, right) => left - right);
        return {
            calls: this.calls,
            errors: this.errors,
            p50Ms: percentile(ordered, 0.5),
            p95Ms: percentile(ordered, 0.95),
            maxMs: roundMetric(this.maxMs),
            ...(this.lastAt !== undefined ? { lastAt: this.lastAt } : {}),
        };
    }

    getCalls(): number {
        return this.calls;
    }
}

class ToolMetricSeries extends MetricSeries {
    private totalResponseBytes = 0;
    private maxResponseBytes = 0;

    recordTool(durationMs: number, isError: boolean, responseBytes: number): void {
        super.record(durationMs, isError);
        const bytes = Number.isFinite(responseBytes) ? Math.max(0, Math.floor(responseBytes)) : 0;
        this.totalResponseBytes += bytes;
        this.maxResponseBytes = Math.max(this.maxResponseBytes, bytes);
    }

    snapshotTool(tool: string): ToolMetricSnapshot {
        const calls = this.getCalls();
        return {
            tool,
            ...this.snapshot(),
            responseBytes: {
                total: this.totalResponseBytes,
                average: calls > 0 ? Math.round(this.totalResponseBytes / calls) : 0,
                max: this.maxResponseBytes,
            },
        };
    }
}

/**
 * Process-wide, memory-bounded runtime telemetry.
 *
 * Only aggregate counters, timings, tool/server names and byte counts are kept.
 * Arguments, command text, paths, response bodies and credentials are never retained.
 */
export class RuntimeTelemetry {
    private startedAt = Date.now();
    private readonly tools = new Map<string, ToolMetricSeries>();
    private http = new MetricSeries();
    private httpRequests = 0;
    private httpActive = 0;
    private httpAborted = 0;
    private http4xx = 0;
    private http5xx = 0;
    private downstream = new MetricSeries();
    private readonly downstreamByServer = new Map<string, MetricSeries>();
    private downstreamCacheHits = 0;
    private downstreamCacheMisses = 0;
    private downstreamReconnects = 0;

    recordTool(name: string, durationMs: number, isError: boolean, responseBytes: number): void {
        let series = this.tools.get(name);
        if (!series) {
            series = new ToolMetricSeries();
            this.tools.set(name, series);
        }
        series.recordTool(durationMs, isError, responseBytes);
    }

    beginHttpRequest(): void {
        this.httpRequests += 1;
        this.httpActive += 1;
    }

    finishHttpRequest(durationMs: number, statusCode: number, aborted: boolean): void {
        this.httpActive = Math.max(0, this.httpActive - 1);
        if (aborted) this.httpAborted += 1;
        if (statusCode >= 500) this.http5xx += 1;
        else if (statusCode >= 400) this.http4xx += 1;
        this.http.record(durationMs, aborted || statusCode >= 400);
    }

    recordDownstream(serverName: string, durationMs: number, isError: boolean): void {
        this.downstream.record(durationMs, isError);
        const key = this.downstreamKey(serverName);
        let series = this.downstreamByServer.get(key);
        if (!series) {
            series = new MetricSeries();
            this.downstreamByServer.set(key, series);
        }
        series.record(durationMs, isError);
    }

    recordDownstreamCache(hit: boolean): void {
        if (hit) this.downstreamCacheHits += 1;
        else this.downstreamCacheMisses += 1;
    }

    recordDownstreamReconnect(): void {
        this.downstreamReconnects += 1;
    }

    snapshot(processes: ProcessRuntimeStats): RuntimeTelemetrySnapshot {
        return {
            startedAt: this.startedAt,
            uptimeMs: Math.max(0, Date.now() - this.startedAt),
            sampleWindow: MAX_RECENT_LATENCY_SAMPLES,
            tools: [...this.tools.entries()]
                .map(([tool, series]) => series.snapshotTool(tool))
                .sort((left, right) => left.tool.localeCompare(right.tool)),
            http: {
                ...this.http.snapshot(),
                requests: this.httpRequests,
                active: this.httpActive,
                aborted: this.httpAborted,
                status4xx: this.http4xx,
                status5xx: this.http5xx,
            },
            downstream: {
                ...this.downstream.snapshot(),
                cacheHits: this.downstreamCacheHits,
                cacheMisses: this.downstreamCacheMisses,
                reconnects: this.downstreamReconnects,
                byServer: [...this.downstreamByServer.entries()]
                    .map(([server, series]) => ({ server, ...series.snapshot() }))
                    .sort((left, right) => left.server.localeCompare(right.server)),
            },
            processes: { ...processes },
        };
    }

    /** Test-only reset; production code never needs to clear telemetry. */
    reset(): void {
        this.startedAt = Date.now();
        this.tools.clear();
        this.httpRequests = 0;
        this.httpActive = 0;
        this.httpAborted = 0;
        this.http4xx = 0;
        this.http5xx = 0;
        this.downstreamByServer.clear();
        this.downstreamCacheHits = 0;
        this.downstreamCacheMisses = 0;
        this.downstreamReconnects = 0;
        this.http = new MetricSeries();
        this.downstream = new MetricSeries();
    }

    private downstreamKey(serverName: string): string {
        if (this.downstreamByServer.has(serverName)) return serverName;
        if (this.downstreamByServer.size < MAX_DOWNSTREAM_SERIES - 1) return serverName;
        return "__other__";
    }
}

export const runtimeTelemetry = new RuntimeTelemetry();

function percentile(sorted: number[], fraction: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
    return roundMetric(sorted[Math.min(index, sorted.length - 1)] ?? 0);
}

function roundMetric(value: number): number {
    return Math.round(value * 100) / 100;
}

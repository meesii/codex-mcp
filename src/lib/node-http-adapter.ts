import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { AuthInfo } from "@modelcontextprotocol/server";

interface WebHandler {
    fetch(
        request: Request,
        options?: {
            authInfo?: AuthInfo;
            parsedBody?: unknown;
        },
    ): Promise<Response>;
}

interface AuthenticatedIncomingMessage extends IncomingMessage {
    auth?: AuthInfo;
}

export interface NodeHttpAdapterOptions {
    onerror?: (error: Error) => void;
}

/**
 * Adapt a web-standard request handler to Node's IncomingMessage/ServerResponse.
 *
 * Express already parses MCP JSON bodies before this adapter is called. The
 * adapter still supports an unparsed body for direct Node usage, propagates
 * connection close through Request.signal, and honors response backpressure so
 * SSE responses do not buffer without bound.
 */
export function createNodeHttpAdapter(
    handler: WebHandler,
    options: NodeHttpAdapterOptions = {},
): (
    req: AuthenticatedIncomingMessage,
    res: ServerResponse,
    parsedBody?: unknown,
) => Promise<void> {
    return async (req, res, parsedBody) => {
        let finished = false;
        const abortController = new AbortController();
        const abortOnClose = (): void => {
            if (!finished) abortController.abort();
        };
        res.once("close", abortOnClose);
        if (res.destroyed) abortController.abort();

        let response: Response;
        try {
            const request = await toWebRequest(req, parsedBody, abortController.signal);
            response = await handler.fetch(request, {
                ...(req.auth ? { authInfo: req.auth } : {}),
                ...(parsedBody !== undefined ? { parsedBody } : {}),
            });
        } catch (error) {
            const normalized = error instanceof Error ? error : new Error(String(error));
            try {
                options.onerror?.(normalized);
            } catch {
                // Diagnostics must never replace the adapter fallback response.
            }
            response = internalServerErrorResponse(requestIdFromBody(parsedBody));
        }

        const headers: Record<string, string> = {};
        for (const [name, value] of response.headers) headers[name] = value;
        res.writeHead(response.status, headers);

        if (response.body === null) {
            finished = true;
            res.end();
            return;
        }

        const releaseDrain = createDrainWaiter(res, abortController.signal);
        const reader = response.body.getReader();
        try {
            while (!abortController.signal.aborted) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!res.write(value)) await releaseDrain.wait();
            }
        } catch (error) {
            if (!abortController.signal.aborted) {
                try {
                    options.onerror?.(
                        error instanceof Error ? error : new Error(String(error)),
                    );
                } catch {
                    // Headers may already be committed; logging is best-effort only.
                }
            }
        } finally {
            releaseDrain.dispose();
            reader.releaseLock();
        }

        finished = true;
        if (!res.destroyed && !res.writableEnded) res.end();
    };
}

async function toWebRequest(
    req: IncomingMessage,
    parsedBody: unknown,
    signal: AbortSignal,
): Promise<Request> {
    const method = (req.method ?? "GET").toUpperCase();
    const host = headerValue(req.headers, "host") ?? headerValue(req.headers, ":authority") ?? "localhost";
    const url = `http://${host}${req.url ?? "/"}`;
    const headers = toWebHeaders(req.headers);
    let body: string | undefined;

    if (method !== "GET" && method !== "HEAD") {
        if (parsedBody !== undefined) {
            const serialized = JSON.stringify(parsedBody);
            headers.delete("content-encoding");
            headers.delete("transfer-encoding");
            if (serialized === undefined) {
                headers.delete("content-length");
            } else {
                body = serialized;
                headers.set(
                    "content-length",
                    String(new TextEncoder().encode(serialized).byteLength),
                );
            }
        } else {
            body = await readRequestBody(req, signal);
        }
    }

    return new Request(url, {
        method,
        headers,
        signal,
        ...(body !== undefined && body.length > 0 ? { body } : {}),
    });
}

function toWebHeaders(headers: IncomingHttpHeaders): Headers {
    const result = new Headers();
    for (const [name, value] of Object.entries(headers)) {
        if (value === undefined || name.startsWith(":")) continue;
        if (Array.isArray(value)) {
            for (const item of value) result.append(name, item);
        } else {
            result.set(name, value);
        }
    }
    return result;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
}

async function readRequestBody(
    req: IncomingMessage,
    signal: AbortSignal,
): Promise<string | undefined> {
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of req) {
        if (signal.aborted) return undefined;
        text += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    return text.length > 0 ? text : undefined;
}

function requestIdFromBody(body: unknown): string | number | null {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const record = body as Record<string, unknown>;
    if (typeof record.method !== "string") return null;
    return typeof record.id === "string" || typeof record.id === "number" ? record.id : null;
}

function internalServerErrorResponse(id: string | number | null): Response {
    return Response.json(
        {
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id,
        },
        { status: 500 },
    );
}

function createDrainWaiter(
    res: ServerResponse,
    signal: AbortSignal,
): { wait: () => Promise<void>; dispose: () => void } {
    let resolveDrain: (() => void) | undefined;
    const onDrain = (): void => {
        resolveDrain?.();
        resolveDrain = undefined;
    };
    const onAbort = (): void => {
        resolveDrain?.();
        resolveDrain = undefined;
    };
    res.on("drain", onDrain);
    signal.addEventListener("abort", onAbort);

    return {
        wait: () =>
            signal.aborted
                ? Promise.resolve()
                : new Promise<void>((resolve) => {
                      resolveDrain = resolve;
                  }),
        dispose: () => {
            res.off("drain", onDrain);
            signal.removeEventListener("abort", onAbort);
            resolveDrain?.();
            resolveDrain = undefined;
        },
    };
}

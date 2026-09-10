import { randomBytes } from "node:crypto";
import { createControllerHttpServer } from "./http-server.js";
import {
    CONTROLLER_API_VERSION,
    removeControllerStateIfOwned,
    saveControllerState,
    type ControllerState,
} from "./state.js";
import { PACKAGE_VERSION } from "../server/version.js";
import { stopRuntime } from "./services.js";

/** Internal detached process. User commands talk to it; it is not a public CLI surface. */
export async function runControllerProcess(): Promise<void> {
    if (typeof process.send !== "function" || !process.connected) {
        throw new Error("controller 是内部入口；请运行 codex-mcp start");
    }

    const startedAt = new Date().toISOString();
    const baseState: Omit<ControllerState, "port"> = {
        schemaVersion: 1,
        apiVersion: CONTROLLER_API_VERSION,
        pid: process.pid,
        host: "127.0.0.1",
        controlToken: randomBytes(32).toString("base64url"),
        startedAt,
        version: PACKAGE_VERSION,
    };
    let closing = false;
    let ready = false;
    const startup = new AbortController();
    const cancelStartup = () => {
        if (!ready && !startup.signal.aborted) startup.abort(new Error("Controller 启动父进程已断开"));
    };

    const server = createControllerHttpServer({
        state: baseState,
        onShutdown: async () => {
            try { await stopRuntime(); }
            finally { await shutdown(0); }
        },
        onReplaced: async () => { await shutdown(0); },
    });

    const shutdown = async (exitCode: number): Promise<void> => {
        if (closing) return;
        closing = true;
        try { await server.close(); }
        finally {
            await removeControllerStateIfOwned(process.pid);
            process.exit(exitCode);
        }
    };

    process.once("disconnect", cancelStartup);
    const onSignal = () => { void shutdown(0); };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    try {
        startup.signal.throwIfAborted();
        await server.listen();
        startup.signal.throwIfAborted();
        await saveControllerState({ ...baseState, port: server.getPort() });
        ready = true;
        process.off("disconnect", cancelStartup);
        if (process.connected) process.disconnect();
    } catch (error) {
        try { await server.close(); } catch { /* preserve startup error */ }
        await removeControllerStateIfOwned(process.pid);
        throw error;
    }
}

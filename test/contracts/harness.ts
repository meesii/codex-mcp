import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
    ElicitRequestSchema,
    type CallToolResult,
    type ElicitRequest,
    type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "../../src/config/loader.js";
import { createHttpServer, type RunningHttpServer } from "../../src/server/http-server.js";
import { ProjectRegistry } from "../../src/projects/registry.js";
import { BindingStore } from "../../src/projects/bindings.js";
import { ProjectRuntimeManager } from "../../src/projects/runtime.js";
import { setAdminPassword } from "../../src/auth/password-store.js";
import { DownstreamMcpHub } from "../../src/downstream/hub.js";
import type { UserMcpConfig } from "../../src/config/user-mcp.js";
import { SkillRegistry, type SkillRoot } from "../../src/skills/registry.js";
import { CapabilityManager } from "../../src/capabilities/manager.js";
import { closeRuntimeLog, initializeRuntimeLog } from "../../src/lib/runtime-log.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "../..");
export const DIST_CLI = join(REPO_ROOT, "dist", "cli.js");

export interface TestEnvironment {
    home: string;
    cleanup: () => Promise<void>;
}

export async function createTestEnvironment(
    prefix = "codex-mcp-contract-",
    options: { createConfigDir?: boolean } = {},
): Promise<TestEnvironment> {
    const home = await mkdtemp(join(tmpdir(), prefix));
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousLogTools = process.env.CODING_MCP_LOG_TOOLS;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CODING_MCP_LOG_TOOLS = "0";
    if (options.createConfigDir !== false) {
        await mkdir(join(home, ".codex-mcp"), { recursive: true });
    }
    return {
        home,
        cleanup: async () => {
            if (previousHome === undefined) delete process.env.HOME;
            else process.env.HOME = previousHome;
            if (previousUserProfile === undefined) delete process.env.USERPROFILE;
            else process.env.USERPROFILE = previousUserProfile;
            if (previousLogTools === undefined) delete process.env.CODING_MCP_LOG_TOOLS;
            else process.env.CODING_MCP_LOG_TOOLS = previousLogTools;
            await removeTreeWithRetry(home);
        },
    };
}

export async function reserveFreePort(): Promise<number> {
    return await new Promise<number>((resolvePort, rejectPort) => {
        const server = createNetServer();
        server.once("error", rejectPort);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                server.close();
                rejectPort(new Error("Failed to reserve a loopback test port"));
                return;
            }
            const port = address.port;
            server.close((error) => {
                if (error) rejectPort(error);
                else resolvePort(port);
            });
        });
    });
}

export async function createProject(
    label: string,
    options: {
        files?: Record<string, string>;
        git?: boolean;
    } = {},
): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `codex-mcp-${label}-`));
    const files = options.files ?? { "identity.txt": `${label}\n` };
    for (const [relative, content] of Object.entries(files)) {
        const target = join(root, relative);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
    }
    if (options.git) initGit(root);
    return root;
}

export function initGit(root: string): void {
    git(root, ["init"]);
    git(root, ["config", "user.email", "contract-tests@example.test"]);
    git(root, ["config", "user.name", "contract tests"]);
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "fixture baseline"]);
}

export function git(root: string, args: string[]): string {
    return execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_OPTIONAL_LOCKS: "0",
        },
    });
}

export interface PublicMcpClient {
    raw: Client;
    listTools: () => Promise<Array<{
        name: string;
        description?: string;
        inputSchema?: unknown;
        annotations?: Record<string, unknown>;
        _meta?: Record<string, unknown>;
    }>>;
    call: (
        name: string,
        args?: Record<string, unknown>,
        meta?: Record<string, unknown>,
    ) => Promise<CallToolResult>;
    close: () => Promise<void>;
}

export async function connectMcp(
    mcpUrl: string,
    options: {
        bearerToken?: string;
        headers?: Record<string, string>;
        elicitationHandler?: (params: ElicitRequest["params"]) => Promise<ElicitResult> | ElicitResult;
        name?: string;
    } = {},
): Promise<PublicMcpClient> {
    const headers = {
        ...(options.headers ?? {}),
        ...(options.bearerToken ? { Authorization: `Bearer ${options.bearerToken}` } : {}),
    };
    const client = new Client(
        { name: options.name ?? "codex-mcp-contract", version: "1.0.0" },
        options.elicitationHandler
            ? { capabilities: { elicitation: { form: {} } } }
            : undefined,
    );
    if (options.elicitationHandler) {
        client.setRequestHandler(ElicitRequestSchema, async (request) =>
            await options.elicitationHandler!(request.params),
        );
    }
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
    });
    await client.connect(transport);
    return {
        raw: client,
        listTools: async () => {
            const result = await client.listTools();
            return result.tools as Array<{
                name: string;
                description?: string;
                inputSchema?: unknown;
                annotations?: Record<string, unknown>;
                _meta?: Record<string, unknown>;
            }>;
        },
        call: async (name, args = {}, meta) =>
            await client.callTool({
                name,
                arguments: args,
                ...(meta ? { _meta: meta } : {}),
            }) as CallToolResult,
        close: async () => {
            await client.close();
        },
    };
}

export function resultText(result: CallToolResult): string {
    return result.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}

export function expectToolOk<T extends Record<string, unknown> = Record<string, unknown>>(
    result: CallToolResult,
    label = "tool call",
): T {
    assert.notEqual(result.isError, true, `${label} failed: ${resultText(result)}`);
    return (result.structuredContent ?? {}) as T;
}

export function expectToolError(result: CallToolResult, pattern?: RegExp): string {
    assert.equal(result.isError, true, `expected tool error, got: ${resultText(result)}`);
    const text = resultText(result);
    if (pattern) assert.match(text, pattern);
    return text;
}

export interface RegisteredProjectView {
    id: string;
    name: string;
    path: string;
    active: boolean;
}

export interface DaemonHarness {
    home: string;
    mcpUrl: string;
    baseUrl: string;
    controlToken: string;
    oauthRequired: boolean;
    password?: string;
    registerProject: (path: string, name?: string) => Promise<RegisteredProjectView>;
    deactivateProject: (id: string, path?: string) => Promise<unknown>;
    status: () => Promise<Record<string, unknown>>;
    restart: () => Promise<void>;
    close: () => Promise<void>;
}

export async function startDaemonHarness(options: {
    home: string;
    bootstrapRoot?: string;
    oauthRequired?: boolean;
    password?: string;
    hub?: DownstreamMcpHub;
    skills?: SkillRegistry;
    capabilities?: CapabilityManager;
    goalStorageDir?: string;
}): Promise<DaemonHarness> {
    const bootstrapRoot = options.bootstrapRoot ?? await createProject("daemon-bootstrap");
    const controlToken = randomBytes(24).toString("base64url");
    const oauthRequired = options.oauthRequired ?? false;
    const password = options.password ?? "contract-test-password";
    let server: RunningHttpServer | undefined;
    let runtimes: ProjectRuntimeManager | undefined;
    let mcpUrl = "";
    let baseUrl = "";

    const boot = async (): Promise<void> => {
        if (oauthRequired) await setAdminPassword(password);
        const registry = new ProjectRegistry();
        const bindings = new BindingStore();
        runtimes = new ProjectRuntimeManager({
            goalStorageDir: options.goalStorageDir,
        });
        const config: ServerConfig = {
            host: "127.0.0.1",
            port: 0,
            local: !oauthRequired,
            oauthRequired,
            projectRoot: bootstrapRoot,
            allowedHosts: [],
            widgetDomain: "http://127.0.0.1",
        };
        server = createHttpServer(config, {
            ...(options.hub ? { hub: options.hub } : {}),
            ...(options.skills ? { skills: options.skills } : {}),
            ...(options.capabilities ? { capabilities: options.capabilities } : {}),
            ...(options.goalStorageDir ? { goalStorageDir: options.goalStorageDir } : {}),
            daemon: {
                registry,
                bindings,
                runtimes,
                controlToken,
                tunnelStatus: () => ({ running: false }),
                onShutdown: async () => undefined,
            },
        });
        await server.listen();
        mcpUrl = server.getMcpUrl();
        baseUrl = new URL(mcpUrl).origin;
    };

    await boot();

    const controlFetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
        const response = await fetch(new URL(path, baseUrl), {
            ...init,
            headers: {
                "x-codex-control-token": controlToken,
                ...(init.body ? { "content-type": "application/json" } : {}),
                ...(init.headers ?? {}),
            },
        });
        return response;
    };

    const harness: DaemonHarness = {
        home: options.home,
        get mcpUrl() { return mcpUrl; },
        get baseUrl() { return baseUrl; },
        controlToken,
        oauthRequired,
        ...(oauthRequired ? { password } : {}),
        registerProject: async (path, name) => {
            const response = await controlFetch("/daemon/projects", {
                method: "POST",
                body: JSON.stringify({ path, ...(name ? { name } : {}) }),
            });
            assert.equal(response.status, 200, await response.clone().text());
            const body = await response.json() as { project: RegisteredProjectView };
            return body.project;
        },
        deactivateProject: async (id, path) => {
            const suffix = path ? `?path=${encodeURIComponent(path)}` : "";
            const response = await controlFetch(`/daemon/projects/${encodeURIComponent(id)}${suffix}`, {
                method: "DELETE",
            });
            assert.equal(response.status, 200, await response.clone().text());
            return await response.json();
        },
        status: async () => {
            const response = await controlFetch("/daemon/status");
            assert.equal(response.status, 200, await response.clone().text());
            return await response.json() as Record<string, unknown>;
        },
        restart: async () => {
            await server?.close();
            await runtimes?.shutdownAll();
            server = undefined;
            runtimes = undefined;
            await boot();
        },
        close: async () => {
            await server?.close().catch(() => undefined);
            await runtimes?.shutdownAll().catch(() => undefined);
            server = undefined;
            runtimes = undefined;
        },
    };
    return harness;
}

export function discoverSkillRegistry(roots: SkillRoot[]): SkillRegistry {
    return SkillRegistry.discover(roots);
}

export async function createDownstreamHub(config: UserMcpConfig): Promise<DownstreamMcpHub> {
    const hub = DownstreamMcpHub.empty();
    await hub.reloadFromConfig(config);
    return hub;
}

export async function startRuntimeLog(directory: string): Promise<{ close: () => void }> {
    await initializeRuntimeLog({ directory });
    return { close: () => closeRuntimeLog() };
}

export async function createCapabilityBundle(options: {
    primaryWorkspace: string;
    home: string;
}): Promise<{
    capabilities: CapabilityManager;
    skills: SkillRegistry;
    hub: DownstreamMcpHub;
}> {
    const capabilities = new CapabilityManager(options.primaryWorkspace, {
        homeDirectory: options.home,
    });
    const skills = capabilities.createSkillRegistry();
    const hub = DownstreamMcpHub.empty();
    await hub.reloadFromConfig(await capabilities.loadMcpConfig());
    return { capabilities, skills, hub };
}

export interface SingleProjectHarness {
    root: string;
    mcpUrl: string;
    baseUrl: string;
    close: () => Promise<void>;
}

export async function startSingleProjectHarness(options: {
    root: string;
    oauthRequired?: boolean;
    password?: string;
    workspaceRoots?: string[];
    hub?: DownstreamMcpHub;
    skills?: SkillRegistry;
    capabilities?: CapabilityManager;
    goalStorageDir?: string;
}): Promise<SingleProjectHarness> {
    const oauthRequired = options.oauthRequired ?? false;
    if (oauthRequired) await setAdminPassword(options.password ?? "contract-test-password");
    const config: ServerConfig = {
        host: "127.0.0.1",
        port: 0,
        local: !oauthRequired,
        oauthRequired,
        projectRoot: options.root,
        ...(options.workspaceRoots ? { workspaceRoots: options.workspaceRoots } : {}),
        allowedHosts: [],
        widgetDomain: "http://127.0.0.1",
    };
    const server = createHttpServer(config, {
        ...(options.hub ? { hub: options.hub } : {}),
        ...(options.skills ? { skills: options.skills } : {}),
        ...(options.capabilities ? { capabilities: options.capabilities } : {}),
        ...(options.goalStorageDir ? { goalStorageDir: options.goalStorageDir } : {}),
    });
    await server.listen();
    const mcpUrl = server.getMcpUrl();
    return {
        root: options.root,
        mcpUrl,
        baseUrl: new URL(mcpUrl).origin,
        close: async () => await server.close(),
    };
}

export interface OAuthSession {
    clientId: string;
    accessToken: string;
    refreshToken: string;
    redirectUri: string;
}

/**
 * Exercise the public OAuth discovery/DCR/PKCE/password approval flow and return
 * an access token for a newly registered client. This helper contains no server
 * implementation logic and deliberately uses only HTTP endpoints.
 */
export async function issueOAuthSession(options: {
    baseUrl: string;
    mcpUrl: string;
    password: string;
    clientName: string;
    redirectPort?: number;
}): Promise<OAuthSession> {
    const redirectUri = `http://127.0.0.1:${options.redirectPort ?? 54321}/callback`;
    const registrationResponse = await fetch(new URL("/register", options.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            redirect_uris: [redirectUri],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            client_name: options.clientName,
            scope: "mcp:tools offline_access",
        }),
    });
    assert.equal(registrationResponse.status, 201, await registrationResponse.clone().text());
    const registration = await registrationResponse.json() as { client_id: string };
    assert.ok(registration.client_id);

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizeUrl = new URL("/authorize", options.baseUrl);
    authorizeUrl.searchParams.set("client_id", registration.client_id);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("scope", "mcp:tools offline_access");
    authorizeUrl.searchParams.set("resource", options.mcpUrl);
    authorizeUrl.searchParams.set("state", randomBytes(8).toString("hex"));

    const login = await fetch(authorizeUrl, { redirect: "manual" });
    assert.equal(login.status, 200, await login.clone().text());

    const approvalBody = new URLSearchParams(authorizeUrl.searchParams);
    approvalBody.set("password", options.password);
    const approval = await fetch(new URL("/authorize", options.baseUrl), {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: approvalBody,
    });
    assert.equal(approval.status, 302, await approval.clone().text());
    const location = approval.headers.get("location");
    assert.ok(location);
    const code = new URL(location).searchParams.get("code");
    assert.ok(code);

    const tokenResponse = await fetch(new URL("/token", options.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: registration.client_id,
            code,
            code_verifier: verifier,
            redirect_uri: redirectUri,
            resource: options.mcpUrl,
        }),
    });
    assert.equal(tokenResponse.status, 200, await tokenResponse.clone().text());
    const tokens = await tokenResponse.json() as {
        access_token: string;
        refresh_token: string;
    };
    assert.ok(tokens.access_token);
    assert.ok(tokens.refresh_token);
    return {
        clientId: registration.client_id,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        redirectUri,
    };
}

export async function refreshOAuthSession(options: {
    baseUrl: string;
    mcpUrl: string;
    clientId: string;
    refreshToken: string;
}): Promise<{ accessToken: string; refreshToken: string }> {
    const response = await fetch(new URL("/token", options.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: options.clientId,
            refresh_token: options.refreshToken,
            scope: "mcp:tools offline_access",
            resource: options.mcpUrl,
        }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const tokens = await response.json() as { access_token: string; refresh_token: string };
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
}

export async function readJsonFile<T>(path: string): Promise<T> {
    return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

export async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
    await waitUntil(async () => await exists(path), timeoutMs, `file: ${path}`);
}

export async function waitUntil(
    predicate: () => Promise<boolean> | boolean,
    timeoutMs = 2_000,
    label = "condition",
): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (await predicate()) return;
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

async function removeTreeWithRetry(path: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
            await rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 });
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolveWait) => setTimeout(resolveWait, 40 * (attempt + 1)));
        }
    }
    throw lastError;
}

export interface CliRunResult {
    code: number;
    stdout: string;
    stderr: string;
}

export async function runCli(
    args: string[],
    options: {
        cwd?: string;
        home?: string;
        env?: Record<string, string>;
        timeoutMs?: number;
    } = {},
): Promise<CliRunResult> {
    const timeoutMs = options.timeoutMs ?? 20_000;
    return await new Promise<CliRunResult>((resolvePromise, rejectPromise) => {
        const child = spawn(process.execPath, [DIST_CLI, ...args], {
            cwd: options.cwd ?? REPO_ROOT,
            env: {
                ...process.env,
                ...(options.home ? { HOME: options.home, USERPROFILE: options.home } : {}),
                NO_COLOR: "1",
                FORCE_COLOR: "0",
                CODING_MCP_LOG_TOOLS: "0",
                ...(options.env ?? {}),
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
        child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            rejectPromise(new Error(`CLI timed out after ${timeoutMs}ms: ${args.join(" ")}\n${stdout}\n${stderr}`));
        }, timeoutMs);
        child.once("error", (error) => {
            clearTimeout(timer);
            rejectPromise(error);
        });
        child.once("exit", (code) => {
            clearTimeout(timer);
            resolvePromise({ code: code ?? -1, stdout, stderr });
        });
    });
}

export interface RunningCli {
    child: ChildProcess;
    waitForOutput: (pattern: RegExp, timeoutMs?: number) => Promise<string>;
    stop: () => Promise<void>;
    output: () => string;
}

export function spawnCli(
    args: string[],
    options: { cwd?: string; home?: string; env?: Record<string, string> } = {},
): RunningCli {
    const child = spawn(process.execPath, [DIST_CLI, ...args], {
        cwd: options.cwd ?? REPO_ROOT,
        env: {
            ...process.env,
            ...(options.home ? { HOME: options.home, USERPROFILE: options.home } : {}),
            NO_COLOR: "1",
            FORCE_COLOR: "0",
            CODING_MCP_LOG_TOOLS: "0",
            ...(options.env ?? {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let combined = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { combined += chunk; });
    child.stderr?.on("data", (chunk: string) => { combined += chunk; });
    return {
        child,
        output: () => combined,
        waitForOutput: async (pattern, timeoutMs = 10_000) => {
            const started = Date.now();
            while (Date.now() - started < timeoutMs) {
                if (pattern.test(combined)) return combined;
                if (child.exitCode !== null) {
                    throw new Error(`CLI exited before output matched ${pattern}:\n${combined}`);
                }
                await new Promise((resolveWait) => setTimeout(resolveWait, 25));
            }
            throw new Error(`Timed out waiting for ${pattern}:\n${combined}`);
        },
        stop: async () => {
            if (child.exitCode !== null) return;
            child.kill(process.platform === "win32" ? undefined : "SIGTERM");
            await new Promise<void>((resolveStop) => {
                const timer = setTimeout(() => {
                    child.kill("SIGKILL");
                    resolveStop();
                }, 2_000);
                child.once("exit", () => {
                    clearTimeout(timer);
                    resolveStop();
                });
            });
        },
    };
}

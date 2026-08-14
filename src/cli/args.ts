export type CliCommand =
    | "serve"
    | "setup"
    | "doctor"
    | "tunnel"
    | "auth"
    | "update"
    | "version"
    | "help"
    | "status"
    | "stop"
    | "restart"
    | "logs"
    | "project"
    | "exit"
    | "daemon";

export type ProjectAction = "list" | "add" | "remove" | "info";

type FlagName =
    | "local"
    | "noTunnel"
    | "tunnelLogs"
    | "foreground"
    | "all"
    | "root"
    | "json"
    | "fix"
    | "follow"
    | "lines";

export interface CliFlags {
    command: CliCommand;
    projectAction?: ProjectAction;
    target?: string;
    local: boolean;
    noTunnel: boolean;
    tunnelLogs: boolean;
    foreground: boolean;
    all: boolean;
    json: boolean;
    fix: boolean;
    follow: boolean;
    lines: number;
    root?: string;
}

const DEFAULT_LOG_LINES = 100;

const ALLOWED_FLAGS: Record<string, ReadonlySet<FlagName>> = {
    serve: new Set(["local", "noTunnel", "tunnelLogs", "foreground", "root"]),
    daemon: new Set(["local", "noTunnel", "tunnelLogs"]),
    status: new Set(["json"]),
    doctor: new Set(["fix"]),
    stop: new Set(),
    restart: new Set(),
    logs: new Set(["follow", "lines"]),
    setup: new Set(),
    tunnel: new Set(),
    auth: new Set(),
    update: new Set(),
    version: new Set(),
    help: new Set(),
    exit: new Set(["all", "root"]),
    "project:list": new Set(),
    "project:add": new Set(["local", "noTunnel", "tunnelLogs"]),
    "project:remove": new Set(),
    "project:info": new Set(),
};

const FLAG_LABELS: Record<FlagName, string> = {
    local: "--local",
    noTunnel: "--no-tunnel",
    tunnelLogs: "--tunnel-logs",
    foreground: "--foreground",
    all: "--all",
    root: "--root",
    json: "--json",
    fix: "--fix",
    follow: "--follow",
    lines: "--lines",
};

/** Parse CLI argv while validating each option against the selected command. */
export function parseCliArgs(argv: string[]): CliFlags {
    const positionals: string[] = [];
    const seen = new Set<FlagName>();
    let local = false;
    let noTunnel = false;
    let tunnelLogs = false;
    let foreground = false;
    let all = false;
    let json = false;
    let fix = false;
    let follow = false;
    let lines = DEFAULT_LOG_LINES;
    let root: string | undefined;
    let requestedHelp = false;
    let requestedVersion = false;
    let shortF = false;

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index]!;
        if (arg === "--help" || arg === "-h") {
            requestedHelp = true;
            continue;
        }
        if (arg === "--version" || arg === "-v") {
            requestedVersion = true;
            continue;
        }
        if (arg === "--local") {
            local = true;
            seen.add("local");
            continue;
        }
        if (arg === "--no-tunnel") {
            noTunnel = true;
            seen.add("noTunnel");
            continue;
        }
        if (arg === "--tunnel-logs") {
            tunnelLogs = true;
            seen.add("tunnelLogs");
            continue;
        }
        if (arg === "--foreground") {
            foreground = true;
            seen.add("foreground");
            continue;
        }
        if (arg === "--all" || arg === "-a") {
            all = true;
            seen.add("all");
            continue;
        }
        if (arg === "--json") {
            json = true;
            seen.add("json");
            continue;
        }
        if (arg === "--fix") {
            fix = true;
            seen.add("fix");
            continue;
        }
        if (arg === "--follow") {
            follow = true;
            seen.add("follow");
            continue;
        }
        if (arg === "--lines") {
            const value = argv[index + 1];
            if (!value || value.startsWith("-")) {
                throw new Error("`--lines` 后面需要填写 1 到 5000 的行数");
            }
            const parsed = Number.parseInt(value, 10);
            if (!Number.isInteger(parsed) || String(parsed) !== value || parsed < 1 || parsed > 5000) {
                throw new Error("`--lines` 必须是 1 到 5000 之间的整数");
            }
            lines = parsed;
            seen.add("lines");
            index += 1;
            continue;
        }
        if (arg === "--root") {
            const value = argv[index + 1];
            if (!value || value.startsWith("-")) {
                throw new Error("`--root` 后面需要填写项目目录");
            }
            root = value;
            seen.add("root");
            index += 1;
            continue;
        }
        if (arg === "-f") {
            // `-f` is intentionally contextual: foreground for serve, follow for logs.
            shortF = true;
            continue;
        }
        if (arg.startsWith("-")) {
            throw new Error(`不认识这个选项：${arg}`);
        }
        positionals.push(arg);
    }

    const commandToken = positionals[0];
    const command = resolveCommand(commandToken);
    const remaining = positionals.slice(commandToken ? 1 : 0);

    let projectAction: ProjectAction | undefined;
    let target: string | undefined;
    if (command === "project") {
        const actionToken = remaining[0] ?? "list";
        if (!isProjectAction(actionToken)) {
            throw new Error(`不认识这个 project 子命令：${actionToken}。可用：list、add、remove、info`);
        }
        projectAction = actionToken;
        target = remaining[1];
        if (remaining.length > 2) {
            throw new Error(`这里不需要这些内容：${remaining.slice(2).join(" ")}`);
        }
    } else if (remaining.length > 0) {
        throw new Error(`这里不需要这些内容：${remaining.join(" ")}`);
    }

    if (requestedHelp) {
        if (argv.length !== 1) {
            throw new Error("`--help` 不能和其他命令或选项一起使用；运行 `codex-mcp help`");
        }
        return defaults("help");
    }
    if (requestedVersion) {
        if (argv.length !== 1) {
            throw new Error("`--version` 不能和其他命令或选项一起使用");
        }
        return defaults("version");
    }

    if (shortF) {
        if (command === "logs") {
            follow = true;
            seen.add("follow");
        } else if (command === "serve") {
            foreground = true;
            seen.add("foreground");
        } else {
            throw new Error("`-f` 只适用于 `serve`（foreground）或 `logs`（follow）");
        }
    }

    const key = command === "project" ? `project:${projectAction}` : command;
    const allowed = ALLOWED_FLAGS[key];
    if (!allowed) throw new Error(`内部错误：没有定义命令 ${key} 的选项范围`);
    for (const flag of seen) {
        if (!allowed.has(flag)) {
            throw new Error(`${FLAG_LABELS[flag]} 不适用于 \`${displayCommand(command, projectAction)}\``);
        }
    }

    return {
        command,
        ...(projectAction ? { projectAction } : {}),
        ...(target ? { target } : {}),
        local,
        noTunnel,
        tunnelLogs,
        foreground,
        all,
        json,
        fix,
        follow,
        lines,
        ...(root ? { root } : {}),
    };
}

function resolveCommand(token: string | undefined): CliCommand {
    if (token === undefined || token === "serve") return "serve";
    if (
        token === "setup" ||
        token === "doctor" ||
        token === "tunnel" ||
        token === "auth" ||
        token === "update" ||
        token === "version" ||
        token === "help" ||
        token === "status" ||
        token === "stop" ||
        token === "restart" ||
        token === "logs" ||
        token === "project" ||
        token === "exit" ||
        token === "daemon"
    ) {
        return token;
    }
    throw new Error(`不认识这个命令：${token}。运行 codex-mcp help 查看帮助`);
}

function isProjectAction(value: string): value is ProjectAction {
    return value === "list" || value === "add" || value === "remove" || value === "info";
}

function displayCommand(command: CliCommand, action?: ProjectAction): string {
    return action ? `codex-mcp ${command} ${action}` : `codex-mcp ${command}`;
}

function defaults(command: CliCommand): CliFlags {
    return {
        command,
        local: false,
        noTunnel: false,
        tunnelLogs: false,
        foreground: false,
        all: false,
        json: false,
        fix: false,
        follow: false,
        lines: DEFAULT_LOG_LINES,
    };
}

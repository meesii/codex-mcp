import {
    generateAdminPassword,
    hasAdminPassword,
} from "../auth/password-store.js";
import { setConnectionPassword } from "../control/services.js";
import {
    configureCapabilitySources,
    describeCapabilitiesConfig,
} from "../capabilities/setup.js";
import { loadUserConfig } from "../config/user-config.js";
import {
    printInfo,
    printIntro,
    printNote,
    printOutro,
    printSuccess,
    printSummary,
    printWarning,
} from "../lib/util/terminal.js";
import {
    checkPublicAccess,
    configurePublicAccess,
} from "../tunnel/public-access-manager.js";
import { askSecret, askSelect, canPromptInteractively, withSpinner } from "../tunnel/prompt.js";
import {
    isPublicSetupConfigured,
    type AppliedTunnelSetup,
    type TunnelSetupResult,
} from "../tunnel/setup.js";

/** Run first-time setup or manage an already configured installation. */
export async function runFirstTimeSetup(): Promise<void> {
    if (!canPromptInteractively()) {
        throw new Error("首次设置需要在可以输入内容的终端里运行");
    }

    const current = loadUserConfig();
    const passwordConfigured = await hasAdminPassword();
    if (isPublicSetupConfigured(current)) {
        await runSetupManager(current, passwordConfigured);
        return;
    }

    printIntro("设置 codex-mcp");
    printInfo("先完成并验证公网连接，再生成 ChatGPT 连接密码；外部能力属于可选增强项。");

    const { result, verification } = await configurePublicAccess({ forceWizard: false });
    const generatedPassword = await ensureGeneratedAdminPassword({ display: false });
    try {
        await configureCapabilitySources();
    } catch (error) {
        printWarning(`核心连接已经设置完成；外部能力保持原设置：${readableError(error)}`);
    }
    printCompletedSetup(result, verification, generatedPassword);
}

async function runSetupManager(
    current: ReturnType<typeof loadUserConfig>,
    passwordConfigured: boolean,
): Promise<void> {
    const access = current.publicAccess;
    if (!access) throw new Error("还没有设置公网连接");
    printIntro("codex-mcp setup");
    printSummary("当前配置", [
        { label: "公网地址", value: `https://${access.domain}/mcp` },
        {
            label: "公网方式",
            value: access.kind === "external" ? "自定义 HTTPS" : "Cloudflare Tunnel",
        },
        ...(access.kind === "cloudflare" ? [{ label: "Tunnel", value: access.tunnelName }] : []),
        { label: "连接密码", value: passwordConfigured ? "已设置" : "未设置" },
        { label: "外部能力", value: describeCapabilitiesConfig(current.capabilities) },
    ]);

    const action = await askSelect(
        "请选择要执行的操作",
        [
            { value: "check", label: "检查当前配置", hint: "验证公网地址是否确实到达这台电脑" },
            { value: "public", label: "修改公网连接", hint: "重新选择域名或 Cloudflare 配置" },
            ...(access.kind === "external"
                ? []
                : [
                      {
                          value: "cloudflare",
                          label: "重新登录 / 切换 Cloudflare 账号",
                          hint: "只重置 codex-mcp 私有登录，不修改系统 ~/.cloudflared",
                      },
                  ]),
            {
                value: "password",
                label: passwordConfigured ? "修改连接密码" : "生成连接密码",
                hint: passwordConfigured ? undefined : "补齐 ChatGPT 连接所需的密码",
            },
            { value: "capabilities", label: "管理外部能力", hint: "Codex / Claude Code / Agent Skills" },
            { value: "exit", label: "退出，不做修改" },
        ],
        passwordConfigured ? "check" : "password",
    );

    if (action === "exit") {
        printOutro("未修改配置");
        return;
    }
    if (action === "password") {
        if (passwordConfigured) {
            await configureAdminPassword();
        } else {
            await ensureGeneratedAdminPassword();
        }
        return;
    }
    if (action === "capabilities") {
        const result = await configureCapabilitySources();
        printOutro(result.changed ? "外部能力设置已保存" : "外部能力设置保持不变");
        return;
    }

    if (action === "check") {
        const verification = await withSpinner(
            "正在只读检查当前公网连接…",
            "公网连接检查成功",
            () => checkPublicAccess(),
        );
        printSummary("检查完成", [
            { label: "公网地址", value: verification.publicMcpUrl },
            { label: "状态", value: "已确认到达当前 codex-mcp 实例" },
        ]);
        printOutro("未修改配置");
        return;
    }

    const { result, verification } = await configurePublicAccess({
        forceWizard: true,
        forceCloudflareLogin: action === "cloudflare",
    });
    printCompletedSetup(result, verification);
}

function printCompletedSetup(
    result: TunnelSetupResult,
    verification: AppliedTunnelSetup["verification"],
    generatedPassword?: string,
): void {
    const tunnelBits = [verification.tunnel?.protocol, verification.tunnel?.location].filter(
        (value): value is string => Boolean(value),
    );
    const rows = [
        { label: "公网地址", value: verification.publicMcpUrl },
        {
            label: "公网连接",
            value: tunnelBits.length > 0 ? `已验证 · ${tunnelBits.join(" · ")}` : "已验证",
        },
    ];
    if (result.publicAccess.kind === "cloudflare") {
        rows.push({ label: "Tunnel", value: result.publicAccess.tunnelName });
    }
    rows.push({
        label: "连接密码",
        value: generatedPassword ?? "已设置（保持不变）",
    });

    printSummary("Setup 完成", rows);
    if (generatedPassword) {
        printWarning("请保存上面的连接密码；电脑只保存密码哈希，忘记后需要重新设置。");
    }
    printInfo("下一步：进入你的项目目录，运行 codex-mcp start。");
    printOutro("设置完成");
}

/** Configure or replace the public access password manually. */
export async function configureAdminPassword(): Promise<void> {
    if (!canPromptInteractively()) {
        throw new Error("修改连接密码需要在可以输入内容的终端里运行");
    }
    printIntro("修改连接密码");
    printInfo("修改连接密码。");
    printWarning("密码要求：至少 12 个字符。");
    const password = await askSecret("新密码");
    const confirmation = await askSecret("再输入一次");
    if (password !== confirmation) {
        throw new Error("两次输入的密码不一样，请重新设置");
    }
    await saveAndVerifyAdminPassword(password);
    printOutro("连接密码已修改");
}

/** Ensure first-time public access has a generated password without overwriting an existing one. */
async function ensureGeneratedAdminPassword(
    options: { display?: boolean } = {},
): Promise<string | undefined> {
    if (await hasAdminPassword()) {
        if (options.display !== false) {
            printSuccess("连接密码已经存在，保持不变。");
            printInfo("需要修改时运行：codex-mcp auth");
        }
        return undefined;
    }

    const password = generateAdminPassword();
    await saveAndVerifyAdminPassword(password);
    if (options.display !== false) {
        printSuccess("连接密码已自动生成。");
        printWarning("请保存下面的密码，连接 ChatGPT 时需要输入：");
        printNote("连接密码", password);
        printInfo("电脑不会保存密码明文；忘记后可运行 `codex-mcp auth` 设置新密码。");
    }
    return password;
}

async function saveAndVerifyAdminPassword(password: string): Promise<void> {
    try {
        await setConnectionPassword(password);
    } catch (error) {
        throw new Error(`连接密码保存后校验失败，请重新运行 \`codex-mcp setup\`：${readableError(error)}`);
    }
}

export async function ensureAdminPasswordConfigured(): Promise<void> {
    if (await hasAdminPassword()) return;
    if (!canPromptInteractively()) {
        throw new Error("还没有连接密码，请先运行 `codex-mcp setup`");
    }
    printWarning("第一次使用需要生成连接密码。");
    await ensureGeneratedAdminPassword();
}

function readableError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

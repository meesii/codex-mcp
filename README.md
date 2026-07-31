# codex-mcp

精简的本机 Coding [MCP](https://modelcontextprotocol.io) 服务：通过 **Streamable HTTP** 把本地项目目录暴露给 ChatGPT（Developer Mode），无需 OAuth / 密码页。

适合个人开发：在 ChatGPT 里直接读改代码、跑命令、搜文件——工作区始终落在你指定的那一个项目目录里。

## 功能

- **单项目绑定**：启动时用 `CODING_MCP_PROJECT_ROOT` 锁定一个目录；MCP `initialize` 的 `instructions` 会把路径与工作流告知模型（OpenAI：前 512 字符应自洽）
- **文件与搜索**：`read` / `write` / `edit`，以及 `grep` / `glob` / `ls`
- **命令执行**：短命令用 `bash`；长任务用 `exec_command` + `write_stdin` / `process_kill`（Codex 风格进程会话）
- **网页拉取**：`webfetch`（http/https → text / markdown / html）
- **MCP Apps 摘要卡片**：工具结果挂 `ui://codex-mcp/tool-card.html`，只展示状态 / 路径 / 计数 / 最多 120 字预览，**不渲染完整文件或命令输出**，避免 ChatGPT Web 卡死；完整数据仍在 `structuredContent` 供模型使用

| 工具                      | 说明                                             |
| ------------------------- | ------------------------------------------------ |
| `read` / `write` / `edit` | 读写与精确替换（路径相对 project root）          |
| `bash`                    | 短命令前台执行（Windows: `pwsh`，Unix: `bash`）  |
| `exec_command`            | 长时间命令可返回 `processId`（如 `npm run dev`） |
| `write_stdin`             | 向 `processId` 写 stdin / 轮询增量输出           |
| `process_kill`            | 按 `processId` 结束后台进程                      |
| `grep` / `glob` / `ls`    | 搜索与列目录                                     |
| `webfetch`                | 拉取 http(s) 页面                                |

返回格式遵循 [OpenAI MCP server 文档](https://developers.openai.com/plugins/build/mcp-server)：`content` 为短摘要，`structuredContent` 为结构化数据（并声明 `outputSchema`）。

## 要求

- Node.js `>= 22`
- 建议安装 [ripgrep](https://github.com/BurntSushi/ripgrep)（`grep` 更快；未安装时自动 Node 回退）

## 安装与启动

```bash
git clone https://github.com/meesii/codex-mcp.git
cd codex-mcp
npm install
```

复制环境变量模板并填写项目路径：

```bash
cp .env.example .env
```

**Windows (PowerShell)：**

```powershell
$env:CODING_MCP_PROJECT_ROOT = "D:\path\to\project"
npm run dev
```

**macOS / Linux：**

```bash
export CODING_MCP_PROJECT_ROOT="/path/to/project"
npm run dev
```

默认监听：`http://127.0.0.1:3920/mcp`

生产构建：

```bash
npm run build
npm start
```

## 环境变量

完整示例见 [`.env.example`](.env.example)。

| 变量                       | 默认        | 说明                                                                                                |
| -------------------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| `CODING_MCP_PROJECT_ROOT`  | （必填）    | 暴露给 MCP 的单一项目绝对路径                                                                       |
| `CODING_MCP_HOST`          | `127.0.0.1` | 监听地址                                                                                            |
| `CODING_MCP_PORT`          | `3920`      | 监听端口                                                                                            |
| `CODING_MCP_ALLOWED_HOSTS` | （空）      | 允许的 `Host` 主机名，分号分隔；走 Cloudflare Tunnel / ngrok 等反向代理时必填                       |
| `CODING_MCP_WIDGET_DOMAIN` | 见下方      | ChatGPT 小部件唯一域；未设且配置了 `ALLOWED_HOSTS` 时默认为 `https://codex-mcp.<首个 ALLOWED_HOST>` |
| `CODING_MCP_LOG_TOOLS`     | 开启        | 每次工具调用打一行摘要；设为 `0` / `false` 关闭。**不会**打印完整文件或命令输出                     |

兼容：若仍设置旧变量 `CODING_MCP_ALLOWED_ROOTS` 且只含一个路径，会当作 `CODING_MCP_PROJECT_ROOT` 使用。

### 隧道示例

```powershell
$env:CODING_MCP_PROJECT_ROOT = "D:\path\to\project"
$env:CODING_MCP_ALLOWED_HOSTS = "mcp.example.com"
npm run dev
```

不设置 `CODING_MCP_ALLOWED_HOSTS` 时，SDK 只允许 `localhost` / `127.0.0.1`，公网域名会返回 `Invalid Host`。

## 接入 ChatGPT

1. 用隧道把本机 HTTPS 暴露出去（Cloudflare Tunnel / ngrok 等），路径指向 `/mcp`
2. ChatGPT → Settings → Apps / Developer Mode → 添加 MCP server URL：`https://your-host/mcp`
3. 无需 Owner 密码；工具声明为 `noauth`
4. 连接后会走 MCP `initialize`，读取服务端 `instructions`（含 project root）与 `tools/list`。改工具后请刷新 connector 或开新对话

本地调试也可用 [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) 连接 `http://127.0.0.1:3920/mcp`。

## 安全

> **无认证。** 知道 URL 的人即可读写你的 `PROJECT_ROOT`、执行命令。
>
> 仅用于个人受控隧道；不要把端口直接暴露到公网。

路径访问限制在 `CODING_MCP_PROJECT_ROOT` 内；写操作带进程内锁。这不能替代网络层访问控制。

## 开发

```bash
npm run typecheck
npm test
npm run build
```

`npm test` 会在进程内启动 MCP HTTP 服务，用官方 SDK 的 **MCP Client + StreamableHTTPClientTransport** 对全部工具做端到端校验。

## 架构

```
cli → http-server (Streamable HTTP /mcp)
         → mcp-server (instructions = project root + workflow)
         → tools/* + ProjectContext (path guard + write lock)
```

## License

[MIT](LICENSE)

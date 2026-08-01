# codex-mcp

精简的本机 Coding [MCP](https://modelcontextprotocol.io) 服务：通过 **Streamable HTTP** 把本地项目目录暴露给 ChatGPT（Developer Mode），无需 OAuth / 密码页。

适合个人开发：在终端运行 `codex-mcp`，选择项目目录后即可在 ChatGPT 里读改代码、跑命令、搜文件。可选集成 Cloudflare Tunnel，一条命令同时起本机服务与公网入口。

## 功能

- **单项目绑定**：启动前选择 project root（回车 = 当前目录）
- **Cloudflare Tunnel（可选）**：首次交互配置域名与 `cloudflared`；之后自动 `tunnel run`（日志写入 `~/.codex-mcp/logs/`，默认不刷屏）
- **文件与搜索**：`read` / `write` / `edit`，以及 `grep` / `glob` / `ls`
- **命令执行**：短命令用 `bash`；长任务用 `exec_command` + `write_stdin` / `process_kill`（Codex 风格进程会话）
- **网页拉取**：`webfetch`（http/https → text / markdown / html）
- **下游 MCP 网关（可选）**：在 `~/.codex-mcp/mcp.json` 配置其它 MCP；instructions 只平铺各 server 简介，具体工具通过 `mcp_tools` / `mcp_call` 按需列出与调用
- **MCP Apps 摘要卡片**：工具结果挂 `ui://codex-mcp/tool-card.html`，只展示状态 / 路径 / 计数 / 最多 120 字预览，**不渲染完整文件或命令输出**

| 工具                      | 说明                                             |
| ------------------------- | ------------------------------------------------ |
| `read` / `write` / `edit` | 读写与精确替换（路径相对 project root）          |
| `bash`                    | 短命令前台执行（Windows: `pwsh`，Unix: `bash`）  |
| `exec_command`            | 长时间命令可返回 `processId`（如 `npm run dev`） |
| `write_stdin`             | 向 `processId` 写 stdin / 轮询增量输出           |
| `process_kill`            | 按 `processId` 结束后台进程                      |
| `grep` / `glob` / `ls`    | 搜索与列目录                                     |
| `webfetch`                | 拉取 http(s) 页面                                |
| `mcp_tools`               | 列出某个下游 MCP 的 tools（含描述 / schema）     |
| `mcp_call`                | 调用某个下游 MCP 的某个 tool                     |

返回格式遵循 [OpenAI MCP server 文档](https://developers.openai.com/plugins/build/mcp-server)：`content` 为短摘要，`structuredContent` 为结构化数据（并声明 `outputSchema`）。

## 要求

- Node.js `>= 22`
- 使用隧道时需要 [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/)（Windows 可放到仓库 `bin/cloudflared.exe`，该路径已在 `.gitignore`）
- 建议安装 [ripgrep](https://github.com/BurntSushi/ripgrep)（`grep` 更快；未安装时自动 Node 回退）

## 安装（本机全局命令）

本项目不发布到 npm。在仓库内构建后把 `codex-mcp` 放到 PATH：

**Windows (PowerShell)：**

```powershell
cd D:\path\to\codex-mcp
npm install
pwsh -File scripts\install.ps1
# 新开一个终端后：
codex-mcp --help
```

**macOS / Linux：**

```bash
cd /path/to/codex-mcp
npm install
npm run build
npm link
```

## 日常使用

```powershell
cd D:\work\my-app
codex-mcp
```

未配置时会进入向导；已配置后启动时确认 project root 即可（回车使用当前目录）。

在 ChatGPT 中添加 MCP URL：`https://<你的域名>/mcp`

### 常用命令

| 命令 | 说明 |
| --- | --- |
| `codex-mcp` | 默认 serve（交互选 root；按配置决定是否起隧道） |
| `codex-mcp tunnel` | 重新跑域名 / cloudflared 配置向导 |
| `codex-mcp --no-tunnel` | 不起 cloudflared（仍可用已配置的域名做 Host 校验） |

仓库内开发：

```powershell
npm run dev          # tsx src/cli.ts（可交互；首次配置请用这个）
npm run dev:watch    # tsx watch（会干扰 stdin，勿用于首次向导）
npm start            # node dist/cli.js（需先 npm run build）
```

本地调试可用 [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) 连接 `http://127.0.0.1:3920/mcp`。

## 用户配置

机器级配置：`~/.codex-mcp/config.json`（Windows：`%USERPROFILE%\.codex-mcp\config.json`）。

```json
{
    "host": "127.0.0.1",
    "port": 3920,
    "domain": "mcp.example.com",
    "useCloudflared": true,
    "cloudflaredBin": "D:\\path\\to\\codex-mcp\\bin\\cloudflared.exe",
    "tunnelName": "codex-mcp",
    "tunnelId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

| 字段 | 说明 |
| --- | --- |
| `domain` | 公网 Host（可由向导写入） |
| `useCloudflared` | `true` 时 serve 自动拉起 tunnel；`false` 则只起本机 HTTP |
| `cloudflaredBin` | cloudflared 可执行文件路径。Windows 常不在 PATH，建议填写；macOS/Linux 可省略走 PATH |
| `tunnelName` / `tunnelId` | 由向导写入；用于 `cloudflared tunnel run` |
| `host` / `port` | 本机监听地址（默认 `127.0.0.1:3920`） |

相关文件：

- 隧道日志：`~/.codex-mcp/logs/tunnel.log`
- cloudflared 配置：`~/.cloudflared/config.yml`（向导生成/更新；ingress 指向本机 `host:port`）
- 下游 MCP：`~/.codex-mcp/mcp.json`（可选；见下）

DNS 路由：向导会先尝试创建记录；若域名已存在但未指向当前 tunnel，会自动 `--overwrite-dns`，避免重建 tunnel 后出现公网 502/530。

### 下游 MCP（`mcp.json`）

可选。不写此文件时行为与原来一致。写法对齐常见 MCP 客户端：

```json
{
    "mcpServers": {
        "github": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-github"],
            "env": {
                "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx"
            }
        },
        "remote-demo": {
            "url": "https://example.com/mcp",
            "headers": {
                "Authorization": "Bearer xxx"
            }
        }
    }
}
```

| 字段 | 说明 |
| --- | --- |
| `command` / `args` / `env` / `cwd` | stdio 启动（与 Cursor 类似） |
| `url` / `headers` | Streamable HTTP 远程 MCP（与 `command` 二选一） |
| `disabled` | `true` 时跳过该条目 |

启动时会对每个下游 MCP 做 `initialize`，用其 `instructions`（首行）或 server `title`/`name` 作为顶层简介写入 ChatGPT `instructions`——**不必**在 `mcp.json` 里手写 description。

ChatGPT 侧**不会**看到下游每个 tool；只会看到 server 名 + 上述简介。按需 `mcp_tools`（同一对话可复用）再 `mcp_call`。改 `mcp.json` 后重启 `codex-mcp`，并刷新 ChatGPT connector。

## 接入 ChatGPT

1. 跑通 `codex-mcp`（含隧道）后，复制 banner 上的 `https://<domain>/mcp`
2. ChatGPT → Settings → Apps / Developer Mode → 添加 MCP server URL
3. 无需 Owner 密码；工具声明为 `noauth`
4. 连接后走 MCP `initialize`，读取 `instructions`（含 project root）与 `tools/list`。改工具后请刷新 connector 或开新对话

## 安全

> **无认证。** 知道 URL 的人即可读写你的 project root、执行命令。
>
> 仅用于个人受控隧道；不要把端口直接暴露到公网。

路径访问限制在绑定的 project root 内；写操作带进程内锁。这不能替代网络层访问控制。

## 开发

```bash
npm run typecheck
npm test
npm run build
```

`npm test` 在进程内启动 MCP HTTP 服务，用官方 SDK 的 **MCP Client + StreamableHTTPClientTransport** 做端到端校验。

## 架构

```
cli → (tunnel wizard / cloudflared sidecar)
    → DownstreamMcpHub (optional ~/.codex-mcp/mcp.json)
    → http-server (Streamable HTTP /mcp)
         → mcp-server (instructions = project root + workflow + MCP blurbs)
         → tools/* + ProjectContext (path guard + write lock)
         → mcp_tools / mcp_call → DownstreamMcpHub
```

## License

[MIT](LICENSE)

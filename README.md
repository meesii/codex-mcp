# codex-mcp

让 ChatGPT 帮你写代码的本地工具。运行后，ChatGPT 可以直接在你的电脑上读文件、改代码、执行命令。

---

## 你需要准备

| 项目 | 说明 |
|------|------|
| Node.js 22+ | 运行环境 |
| 域名 + Cloudflare 账号 | 可选，用于公网访问 |
| Git | 可选，用于代码版本管理 |
| Codex CLI | 可选，用于增强代码探索 |

---

## 快速开始

### 第一步：安装

**macOS / Linux**

```bash
curl -fsSL https://github.com/meesii/codex-mcp/releases/latest/download/install.sh | sh
```

**Windows PowerShell**

```powershell
irm https://github.com/meesii/codex-mcp/releases/latest/download/install.ps1 | iex
```

安装后如果命令找不到，重新打开一个终端窗口。

### 第二步：首次设置

```bash
codex-mcp setup
```

按提示完成：

1. **登录 Cloudflare** — 已登录时会直接复用现有凭据
2. **自动检测域名** — 从 Cloudflare 账号读取可用域名；有多个时用交互菜单选择根域名，再填写子域名前缀（默认 `codex-mcp`）
3. **创建 Tunnel 和 DNS** — Tunnel 名称按当前机器自动生成，不再要求普通用户填写
4. **真实公网验证** — 临时启动本机探针和 Tunnel，确认 HTTPS 地址确实回到当前电脑
5. **检测外部能力** — 自动检测 Codex、Claude Code 和 Agent Skills，可直接使用检测到的全部能力，也可以分别选择 MCP / Skills，并选择自动同步或仅启动时读取
6. **保存连接密码** — 只有公网验证成功后才生成并显示，用于 ChatGPT 连接验证

再次运行 `codex-mcp setup` 时，如果配置已经完整，会先显示当前配置，并提供“检查当前配置 / 修改公网连接 / 修改连接密码 / 管理外部能力”等操作，不会直接重走首次向导。

Cloudflare 的 Named Tunnel 会生成 `<UUID>.cfargotunnel.com` 作为 DNS 的 CNAME 目标，但它不是可直接给 ChatGPT 使用的公网地址；自动 Tunnel 模式仍需要账号中至少有一个已接入 Cloudflare 的域名。

检查配置是否正确：

```bash
codex-mcp doctor
```

### 第三步：启动

进入你的项目目录，然后启动：

```bash
cd /path/to/your-project
codex-mcp
```

codex-mcp 不会再询问项目目录，默认直接使用当前目录。需要从其他位置启动时，可以运行 `codex-mcp --root <目录>`。

终端摘要会显示 **连接地址**、**项目目录**、公网连接和日志目录。

### 第四步：连接 ChatGPT

1. ChatGPT → Settings → Apps → Developer Mode → 添加 MCP server
2. 填入 setup 最后显示的连接地址
3. 浏览器会打开验证页面，输入 setup 最后显示并保存的连接密码
4. 授权完成，ChatGPT 现在可以操作你的项目了

连接后可以直接说“继续这个项目”“看看现在改了什么”或“先了解这个工程”。codex-mcp 会通过 `workspace_context` 一次整理 Git 状态、近期提交、Goal、进程、项目规则、Skills 和相关代码，再按需读取细节。

### 外部能力来源

codex-mcp 可以直接读取本机已有的 AI 开发环境能力，不会把第三方 MCP 配置、Token 或 Skill 文件复制到 `~/.codex-mcp`：

- **Codex** — MCP + `~/.codex/skills`
- **Claude Code** — user / local / project MCP，以及 `~/.claude/skills` 和已注册工作区根目录下的 `.claude/skills`
- **Agent Skills** — `~/.agents/skills`

首次 `setup` 会自动检测这些来源。旧版本升级且尚未保存 `capabilities` 配置时保持兼容默认：继续使用 Codex MCP、Codex Skills 和 Agent Skills；Claude Code 只有在 setup 中选择或手动配置后才启用。

同步模式只有两个：`watch`（默认，源配置变化后热刷新）和 `startup`（每次启动读取一次，运行期间不监听）。`capabilities_reload` 始终可以显式刷新，不受同步模式限制。

Claude Code 的项目能力不会无条件变成全局能力：主工作区的 local/project MCP 按 Claude 的作用域优先级覆盖 user MCP；额外工作区的 local/project MCP 会带工作区限定名称。Claude Skill 中明确禁止模型调用的 `disable-model-invocation: true` 不会暴露给 ChatGPT；依赖 Claude 专有执行语义（例如 fork/agent、`allowed-tools` 约束、hooks 或 `!`command`` 动态上下文）的 Skill 也不会伪装成普通可自动调用 Skill。

示例配置：

```json
{
  "capabilities": {
    "sync": "watch",
    "priority": ["agents", "codex", "claude"],
    "sources": {
      "agents": { "enabled": true, "mcp": false, "skills": true },
      "codex": { "enabled": true, "mcp": true, "skills": true },
      "claude": { "enabled": true, "mcp": true, "skills": true }
    }
  }
}
```

同名能力按 `priority` 从前到后决定优先级；`~/.codex-mcp/mcp.json` 仍然是最终的本地覆盖层。

### 多工作区与外部文件授权

启动目录（或 `--root` 指定的目录）仍然是 **主工作区**，相对路径、默认命令目录和默认项目上下文都以它为准。需要同时操作其他目录时，可以直接让 ChatGPT“把 `/path/to/another-project` 添加为工作区”；`workspace_add` 会把它作为长期可信的读写/执行工作区并保存到 `~/.codex-mcp/config.json`，`workspace_remove` 可以移除额外工作区，主工作区不会在运行中被移除。

没有加入工作区的绝对路径也可以直接读取，`read`、`grep`、`glob`、`ls` 等读取操作不会因为工作区边界额外打断你。对工作区外的写入或把命令 `cwd` 切到工作区外时，codex-mcp 才会请求授权：

- **当前会话授权**：默认选项。在当前 MCP 会话/授权连接范围内保留该目录和能力的授权，避免连续改同一目录时反复确认。
- **单次授权**：只允许下一次匹配的操作，用完即失效；适合你明确只想放行一次的操作。
- **永久授权**：保存到 `~/.codex-mcp/config.json`，以后启动仍然有效。

授权按 **目录 + 能力** 区分，目前能力分为工作区外 `write` 和外部命令目录 `exec`。支持 MCP elicitation 的客户端可以在原操作中直接确认；其他客户端会先收到需要授权的结果，再通过 `permission_grant` 完成用户确认，然后重试原操作。日常个人开发默认使用当前会话授权；只有你明确只放行一次时才使用单次授权，明确要求长期允许时才使用永久授权。经常反复使用的项目目录更适合直接通过 `workspace_add` 加入可信工作区。可以用 `permission_list` 查看当前授权，用 `permission_revoke` 撤销指定目录和能力的授权。

也可以手动在配置里登记额外工作区，例如：

```json
{
  "workspaces": [
    "/path/to/project-a",
    "/path/to/project-b"
  ]
}
```

> `bash` / `exec_command` 的授权边界是命令的工作目录，不是完整的系统沙箱。已经允许执行的 shell 命令仍然拥有当前系统用户本身的文件访问能力；这是为了避免把正常开发命令限制得过于难用。

---

## 终端与文件日志

终端显示适合直接阅读的状态和工具日志；结构化运行日志以 JSON Lines 写入：

```text
~/.codex-mcp/logs/codex-mcp.YYYY-MM-DD.N.jsonl
```

日志每天或达到 10 MiB 时轮转，保留最近 7 个文件。工具事件只记录工具名、耗时和成功状态，不记录原始参数、命令、文件内容、返回值或 OAuth 凭据。

关闭工具与 MCP 事件日志：

```bash
CODING_MCP_LOG_TOOLS=0 codex-mcp
```

Tunnel 原始日志单独保存在 `~/.codex-mcp/logs/tunnel.log`。

---

## 常用命令

| 命令 | 作用 |
|------|------|
| `codex-mcp` | 启动当前项目 |
| `codex-mcp setup` | 首次设置 / 管理公网连接 |
| `codex-mcp doctor` | 检查配置状态 |
| `codex-mcp auth` | 修改连接密码 |
| `codex-mcp update` | 更新到最新版本 |
| `codex-mcp tunnel` | 重新设置公网连接 |
| `codex-mcp --root <目录>` | 指定项目目录 |
| `codex-mcp --local` | 仅本机调试，不开放公网 |
| `codex-mcp --no-tunnel` | 启动时不自动运行 Tunnel |
| `codex-mcp --tunnel-logs` | 在终端显示 Tunnel 原始日志 |

---

## 更新

```bash
codex-mcp update
```

自动下载最新版本，保留你的配置和密码。如果服务正在运行，请在更新后重启；现有进程不会自动加载新版本。

---

## 卸载

**macOS / Linux**

```bash
curl -fsSL https://github.com/meesii/codex-mcp/releases/latest/download/uninstall.sh | sh
```

**Windows PowerShell**

```powershell
irm https://github.com/meesii/codex-mcp/releases/latest/download/uninstall.ps1 | iex
```

卸载保留配置文件。如需彻底清除，手动删除 `~/.codex-mcp` 目录。

---

## 安全提示

> **不要与他人共享你的 codex-mcp 实例。**
>
> 它拥有你项目的完整读写权限和命令执行能力。每个人都应该在自己的电脑上运行自己的实例。

---

## 遇到问题？

| 问题 | 解决 |
|------|------|
| 命令找不到 | 重新打开终端窗口 |
| 连接失败 | 运行 `codex-mcp doctor` 检查 |
| 忘记密码 | 运行 `codex-mcp auth` 重新设置 |
| 域名无法访问 | 确认 Cloudflare Tunnel 状态正常 |
| 需要排查运行错误 | 查看 `~/.codex-mcp/logs` |

---

## License

[MIT](LICENSE)

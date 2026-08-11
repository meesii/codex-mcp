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

1. **保存密码** — 只显示一次，用于 ChatGPT 连接验证
2. **填写域名** — 例如 `mcp.example.com`
3. **登录 Cloudflare** — 自动创建 Tunnel 和 DNS

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
2. 填入刚才的连接地址
3. 浏览器会打开验证页面，输入第一步保存的密码
4. 授权完成，ChatGPT 现在可以操作你的项目了

连接后可以直接说“继续这个项目”“看看现在改了什么”或“先了解这个工程”。codex-mcp 会通过 `workspace_context` 一次整理 Git 状态、近期提交、Goal、进程、项目规则、Skills 和相关代码，再按需读取细节。

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
| `codex-mcp setup` | 首次设置 |
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

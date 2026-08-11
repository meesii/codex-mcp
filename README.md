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

终端会显示一个 **连接地址**，例如 `https://mcp.example.com/mcp`。

### 第四步：连接 ChatGPT

1. ChatGPT → Settings → Apps → Developer Mode → 添加 MCP server
2. 填入刚才的连接地址
3. 浏览器会打开验证页面，输入第一步保存的密码
4. 授权完成，ChatGPT 现在可以操作你的项目了

---

## 常用命令

| 命令 | 作用 |
|------|------|
| `codex-mcp` | 启动当前项目 |
| `codex-mcp setup` | 首次设置 |
| `codex-mcp doctor` | 检查配置状态 |
| `codex-mcp auth` | 修改连接密码 |
| `codex-mcp update` | 更新到最新版本 |
| `codex-mcp --local` | 仅本机调试，不开放公网 |

---

## 更新

```bash
codex-mcp update
```

自动下载最新版本，保留你的配置和密码。

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

---

## License

[MIT](LICENSE)

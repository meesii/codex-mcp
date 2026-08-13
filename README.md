# codex-mcp

让 ChatGPT 直接操作你电脑上的代码项目。

安装并连接后，你可以在 ChatGPT 里直接说：

- “先看看这个项目是做什么的”
- “检查一下现在有哪些改动”
- “修掉这个报错”
- “跑一下测试”
- “把这个功能实现完”
- “切到另一个项目继续”

codex-mcp 会在你的电脑上读取文件、修改代码、执行命令、查看 Git，并把结果返回给 ChatGPT。

> codex-mcp 面向个人开发环境使用。它拥有很强的本机操作能力，请只连接你自己的 ChatGPT 和你信任的项目。

---

## 它是怎么工作的？

codex-mcp 在你的电脑上运行一个后台服务，并通过 MCP 把本地开发能力提供给 ChatGPT。

```text
ChatGPT
   │
   │ HTTPS / MCP
   ▼
Cloudflare Tunnel 或你自己的 HTTPS 入口
   │
   ▼
codex-mcp 后台服务
   │
   ├── 项目 A
   ├── 项目 B
   └── 项目 C
```

你只需要运行 **一个 codex-mcp 后台服务**。

不同项目不需要分别启动服务器，也不需要分别创建 Cloudflare Tunnel。进入每个项目目录运行一次 `codex-mcp`，它就会把这个项目注册到同一个后台服务里。

每个 ChatGPT 对话只会绑定一个项目。这样你可以在不同对话里分别处理不同项目，也可以明确切换当前对话使用的项目。

---

## 你需要准备什么？

### 必需

- **Node.js 22 或更高版本**

### 推荐

- **Git**：用于查看状态、提交历史和差异

### 如果要从 ChatGPT 连接

你需要一个可以通过 HTTPS 访问到本机 codex-mcp 的公网地址。

最简单的方式是：

- 一个 **Cloudflare 账号**
- 一个已经接入 Cloudflare 的 **域名**

codex-mcp 可以自动创建和管理 Cloudflare Tunnel。

如果你已经有自己的反向代理、服务器或其他 HTTPS 入口，也可以不让 codex-mcp 管理 Cloudflare。

### 可选

如果电脑上已经安装了这些工具，codex-mcp 还可以读取它们已有的能力：

- Codex
- Claude Code
- Agent Skills

没有这些也不影响 codex-mcp 的核心功能。

---

# 快速开始

## 1. 安装

推荐用 npm：

```bash
npm install -g @meesii/codex-mcp
```

也可以用安装脚本：

### macOS / Linux

```bash
curl -fsSL https://github.com/meesii/codex-mcp/releases/latest/download/install.sh | sh
```

### Windows PowerShell

```powershell
irm https://github.com/meesii/codex-mcp/releases/latest/download/install.ps1 | iex
```

安装完成后，如果终端提示找不到 `codex-mcp`，关闭终端并重新打开一次。

检查版本：

```bash
codex-mcp --version
```

---

## 2. 首次设置

运行：

```bash
codex-mcp setup
```

首次设置会带你完成几个步骤。

### 公网连接

默认情况下，codex-mcp 会询问是否自动配置 Cloudflare Tunnel。

选择自动配置后，它会：

1. 准备 `cloudflared`
2. 打开浏览器登录 Cloudflare
3. 读取账号中的域名
4. 让你选择一个域名
5. 创建或复用当前电脑对应的 Tunnel
6. 创建 DNS 记录
7. 临时启动服务并验证公网地址确实能够访问到这台电脑

例如最终得到：

```text
https://codex-mcp.example.com/mcp
```

如果你的 Cloudflare 账号里没有已经接入 Cloudflare 的域名，自动 Tunnel 模式无法完成配置。

> Cloudflare Tunnel 生成的 `<UUID>.cfargotunnel.com` 是 DNS CNAME 目标，不是直接给 ChatGPT 使用的 MCP 地址。

### 使用自己的 HTTPS 入口

如果你不想让 codex-mcp 管理 Cloudflare，可以在 setup 中选择自己提供公网入口，然后填写你的域名。

此时需要你自己保证：

```text
https://你的域名/mcp
```

能够安全地转发到本机 codex-mcp 服务。

### 外部能力

setup 还会检测本机是否存在：

- Codex
- Claude Code
- Agent Skills

你可以选择：

- 使用检测到的全部能力
- 自定义启用哪些 MCP / Skills
- 全部关闭

默认推荐自动同步。这样这些工具的配置发生变化后，codex-mcp 可以自动刷新。

### 连接密码

公网验证完成后，codex-mcp 会生成 ChatGPT 连接密码。

**请保存这个密码。**

电脑上只保存密码哈希，不保存明文密码。忘记以后不能找回，只能重新设置。

重新设置密码：

```bash
codex-mcp auth
```

---

## 3. 启动第一个项目

进入项目目录：

```bash
cd /path/to/your-project
codex-mcp
```

第一次运行时，codex-mcp 会启动后台服务，然后注册当前项目。

以后再次运行同一个项目，只会确认这个项目处于已注册状态，不会再启动一套新的服务器。

你也可以从其他目录指定项目：

```bash
codex-mcp --root /path/to/your-project
```

查看当前状态：

```bash
codex-mcp status
```

你会看到：

- 后台服务是否运行
- 本机 MCP 地址
- 公网 MCP 地址
- Cloudflare Tunnel 是否在线
- 当前版本
- 已注册项目
- 每个项目当前有多少会话绑定

---

## 4. 连接 ChatGPT

ChatGPT 的 MCP App 入口和可用套餐可能会变化，请以你当前账号的 Apps 设置为准。

当前常见流程是：

1. 在 ChatGPT 中启用 **Developer Mode**
2. 打开 **Apps → Create**
3. 填入 codex-mcp 的 MCP 地址
4. 扫描工具（Scan Tools）
5. 按提示完成 OAuth / 密码验证
6. 创建并启用这个 App

MCP 地址就是 setup 最后显示的公网地址，例如：

```text
https://codex-mcp.example.com/mcp
```

授权时使用 `codex-mcp setup` 生成的连接密码。

连接完成后，就可以直接让 ChatGPT 操作本机项目。

> 完整 MCP 写入能力是否可用取决于 ChatGPT 当前的套餐、工作区权限和产品开放状态。如果你的设置里没有 Developer Mode 或创建自定义 MCP App 的入口，请先确认当前 ChatGPT 账号是否支持。

---

# 多项目怎么用？

这是当前版本最重要的使用方式。

## 注册多个项目

假设电脑上有三个项目：

```text
~/code/api
~/code/web
~/code/mobile
```

分别进入目录运行：

```bash
cd ~/code/api
codex-mcp

cd ~/code/web
codex-mcp

cd ~/code/mobile
codex-mcp
```

它们会全部注册到同一个 codex-mcp 后台服务。

不会创建三个端口，也不会创建三个 Tunnel。

查看所有项目：

```bash
codex-mcp status
```

---

## ChatGPT 对话会绑定一个项目

一个 ChatGPT 对话只操作一个项目。

例如你可以说：

> 使用 web 项目，看看首页现在有什么问题。

ChatGPT 会选择对应项目，然后后面的文件读取、代码修改、命令执行和 Git 操作都会以这个项目为上下文。

另一个 ChatGPT 对话可以同时绑定 `api` 项目，互不影响。

如果要在当前对话切换项目，可以直接说：

> 切换到 api 项目。

切换已有绑定时需要明确确认，不会静默跳到另一个项目。

---

## 停止一个项目

进入项目目录运行：

```bash
codex-mcp exit
```

这只会停用当前项目。

后台服务、Cloudflare Tunnel 和其他项目仍然继续运行。

重新启用时，再进入目录运行：

```bash
codex-mcp
```

---

## 停止全部服务

```bash
codex-mcp exit -a
```

这会关闭：

- 所有项目运行时
- codex-mcp 后台服务
- Cloudflare Tunnel

---

# ChatGPT 可以做什么？

连接项目以后，ChatGPT 可以通过 codex-mcp：

### 读取和搜索代码

- 读取单个或多个文件
- 搜索字符串和正则表达式
- 按文件模式查找文件
- 浏览目录
- 查找代码关系

### 修改代码

- 精确修改已有代码
- 应用多文件 patch
- 创建新文件
- 完整覆盖文件

### 执行命令

- 运行构建
- 运行测试
- 安装依赖
- 启动开发服务器
- 管理长时间运行的进程

### Git

- 查看 `git status`
- 查看 diff
- 查看提交历史
- 查看指定 commit
- 查看分支

### 项目上下文

当你说：

> 继续这个项目。

或者：

> 先看看这个项目现在是什么情况。

codex-mcp 可以一次整理：

- Git 状态
- 最近提交
- 当前开发 Goal
- 正在运行的进程
- 项目规则
- Skills
- 相关入口文件
- 需要注意的问题

这样 ChatGPT 不需要每次从零开始理解项目。

---

# 工作区和权限

codex-mcp 的默认原则是：**日常开发尽量少打断，但工作区外的写入和执行需要明确授权。**

## 当前项目

运行：

```bash
cd ~/code/my-project
codex-mcp
```

那么：

```text
~/code/my-project
```

就是这个项目的主工作区。

相对路径默认都从这里开始。

---

## 额外工作区

如果一个项目经常需要同时访问另一个目录，可以直接告诉 ChatGPT：

> 把 `/path/to/shared-library` 添加为工作区。

加入以后，这个目录会作为可信工作区保存，以后可以直接读、写和执行命令。

也可以删除额外工作区。

主项目目录不能在运行中被移除。

---

## 工作区外读取

绝对路径的只读操作通常可以直接进行，例如：

- 读取文件
- 搜索文本
- 查找文件
- 查看目录

不会因为文件不在工作区里就反复要求确认。

---

## 工作区外写入和命令执行

以下操作需要授权：

- 修改工作区外的文件
- 在工作区外目录作为 `cwd` 执行命令

授权分三种：

### 当前会话

日常使用推荐。

只在当前 MCP 会话中有效，关闭后不会永久保留。

### 单次

只允许下一次匹配操作。

适合你明确只想放行一次的情况。

### 永久

保存到本机配置，以后仍然有效。

只建议用于你长期信任的目录。

> 命令执行权限是以命令工作目录为边界，不是完整的操作系统沙箱。一个被允许执行的 shell 命令，仍然拥有当前系统用户本身拥有的系统权限。

---

# 使用 Codex、Claude Code 和 Skills

codex-mcp 可以直接读取已有 AI 开发工具的配置，而不是复制一份。

支持：

| 来源 | MCP | Skills |
|---|---:|---:|
| Codex | ✅ | ✅ |
| Claude Code | ✅ | ✅ |
| Agent Skills | — | ✅ |

常见位置包括：

```text
~/.codex/
~/.claude/
~/.agents/skills/
```

Claude Code 项目内的 `.claude/skills` 也可以按项目读取。

这些能力默认只是**读取和引用原配置**，不会把第三方 Token、MCP 配置和 Skill 文件复制到 `~/.codex-mcp`。

重新管理这些设置：

```bash
codex-mcp setup
```

然后选择：

```text
管理外部能力
```

支持两种同步方式：

- `watch`：配置发生变化后自动刷新，推荐
- `startup`：只在 codex-mcp 启动时读取一次

---

# 常用命令

| 命令 | 作用 |
|---|---|
| `codex-mcp` | 注册 / 启动当前项目，并确保后台服务运行 |
| `codex-mcp status` | 查看后台服务、Tunnel 和所有项目 |
| `codex-mcp exit` | 停用当前项目 |
| `codex-mcp exit -a` | 停止所有项目并关闭后台服务和 Tunnel |
| `codex-mcp setup` | 首次设置或管理现有配置 |
| `codex-mcp doctor` | 检查安装、配置和依赖 |
| `codex-mcp auth` | 修改 ChatGPT 连接密码 |
| `codex-mcp update` | 更新到最新版本 |
| `codex-mcp tunnel` | 重新配置公网连接 |
| `codex-mcp --root <目录>` | 注册指定目录，而不是当前目录 |
| `codex-mcp --local` | 仅本机模式，不开放公网 |
| `codex-mcp --no-tunnel` | 不自动启动 Cloudflare Tunnel |
| `codex-mcp --tunnel-logs` | 把 Tunnel 日志同时输出到运行日志 |
| `codex-mcp serve --foreground` | 前台运行服务，用于调试 |
| `codex-mcp --version` | 查看版本 |
| `codex-mcp help` | 查看帮助 |

---

# 再次运行 setup 会发生什么？

已经完成首次配置后，再运行：

```bash
codex-mcp setup
```

不会重新走一遍所有步骤。

你可以选择：

- 检查当前配置
- 修改公网连接
- 重新登录 / 切换 Cloudflare 账号
- 修改连接密码
- 管理 Codex / Claude Code / Agent Skills
- 退出，不做修改

“检查当前配置”会真实验证公网地址是否能够连接回当前电脑，而不只是检查配置文件是否存在。

---

# 配置保存在哪里？

codex-mcp 的用户数据默认保存在：

```text
~/.codex-mcp/
```

主要文件包括：

```text
~/.codex-mcp/config.json
~/.codex-mcp/daemon.json
~/.codex-mcp/projects.json
~/.codex-mcp/session-bindings.json
~/.codex-mcp/logs/
```

其中：

- `config.json`：公网地址、工作区、权限、外部能力等设置
- `daemon.json`：当前后台服务状态
- `projects.json`：注册过的项目
- `session-bindings.json`：ChatGPT 会话和项目的绑定关系

Cloudflare 的登录和 Tunnel 凭据由 codex-mcp 放在自己的配置目录中管理，不依赖系统级 `~/.cloudflared` 作为长期运行状态。

---

# 日志

运行日志位于：

```text
~/.codex-mcp/logs/
```

结构化日志文件类似：

```text
codex-mcp.2026-08-12.0.jsonl
```

Cloudflare Tunnel 原始日志：

```text
~/.codex-mcp/logs/tunnel.log
```

正常的工具日志不会记录：

- 原始命令内容
- 文件内容
- 工具返回的完整内容
- OAuth 凭据

它主要记录工具名、耗时、结果状态等运行信息。

如果遇到启动、Tunnel 或 MCP 连接问题，首先查看这里。

---

# 检查问题

运行：

```bash
codex-mcp doctor
```

它会检查：

- Node.js 版本
- Git
- 文件搜索组件
- codex-mcp 配置
- 连接密码
- 公网地址
- cloudflared
- Cloudflare 登录
- Tunnel 凭据
- Tunnel 配置文件
- 外部能力设置

这是排查问题时最先应该运行的命令。

---

# 常见问题

## `codex-mcp` 命令找不到

重新打开终端后再试。

如果仍然找不到，重新运行安装脚本。

---

## ChatGPT 连接不上

先运行：

```bash
codex-mcp status
codex-mcp doctor
```

确认：

- 后台服务正在运行
- 公网连接已启动
- 公网地址正确
- Tunnel 没有报错

再查看：

```text
~/.codex-mcp/logs/
```

---

## 忘记连接密码

密码明文无法找回。

重新设置：

```bash
codex-mcp auth
```

---

## Cloudflare 登录错了账号

运行：

```bash
codex-mcp setup
```

选择：

```text
重新登录 / 切换 Cloudflare 账号
```

codex-mcp 只会重置自己管理的 Cloudflare 登录，不会随意修改你的系统级 `~/.cloudflared`。

---

## Cloudflare 上有旧 Tunnel，配置对不上

重新运行：

```bash
codex-mcp tunnel
```

codex-mcp 会检查本机 Tunnel 凭据和 Cloudflare 上的 Tunnel 是否匹配。

如果发现同名 Tunnel 但本机没有可用凭据，会明确询问后再处理，不会静默删除远端 Tunnel。

---

## Tunnel 一直连接不上

查看：

```text
~/.codex-mcp/logs/tunnel.log
```

某些网络或防火墙会阻止 Cloudflare Tunnel 使用的 TCP 7844 连接。

当前版本会优先使用 IPv4，并在连接超时时给出更具体的错误提示。

---

## ChatGPT 看不到刚新增的项目或控制工具

先在 ChatGPT 的 MCP / App 设置中执行 Refresh，或者重新发布 / 重新连接当前 MCP App。

codex-mcp 对旧的 ChatGPT action snapshot 保留了兼容路径，但新的工具列表最终仍需要 ChatGPT 重新读取。

---

## 我需要每个项目启动一个 codex-mcp 吗？

不需要。

每个项目只需要运行一次：

```bash
codex-mcp
```

用来把它注册到同一个后台服务。

真正运行的 MCP server 和 Cloudflare Tunnel 都只有一套。

---

## 关闭终端以后 codex-mcp 会停吗？

默认不会。

正常的 `codex-mcp` 会启动后台守护进程，终端命令完成后服务继续运行。

查看：

```bash
codex-mcp status
```

停止全部：

```bash
codex-mcp exit -a
```

如果你是开发调试，希望服务一直占用当前终端，可以使用：

```bash
codex-mcp serve --foreground
```

---

# 更新

```bash
codex-mcp update
```

更新会保留你的配置和连接密码。

更新后建议关闭旧后台服务并重新启动：

```bash
codex-mcp exit -a
codex-mcp
```

这样可以确保正在运行的进程使用新版本。

---

# 卸载

如果是用 npm 安装的：

```bash
npm uninstall -g @meesii/codex-mcp
```

如果是用安装脚本安装的：

### macOS / Linux

```bash
curl -fsSL https://github.com/meesii/codex-mcp/releases/latest/download/uninstall.sh | sh
```

### Windows PowerShell

```powershell
irm https://github.com/meesii/codex-mcp/releases/latest/download/uninstall.ps1 | iex
```

卸载程序默认保留用户配置和连接密码。

如果你确定不再使用，并希望彻底删除所有状态，可以再手动删除：

```text
~/.codex-mcp
```

---

# 安全说明

codex-mcp 的目标不是做一个强隔离沙箱，而是让个人开发环境中的 ChatGPT 可以真正完成开发工作。

因此请注意：

1. **不要把自己的 codex-mcp 实例分享给其他人。**
2. **不要把连接密码公开。**
3. **只给你信任的目录永久授权。**
4. **执行 shell 命令时，命令仍拥有当前系统用户本身的权限。**
5. **如果电脑上保存了生产环境密钥、SSH Key 或其他敏感文件，请按照正常本机开发安全标准管理它们。**

公网 MCP 入口需要连接密码认证，但它不能替代操作系统级隔离。

---

# 高级说明：ChatGPT 工具列表兼容

正常情况下你不需要关心这一节。

ChatGPT 有时会缓存已经批准过的 MCP action 列表，所以服务端新增工具后，当前对话不一定立刻看到。

codex-mcp 为常用流程保留了兼容入口。例如旧工具列表看不到新的项目选择工具时，仍然可以通过已有的项目发现入口完成会话绑定。

但涉及以下高风险操作时不会通过只读兼容入口绕过确认：

- 外部目录写权限
- 外部命令执行权限
- 永久工作区信任

如果相关控制工具不可见，请在 ChatGPT 中 Refresh MCP App，而不是绕过授权流程。

---

# 本地开发

克隆项目后：

```bash
npm ci
npm run typecheck
npm test
npm run build
```

开发模式：

```bash
npm run dev
```

只在本机调试：

```bash
npm run dev:once -- --local
```

发布版本要求 Node.js 22，并会在 GitHub Actions 中验证 Linux、macOS 和 Windows。

---

# License

[MIT](LICENSE)

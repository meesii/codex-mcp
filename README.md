# codex-mcp

精简的本机 Coding [MCP](https://modelcontextprotocol.io) 服务：通过 **Streamable HTTP** 把一个本地项目目录暴露给 ChatGPT（Developer Mode）。公网模式默认启用内置 OAuth；`--local` 仅用于本机调试。

适合个人开发：在终端运行 `codex-mcp`，选择 project root 后即可在 ChatGPT 里读改代码、运行命令、搜索文件，并可选通过 Cloudflare Tunnel 提供公网 HTTPS 入口。

## 功能

- **内置 OAuth**：单一管理员密码、Authorization Code + PKCE S256、refresh token rotation、CIMD 优先 + DCR fallback
- **单项目绑定**：启动前选择 project root；文件工具做 canonical path 校验并阻止 symlink 逃逸
- **Cloudflare Tunnel（可选）**：使用 codex-mcp 自己的 cloudflared 配置，不覆盖用户全局配置；sidecar 固定 HTTP/2 + IPv4 edge，避开双栈网络中 IPv6 TCP/7844 不通导致的启动超时；远端删除/DNS 覆盖必须显式确认
- **文件与搜索**：`read` / `write` / `edit`、`grep` / `glob` / `ls`
- **命令执行与恢复**：短命令 `bash`；长任务 `exec_command` + `write_stdin` / `process_kill`，并可用 `process_list` / `process_status` / `process_output` 跨 HTTP/MCP 请求找回同一 owner 的运行中进程
- **有界运行观测**：`runtime_status` 返回 tool/HTTP/downstream 的 calls/errors/p50/p95/max、tool response bytes、downstream cache hit/miss/reconnect，以及 process 计数与 buffer 聚合；recent latency sample 固定 256 条，不保存参数、命令、路径、正文或凭据
- **安全网页拉取**：`webfetch` 支持 text / markdown / html，阻止 loopback/private/link-local SSRF，并流式限制响应大小
- **Codex MCP 自动桥接 + 热更新**：默认通过有 timeout / 输出预算的异步 `codex mcp list --json` 导入本机 Codex 已启用 MCP；`~/.codex-mcp/mcp.json` 仅用于额外配置/同名覆盖；配置变化自动 diff reload，也可显式 `capabilities_reload`
- **完整 MCP Gateway**：代理下游 tools、resources、resource templates、prompts；per-server 生命周期串行化，reload/reconnect 与 in-flight 调用不会复活旧连接，并对 stdio stderr、分页、列表和单次结果设置资源预算
- **Codex Skills 自动桥接 + 热更新**：默认发现 `~/.agents/skills`、`~/.codex/skills`（含 `.system`）；通过 `skills_list` / `skill_read` 按需加载，不复制 Skill 文件
- **Codex AGENTS.md 继承**：自动应用 `~/.codex/AGENTS.md` 和项目根规则；进入嵌套路径时用 `agents_for_path` 加载更具体的 `AGENTS.md`
- **Workspace / Git / CodeGraph 感知**：多仓发现、跨仓搜索、context pack、结构化只读 Git，以及优先 CodeGraph 的 `code_explore`
- **按 client 能力治理**：可按 OAuth `client_id` 或 `local:noauth` 限制实际注册的工具，默认不配置时仍保持全工具兼容
- **MCP Apps 摘要卡片**：只展示状态、路径、计数和短预览，不渲染完整文件或命令输出

| 工具 | 说明 |
| --- | --- |
| `read` / `write` / `edit` | 读写与精确替换，路径限制在 project root |
| `bash` | 短命令前台执行（Windows: `pwsh`，Unix: `bash`） |
| `exec_command` | 长任务可返回 `processId` |
| `write_stdin` | 轮询进程输出或写 stdin |
| `process_kill` | 结束由 `exec_command` 启动的后台进程 |
| `process_list` / `process_status` / `process_output` | owner-scope 内发现进程、查看状态、非消费式 peek 输出 |
| `runtime_status` | 只读聚合 telemetry：tool/HTTP/downstream latency/error/bytes/cache/reconnect + process runtime stats；不保留 payload/命令/路径 |
| `grep` / `glob` / `ls` | 搜索与目录浏览，均有结果/资源预算 |
| `workspace_projects` / `workspace_search` | 多仓 Git 项目发现与结构化跨仓搜索 |
| `context_pack` | 聚合项目、相关文件、AGENTS、Skill 候选、CodeGraph availability |
| `git_status` / `git_diff` / `git_log` / `git_show` / `git_branches` | 异步 bounded Git 查询；禁 optional index writes/fsmonitor，diff/show 额外禁 ext-diff/textconv helper |
| `code_explore` | 有 CodeGraph index + MCP 时优先 `codegraph_explore`，否则 bounded workspace search fallback |
| `webfetch` | 拉取公开 http(s) 页面，带 SSRF 与 byte-limit 防护 |
| `skills_list` / `skill_read` | 发现/按需读取本机 Codex Skills |
| `agents_for_path` | 读取某路径适用的全局 + 项目层级 `AGENTS.md` |
| `capabilities_reload` | 原位重新导入 Codex MCP 并刷新 Skill 索引，不重启 HTTP/OAuth/Tunnel |
| `mcp_servers` / `mcp_reconnect` | 下游连接状态、capabilities 与显式重连 |
| `mcp_tools` / `mcp_call` | 下游 tool schema 与调用，保留 rich MCP content |
| `mcp_resources` / `mcp_resource_read` | 下游 resources/templates 与 text/blob resource 内容 |
| `mcp_prompts` / `mcp_prompt_get` | 下游 prompt metadata 与解析后的 messages |

公网模式的工具声明 OAuth2；`--local` 调试模式声明 noauth。两种模式都按真实能力提供 `readOnlyHint` / `destructiveHint` / `openWorldHint`。返回格式使用短 `content` + 结构化 `structuredContent`。

## 使用前准备

必须准备：

- Node.js `22` 或更高版本
- 如果要让 ChatGPT 从公网连接：一个自己的域名和 Cloudflare 账号

codex-mcp 会自己管理运行组件：

- ripgrep：安装 codex-mcp 时自动准备，用于文件搜索
- cloudflared：选择 Cloudflare Tunnel 时自动准备，不需要手动安装或填写程序路径

可选安装：

- Git：没有时 Git 状态、历史和差异相关工具不可用
- Codex CLI：安装后 codex-mcp 会自动读取你已有的 Codex MCP

## 一键安装

Friends Beta 通过 GitHub Releases 分发，不需要下载源码，也不需要 `npm link`。程序安装在 `~/.codex-mcp/npm`，codex-mcp 自己管理的运行组件放在 `~/.codex-mcp/bin`，配置保存在 `~/.codex-mcp`；升级程序不会覆盖配置。

**macOS / Linux：**

```bash
curl -fsSL https://github.com/meesii/codex-mcp/releases/latest/download/install.sh | sh
```

**Windows PowerShell：**

```powershell
irm https://github.com/meesii/codex-mcp/releases/latest/download/install.ps1 | iex
```

安装完成后如果当前终端还找不到 `codex-mcp`，重新打开一个终端窗口即可。

## 第一次使用

只需要运行：

```bash
codex-mcp setup
```

向导会依次完成：

1. 设置连接密码。这个密码只保存在当前电脑，不保存明文。
2. 填写给 ChatGPT 使用的域名。
3. 登录 Cloudflare。
4. 创建或复用 Tunnel，并配置 DNS。

设置完成后可以先检查一次：

```bash
codex-mcp doctor
```

`doctor` 只读取本机状态，不会修改配置。它会检查 Node.js、Git、Codex、文件搜索组件、连接密码、域名、公网连接组件和 Tunnel 文件。真正的公网连通性会在每次启动 `codex-mcp` 时自动验证。

## 启动项目

进入你希望 ChatGPT 操作的项目目录：

```bash
cd /path/to/your-project
codex-mcp
```

启动成功后终端会显示 **连接地址**。把这个地址添加到 ChatGPT 的 MCP / Developer Mode 中即可。

> 每个人都应该在自己的电脑上运行自己的 codex-mcp。不要把一个实例和互不信任的人共用，因为它具备文件修改和命令执行能力。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `codex-mcp` | 启动当前项目 |
| `codex-mcp setup` | 第一次设置，或重新完整设置 |
| `codex-mcp doctor` | 检查安装和配置，不做修改 |
| `codex-mcp auth` | 只重新设置连接密码 |
| `codex-mcp tunnel` | 只重新设置公网连接 |
| `codex-mcp --local` | 只在本机启动，不开放公网 |
| `codex-mcp --no-tunnel` | 不自动启动 Cloudflare Tunnel |
| `codex-mcp --root <目录>` | 指定项目目录 |
| `codex-mcp --version` | 查看当前版本 |

## 卸载

卸载只删除程序，默认**保留配置、连接密码和 Tunnel 信息**，以后重新安装可以继续使用。

macOS / Linux：

```bash
curl -fsSL https://github.com/meesii/codex-mcp/releases/latest/download/uninstall.sh | sh
```

Windows PowerShell：

```powershell
irm https://github.com/meesii/codex-mcp/releases/latest/download/uninstall.ps1 | iex
```

如果确定以后都不再使用，再手动删除 `~/.codex-mcp`。这个目录可能包含认证状态，不建议随手分享给别人。

## 从源码开发

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run build
```

本地 MCP Inspector 使用 `codex-mcp --local`，地址为 `http://127.0.0.1:3920/mcp`。

## OAuth

公网模式下 `/mcp` 必须携带有效 Bearer access token。内置 Authorization Server 提供：

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
/authorize
/token
/register
/revoke
```

主要安全属性：

- Authorization Code + **PKCE S256 only**
- 授权回调包含 RFC 9207 `iss`
- `mcp:tools` scope；支持 `offline_access`；显式 scope 缺少 `mcp:tools` 时直接拒绝，不做隐式扩权
- access token 默认 15 分钟
- authorization code 默认 5 分钟，一次性使用
- refresh token 30 天 idle lifetime，并在每次 refresh 时 rotation
- 已使用 refresh token 被再次提交时，撤销整个 token family
- access / refresh / authorization code 都是高熵 opaque value；磁盘只保存其 SHA-256 digest
- OAuth state 文件使用原子写入，并在 Unix 上设置 owner-only 文件权限
- MCP `resource` 必须同时出现在 authorization / token / refresh 请求，并精确绑定当前 MCP URL
- Authorization Server Metadata 宣告 Client ID Metadata Documents，并广告 `token_endpoint_auth_methods_supported=[private_key_jwt, none]` 与 RS256；同时保留 DCR 兼容旧客户端
- CIMD 支持 public client `none`，也支持 ChatGPT 使用的 confidential `private_key_jwt`：从 CIMD 的 `jwks`/`jwks_uri` 获取公钥，严格校验 RS256、`iss=sub=client_id`、`aud` 精确标识当前 Authorization Server（issuer URL 或 token endpoint URL）、必需 `exp`/`jti` 与可选 `iat`；audience 数组不得混入无关目标；按 `client_id + jti` 在 assertion 有效期内做 replay protection，并支持 JWKS rotation cache
- DCR 仍只接受 public client + PKCE，不生成、不返回、不持久化 client secret；不会把 DCR 放宽成静态 shared-secret confidential client
- CIMD/JWKS metadata 使用统一 safe HTTP：只允许全球可路由目标、逐跳校验 redirect、限制 timeout/响应大小；HTTPS 支持标准 `HTTPS_PROXY`/`ALL_PROXY`，macOS 还会读取当前 Secure Web Proxy。代理路径先经独立 DoH 验证公网 A/AAAA，再把 CONNECT 固定到已验证公网 IP，并以原 hostname 执行 Host/TLS SNI/证书校验；复用 bounded keep-alive proxy agent，只对连接 errno/reset 与项目自身 bounded timeout 等传输故障在已验证 IP 间有限重试，TLS/证书/HTTP validation 仍 fail-closed。HTTP URL 不进入该代理路径；CIMD/JWKS 内存 cache 同时做 TTL pruning 和容量上限，避免大量不同 metadata URI 长期累积
- 授权页直接使用 SDK 原生 GET/POST `/authorize`：GET 显示密码表单，表单把已验证的 OAuth 参数作为 hidden fields POST 回同一路径，POST 时 SDK 再次校验 client/redirect/PKCE/resource 后才执行 Argon2id 密码验证并签发 code；不再使用 `/oauth/approve` 或 `pending_id`。页面保留 `default-src 'none'`、`frame-ancestors 'none'`、`base-uri 'none'`，但不设置会约束 OAuth 302 导航链的 `form-action`；密码验证仍有 per-client/global 限流和最多 2 个并发校验

OAuth state 不保存 client secret；`private_key_jwt` 客户端只依赖其公开 JWKS，管理员登录密码本身也永远不保存明文。

## 接入 ChatGPT

1. 启动 `codex-mcp` 并确认公网 URL，例如 `https://mcp.example.com/mcp`
2. ChatGPT → Settings → Apps / Developer Mode → 添加 MCP server URL
3. ChatGPT 发现 Protected Resource Metadata / Authorization Server Metadata 后会进入 OAuth 流程
4. 浏览器显示 codex-mcp 连接页面；输入你在 `codex-mcp setup` 中设置的连接密码
5. ChatGPT 在 `/token` / `/revoke` 使用 CIMD 声明的 `private_key_jwt` 做客户端认证；codex-mcp 验签成功后签发/轮换 Bearer token
6. 授权完成后 ChatGPT 使用 Bearer token 调用 MCP；refresh token 用于保持长期连接

启动内置 cloudflared sidecar 时，codex-mcp 还会从公网 hostname 回环请求一个每进程随机 probe，确认流量确实返回当前实例；如果 DNS/Worker 指到了另一个 tunnel，会在启动阶段直接报错而不是等 ChatGPT 报 OAuth discovery 错误。

修改工具定义、下游 MCP 配置或 authorization metadata 后，建议刷新 connector 或开启新对话。

## 用户配置

机器级配置：

```text
~/.codex-mcp/config.json
```

Windows：`%USERPROFILE%\.codex-mcp\config.json`。

示例：

```json
{
    "host": "127.0.0.1",
    "port": 3920,
    "domain": "mcp.example.com",
    "useCloudflared": true,
    "tunnelName": "codex-mcp",
    "tunnelId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "clientCapabilities": {
        "default": ["*"],
        "clients": {
            "local:noauth": ["*"],
            "https://chatgpt.example/client-metadata.json": ["read", "grep", "glob", "ls", "skill*", "mcp_*", "git_*"]
        }
    }
}
```

| 字段 | 说明 |
| --- | --- |
| `domain` | 公网 Host；会 canonicalize 为 DNS hostname（含 IDN punycode），拒绝 IP/localhost/credentials/非法 label，并用于构造 OAuth resource URL |
| `useCloudflared` | `true` 时 serve 自动启动 tunnel sidecar |
| `cloudflaredBin` | 自动保存的公网连接组件路径；通常不需要手动填写 |
| `tunnelName` / `tunnelId` | Tunnel 标识 |
| `host` / `port` | 正常 serve 的本机监听地址；`--local` 会忽略 host 并强制 `127.0.0.1` |
| `clientCapabilities` | 可选的**顶层 tool registration policy**；`default` 和 `clients[client_id]` 接受精确工具名、单个 trailing `*` 前缀模式或 `*`。省略整个字段时默认所有工具可用。它不是多租户 sandbox：同一 codex-mcp 实例的已授权客户端共享 downstream Hub/runtime |

相关状态：

```text
~/.codex-mcp/auth.json             # 管理员 Argon2id 密码哈希
~/.codex-mcp/oauth-state.json      # OAuth client/code/token digest 状态
~/.codex-mcp/bin/                  # codex-mcp 自动管理的 rg / cloudflared
~/.codex-mcp/mcp.json              # 可选：额外 MCP / Codex MCP 同名覆盖
~/.codex-mcp/cloudflared.yml       # codex-mcp 专用 cloudflared ingress
~/.codex-mcp/logs/tunnel.log       # tunnel sidecar 日志
```

这些文件可能包含敏感认证状态；不要提交到项目仓库，也不要共享。

## Codex MCP 自动导入与本地覆盖

正常情况下**不需要复制 Codex MCP 配置**。启动 `codex-mcp` 时会异步执行本机 `codex mcp list --json`（15 秒 timeout、8 MiB stdout budget；超限拒绝 partial JSON），导入 Codex 当前启用的 stdio / Streamable HTTP MCP；Codex 中 `enabled=false` 的 server 不会导入。配置和凭据只在启动进程内转换，不会另存一份到 `~/.codex-mcp`。

`~/.codex-mcp/mcp.json` 变为可选的 **extra / override** 层：不存在时完全使用 Codex 配置；新增名字会增加一个下游；与 Codex 同名时本地配置覆盖 Codex；同名配置使用 `"disabled": true` 时会屏蔽该 Codex MCP。

例如：

```json
{
    "mcpServers": {
        "github": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-github"],
            "env": {
                "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}"
            }
        },
        "remote-demo": {
            "url": "https://example.com/mcp",
            "headers": {
                "Authorization": "Bearer ${REMOTE_MCP_TOKEN}"
            }
        }
    }
}
```

| 字段 | 说明 |
| --- | --- |
| `command` / `args` / `env` / `cwd` | stdio MCP |
| `url` / `headers` | Streamable HTTP MCP，与 `command` 二选一；远程 URL 默认要求 HTTPS，loopback 可用 HTTP |
| `disabled` | `true` 时跳过本地项；若与 Codex MCP 同名，则屏蔽该自动导入项 |

`env` / `headers` 中看起来属于 token、secret、password、Authorization、API key 等敏感字段时，必须使用 `${ENV_VAR}` 引用环境变量，避免把凭据明文写进 `mcp.json`；引用不存在的环境变量会在启动时直接报错。Unix 上读取 `mcp.json` 时会收紧文件权限为 `0600`。

启动时连接合并后的各下游 MCP，但顶层 instructions **只使用本机可信配置中的 server key**，不会自动注入远端 `instructions`、`title`、`description` 或 `name`。Gateway 使用 negotiated server capabilities 暴露 tools/resources/prompts；下游返回的 text、image、audio、resource/link 等 MCP content 会保留。每个 server 使用稳定 slot + 可替换 connection generation，并通过 lifecycle mutex 串行 reconnect/reload；旧 generation 允许已经开始的调用自然结束，但配置变化后不能再被 reconnect 回来。stdio stderr 会持续 drain 到有界 tail，避免 pipe backpressure。分页最多 50 页、列表最多 2000 项/约 2 MiB serialized data，重复 cursor 直接拒绝；单次 tool/resource/prompt result 超过约 4 MiB 会被 Gateway 拒绝。

运行期间会监听 `~/.codex/config.toml`、`~/.codex-mcp/mcp.json` 和 Skill roots：MCP 配置修改使用 config diff 原位 add/change/remove，未变化的连接不会重建；Skill 目录变化会原位刷新索引。Skill root 启动时不存在也可以：watcher 会先监听最近存在的祖先目录，root 创建后再切换为 recursive watcher。已有父 MCP session 的 gateway/skill tools 始终固定注册，因此能立即读取共享 Hub/Registry 的新状态。文件监听只是便利层，`capabilities_reload` 是确定性的显式刷新入口。

## Codex Skills 自动导入

启动时默认发现以下用户级 Skill roots：

```text
~/.agents/skills
~/.codex/skills
~/.codex/skills/.system
```

`~/.agents/skills` 优先于 `~/.codex/skills` 的同名 Skill；Codex 目录里的 symlink Skill 会按其真实目录读取。initialize instructions 只加入 **Skill name + description 索引**，不会把几十个 `SKILL.md` 正文一次性塞进上下文。

模型需要实际使用 Skill 时先调用 `skill_read`。默认读取 `SKILL.md`，也可以读取该 Skill 目录内引用的 `references/*`、`scripts/*` 等文本文件；路径会做 canonical containment 校验，不能借 `..` 或内部 symlink 逃出已发现 Skill 目录。

## Codex AGENTS.md 继承

initialize 会应用本机 `~/.codex/AGENTS.md`（若存在）以及 project root 的 `AGENTS.md`。对于嵌套目录，`agents_for_path` 按从 project root 到目标路径的目录链加载更具体的 `AGENTS.md`；项目指令做 canonical containment，不会借 symlink 读取 project root 外的规则。这样保持 Codex 的“越深目录规则越具体”语义，同时避免扫描整个大型 workspace。

## Workspace / Git / Code Explore

`workspace_projects` 以有界深度发现 project root 下的 Git repo，返回 branch、dirty、project kind 和 `.codegraph` availability；`workspace_search` 使用 bounded ripgrep 做结构化跨仓搜索。`context_pack` 将这些信息与相关文件候选、适用 AGENTS、Skill 候选和 CodeGraph 状态合并成轻量任务上下文，不执行项目代码也不修改文件。

Git 专用工具全部通过异步 bounded subprocess 调用 `git`，不经过 shell，也不提供 checkout/reset/add/commit/push。公共执行层设置 `GIT_OPTIONAL_LOCKS=0`、关闭 `core.fsmonitor` 并禁止交互 credential prompt，避免 `status` 等查询做 optional index refresh；`git_diff` / `git_show` 还强制 `--no-ext-diff --no-textconv`，避免仓库 Git 配置触发外部 helper。status 使用 NUL-delimited porcelain 并包含 untracked 文件；大 diff/show 到达输出预算时主动终止 Git 并返回 `truncated=true`，而不是先撞 `maxBuffer`。`code_explore` 在找到适用 `.codegraph` 且导入的 `codegraph` MCP ready 时调用其 `codegraph_explore`；否则明确给出 fallback 原因并返回 bounded workspace search 结果。

## 安全模型

公网安全边界是 **OAuth + HTTPS/Tunnel**。知道域名本身不再等于获得工具权限。

文件工具使用 canonical path containment，阻止普通 `..` 和 symlink/junction 逃逸 project root；写/编辑操作由进程内锁串行化。但这仍然**不是操作系统级 sandbox**。

授权后的 `bash` / `exec_command` 会以启动 `codex-mcp` 的当前操作系统用户权限运行，因此它们天然可以访问 project root 之外的资源、网络和其它本机权限范围。管理员密码与 OAuth 的作用是控制“谁能调用这些高权限工具”，不是降低命令本身的 OS 权限。若需要对不可信用户开放，应再增加容器/VM/OS sandbox，而不是直接共享本服务。

其它边界：

- `/mcp` 使用 **stateless request-scoped transport**：2026-07-28 请求由 `createMcpHandler` 的 per-request transport 服务，2025-era client 走同一 factory 的 stateless fallback；服务端不再保存或依赖 `Mcp-Session-Id`，因此代理/TCP 取消不会把后续请求锁死在失效 session 上。legacy `initialize` 仍有频率限制
- tool policy 在每个请求创建 `McpServer` 时按 OAuth `client_id`（本地模式为 `local:noauth`）解析，并在统一 `registerTool` 边界直接不注册被禁止工具；instructions、AGENTS/Skill/Downstream 顶层提示也只在对应入口工具可用时注入。策略修改会自然作用于后续请求。**这是一层 tool registration policy，不是租户隔离**：本服务定位为单管理员本机 Gateway，同一实例的已授权客户端共享 DownstreamMcpHub，因此浏览器/REPL 等有状态下游以及 reconnect/reload 的影响是共享的；若要向互不信任的用户提供隔离，应使用独立 codex-mcp 进程/OS sandbox
- 长进程全局最多 8 个、单进程 owner 最多 4 个；公网 OAuth 模式按 `clientId` 隔离、本地 `--local` 模式按本机 owner 共享。同一 owner 可跨独立 HTTP/MCP 请求继续 list/status/peek/poll/kill；`process_output` 不消费 buffer。running process 使用最多约 1,000,000 字符 rolling buffer；结束后历史 buffer 收缩到最多 200,000 字符，并额外受 retained history 预算约束（单 owner 最多 16 条/2,000,000 字符，全局最多 64 条/8,000,000 字符），同时仍保留 5 分钟 TTL。每个请求仅持有短 lease；最后一个 request lease 释放后进入重连宽限期，owner 在宽限期内的新请求会复用同一 process scope，否则 TERM→KILL 清理；server shutdown 会立即清理全部进程
- `webfetch` / CIMD / remote JWKS 只允许全球可路由网络目标，并限制 redirect/响应大小；代理环境下先独立验证公网 DNS，再通过标准/macOS HTTPS proxy 出站
- destructive/open-world tool annotations 按真实能力声明，让 host 可以应用确认策略
- MCP Apps tool card 不复制完整 shell command；URL 展示会移除 credentials/query/fragment，避免 token/signed-URL 泄漏到 UI metadata
- `/healthz` 仅返回 `{ "ok": true }`，不泄露本机 project path

## 开发与验证

```bash
npm run typecheck
npm test
npm run build
npm audit --omit=dev --registry=https://registry.npmjs.org
```

测试使用官方 SDK 的 **MCP Client + StreamableHTTPClientTransport** 做真实 HTTP E2E，覆盖 OAuth、PKCE、`private_key_jwt`/RS256/JWKS、missing-`jti` rejection 与 assertion replay、refresh rotation/replay、tunnel end-to-end route probe、stateless stale-session header 容错、跨请求进程恢复/非消费式 peek、文件 symlink 边界、CRLF 编辑、glob、running + retained process quota、SSRF、bounded subprocess、Codex MCP 导入/热 reload、reload-vs-reconnect race、stdio stderr backpressure、Gateway pagination/result budget、启动后创建 Skill root、AGENTS 作用域、Downstream tools/resources/prompts + rich content、Git textconv suppression/index-write suppression/large-diff truncation、workspace untracked dirty、CodeGraph fallback、capability policy/instruction filtering 等。

## 架构

```text
cli
 ├─ auth setup (Argon2id)
 ├─ tunnel wizard / cloudflared sidecar
 ├─ codex mcp list --json + ~/.codex-mcp/mcp.json → DownstreamMcpHub
 ├─ Codex Skill roots → SkillRegistry
 ├─ ~/.codex/AGENTS.md + project AGENTS.md → AgentInstructionRegistry
 ├─ CodexCapabilityWatcher → in-place MCP/Skill reload
 └─ clientCapabilities → per-client request policy
      ↓
http-server
 ├─ embedded OAuth AS + RFC 9728 metadata
 ├─ Bearer guard → validated OAuth clientId
 └─ stateless Streamable HTTP /mcp
      ├─ v2 per-request handler + legacy stateless fallback
      ├─ stable owner-scoped ProcessOwnerPool (independent of transport session)
      ├─ policy-filtered mcp-server instructions + tool registration
      ├─ project coding / process / workspace / Git / code_explore tools
      ├─ skills_list / skill_read → SkillRegistry
      ├─ agents_for_path → AgentInstructionRegistry
      └─ mcp_* → DownstreamMcpHub (tools + resources + prompts)
```

## License

[MIT](LICENSE)

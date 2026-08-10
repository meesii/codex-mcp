# OAuth 与安全整改任务计划

## 目标

将 codex-mcp 从公网无认证的本机 Coding MCP，整改为默认使用内置 OAuth 2.1 授权服务器保护公网 `/mcp` 的单用户服务，并修复 2026-08-07 全量 review 中确认的安全、正确性、资源治理、Cloudflare、Downstream MCP、UI、Windows、依赖和测试问题。

## 已确认设计

- OAuth：codex-mcp 内置 Authorization Server。
- 用户模型：单一管理员密码，不引入多用户/租户。
- OAuth flow：Authorization Code + PKCE S256；opaque access/refresh token；refresh rotation；支持 `offline_access`。
- 客户端注册：CIMD 优先，DCR fallback 兼容旧客户端/ChatGPT。
- 公网模式：OAuth mandatory；未配置管理员密码时拒绝无保护启动。
- `--local`：仅用于本地调试，强制 loopback，可无 OAuth。
- 不在本轮迁移到 MCP 2026-07-28 stateless core；保留当前 Streamable HTTP session transport，独立处理兼容性迁移。

## 完成标准

1. 公网 `/mcp` 无合法 bearer token 无法进入 MCP transport。✅
2. OAuth metadata、authorize、token、register/revoke、PKCE、refresh rotation 有自动测试。✅
3. 文件工具无法通过 symlink / dangling symlink 逃逸 project root。✅
4. review 中所有确定 bug 都有回归测试或 focused executable evidence 并修复。✅
5. Cloudflare 不覆盖 `~/.cloudflared/config.yml`，不自动删除 tunnel 或覆盖 DNS。✅
6. 资源上限防止 session/process/输出无限增长。✅
7. Downstream MCP 不丢合法 content，不信任远端自动 metadata/instructions，不声称 catalog 永久不变。✅
8. UI 不再永久 4Hz polling。✅
9. Windows CRLF/Unicode installer/interrupt 文档语义修复。✅
10. `npm run typecheck`、`npm test`、`npm run build` 全通过；生产依赖 audit=0。✅
11. README 与实际认证/安全模型一致。✅
12. Git diff 只包含本次任务相关改动。✅（最终核对见 `final_report.md`）
13. 后续攻击面与残留一致性 review R-029～R-043，以及真实 ChatGPT 集成新增 R-044～R-052（`private_key_jwt`、安全代理/CIMD/JWKS、BlockList cross-family、tunnel route postcondition、OpenID `private_key_jwt` 必需 `jti`、proxy bounded-timeout retry、Chrome OAuth callback CSP、router-native GET/POST `/authorize`、token-endpoint audience）全部修复并有 regression。✅

## 阶段

### 阶段 0：基线、规范与工作记录
- 状态: **complete**
- [x] 完整 review 并确认问题清单
- [x] 用户确认内置 OAuth + 单一管理员密码
- [x] 核对 MCP 2026-07-28 OAuth/CIMD 最新方向
- [x] 建立 `docs/oauth-security-hardening/` 工作目录
- [x] 解除该目录的 `.gitignore`，继续忽略其它本地 `docs` 参考克隆

### 阶段 1：OAuth 核心与公网 HTTP 边界
- 状态: **complete**
- [x] 管理员密码 Argon2id 持久化 / `codex-mcp auth`
- [x] OAuth discovery / authorize / token / revoke / DCR
- [x] CIMD 安全拉取与 redirect validation；`client_id` URL 精确匹配、`client_name`、HTTPS/loopback redirect；支持 `none` 与标准 `private_key_jwt`（RS256/JWKS/assertion replay protection）
- [x] access/refresh/code 生命周期、MCP `resource` 在 authorization/token/refresh 三阶段必填并绑定、refresh replay family revoke
- [x] strict scope semantics：显式 scope 必须包含 `mcp:tools`
- [x] DCR public-client only；CIMD 可用 `none` 或公钥 `private_key_jwt`；均不生成/保存 shared client secret
- [x] DCR issuer binding + bounded client capacity/eviction + per-client/global rate limit
- [x] `/mcp` Bearer 校验、401 + `WWW-Authenticate`
- [x] 公网模式拒绝未配置管理员密码启动
- [x] `--local` 强制 127.0.0.1 + noauth metadata
- [x] OAuth endpoint / approval rate limit，Cloudflare-aware client key；approval per-client + global + max-concurrent=2
- [x] admin password reset → credential generation change → old code/access/refresh invalidation
- [x] revoke client ownership + redirect host/loopback warning
- [x] MCP session 绑定 OAuth client owner
- [x] OAuth E2E

### 阶段 2：文件安全与工具正确性
- 状态: **complete**
- [x] canonical project root + symlink-aware path guard
- [x] directory link + dangling symlink escape tests
- [x] edit literal replacement + empty old_string
- [x] CRLF read/edit 兼容
- [x] streaming bounded read / list / search budget
- [x] minimatch 替换自制 glob matcher

### 阶段 3：网络、进程与资源治理
- 状态: **complete**
- [x] shared safe HTTP fetch（SSRF、redirect、stream byte limit、特殊 IPv6 ranges）
- [x] webfetch 改用 safe fetch
- [x] ripgrep/fallback regex/cloudflared command timeout + output/process-tree budget
- [x] bash timeout TERM→KILL
- [x] async process shutdown TERM→KILL
- [x] exec/write_stdin non-zero error semantics
- [x] session/process quota + initialize rate limit
- [x] per-MCP-session process scope isolation + global/per-scope capacity + session-close cleanup
- [x] `/healthz` 去除敏感路径

### 阶段 4：工具 metadata、Downstream MCP 与 UI
- 状态: **complete**
- [x] public OAuth2 / local noauth securitySchemes
- [x] 正确 destructive/openWorld annotations
- [x] parent instructions 仅使用本地下游 server key
- [x] listTools 断线 reconnect
- [x] downstream 完整 content 保留
- [x] `mcp.json` 敏感值 env-reference only + Unix 0600 + remote HTTPS policy
- [x] 移除 catalog immutable 保证
- [x] bounded/event-first tool-card polling
- [x] tool-card command/URL secret redaction

### 阶段 5：Cloudflare 与 Windows
- 状态: **complete**
- [x] 独立 `~/.codex-mcp/cloudflared.yml`
- [x] tunnel delete 必须显式 confirmation
- [x] DNS overwrite 必须显式 confirmation
- [x] Windows installer Unicode-safe launcher
- [x] Windows Ctrl-C/force-kill 文档语义修正

### 阶段 6：依赖、CI、文档与最终验证
- 状态: **complete**
- [x] 更新 lockfile，Hono 4.13.0，官方 registry，audit=0
- [x] CI：Ubuntu/Windows/macOS Node22 typecheck/test/build + Linux audit
- [x] test TypeScript 纳入 typecheck
- [x] README OAuth/安全/Cloudflare 更新
- [x] public domain canonical hostname validation（IDN/IP/credentials/非法 label）
- [x] Node 22 本机兼容性 focused verification
- [x] clean `npm ci` 全量回归
- [x] `git diff --check`
- [x] `review.md` 原始 28 项 + 后续 review R-029～R-052 全部 fixed（52/52）
- [x] `progress.md` / `final_report.md` 收口

## 遇到的错误与迭代

| 错误 / 发现 | 尝试次数 | 处理 |
| --- | ---: | --- |
| 初始 checkout 未安装 node_modules，`tsc` 不存在 | 1 | `npm install` 后基线 typecheck/test/build 全通过 |
| 默认 npmmirror 不支持 npm audit API | 1 | 使用官方 npm registry audit；最终 lockfile 也统一官方 registry |
| 初次按 `~/.agents/...` 读取 skill 被按工作区相对路径解析 | 1 | 改用用户主目录下的绝对路径 |
| OAuth E2E assertion message 提前消费 Fetch body | 1 | 使用 `response.clone().text()` |
| `ls` 一次大 patch 因 exact block 不唯一被 edit 工具拒绝 | 1 | 拆成更小精确 patch，无错误写入 |
| tool securitySchemes 顶层字段未出现在 SDK `tools/list` | 1 | 同时写 `_meta.securitySchemes`；随后进一步中央化按 local/public 注入 |
| full test 在 safe webfetch 后仍保留旧 localhost success case | 1 | 改为 SSRF rejection regression |
| 二次 review 发现 dangling symlink 新文件逃逸变体 | 1 | path guard 改用 lstat/readlink canonicalization + regression |
| 最终 OAuth profile review 发现 SDK 将 MCP `resource` 建模为 optional、CIMD schema 会剥离 `client_id` | 1 | provider/state 层强制 MCP profile；新增缺 resource、CIMD mismatch/insecure redirect/unsupported auth method regression |
| 最终 token review 发现 revoke provider 未绑定 authenticated client ownership | 1 | state revoke 接受 clientId 并仅撤销所属 token；双 client E2E 验证跨 client revoke 不生效 |
| test TS 之前未被 typecheck，新增 test config 后暴露 MCP resource union 类型错误 | 1 | text/blob 显式 narrow，保留 test typecheck 门 |
| Node22 第一次临时 typecheck 出现一次不可复现的参数数量报错 | 1 | 立即重跑 source/test typecheck + OAuth/security/tools E2E，全部通过；源码签名一致，未做无依据改动 |
| package-lock-only 未重写历史 npmmirror URL | 2 | 使用 npm `update --package-lock-only --replace-registry-host=always --force` 完整 refresh；最终 npmmirror=0 |
| `private_key_jwt` 的 `jti` 语义在通用 RFC 7523 与 OpenID profile 间一度误读 | 2 | 最终按 `private_key_jwt` 的 OpenID Connect 定义恢复 `jti` REQUIRED；缺失拒绝、`client_id+jti` replay cache，并保留短但唯一 `jti` 可用 regression |
| proxy IP-pinned CONNECT 初测存在瞬时 TLS reset，且项目自身 bounded timeout 不带 errno 导致 fallback 曾提前终止 | 3 | 保持 DoH 公网地址验证 + IP pinning，不降级 hostname-only CONNECT；复用 bounded keep-alive proxy agent，并把精确 `Request timed out after <n>ms` 纳入传输级 retry classifier；TLS/证书错误不重试。修复后真实 CIMD 10/10 HTTP 200 |
| Chrome 在旧 `/oauth/approve` flow 中首次提交后没有进入 ChatGPT callback，再次点击显示 pending 已过期 | 2 | 第一轮确认 `form-action` 会约束 302 链；真实复测仍不稳定后对照 DevSpace，最终删除 `/oauth/approve`/`pending_id`，改为 SDK 原生 GET/POST `/authorize`，POST 时重新校验完整 OAuth 参数并直接 302 callback；CSP 不再设置 `form-action` |
| ChatGPT 授权成功后 `/token` 报 `unexpected "aud" claim value` | 1 | 发现旧 verifier 把 2026 audience 收紧 draft 当成已生效规范；按正式 RFC 7523/OpenID Core 接受精确 issuer 或 token endpoint audience，拒绝无关/混合 audience，并增加 token/refresh/revoke regression |

## 决策记录

详细见 `decisions.md`。

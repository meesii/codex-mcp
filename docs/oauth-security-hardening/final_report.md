# OAuth 与全量安全整改最终报告

日期：2026-08-07

## 结论

本轮任务已完成。

- 原始 review：**28 / 28 fixed**；后续攻击面与真实 ChatGPT 集成 review **R-029～R-052 也全部 fixed**，合计 **52 / 52 fixed**。
- 公网 MCP：由 noauth 改为 **内置 OAuth Authorization Server 强制保护**。
- 本地调试：`--local` 强制 `127.0.0.1`，不要求 OAuth，并在 tools metadata 中正确声明 noauth。
- 当前分支：生产代码、测试、build、audit、Node22 compatibility 全部通过。
- 未执行 git commit；用户未要求提交。

## 核心安全结果

### 1. 公网 RCE 访问边界

整改前：知道 MCP URL 即可调用 `bash/exec_command`。

整改后：

```text
Internet / ChatGPT
      ↓
OAuth discovery
      ↓
Authorization Code + PKCE S256
      ↓
管理员 Argon2id 密码批准
      ↓
Bearer access token (mcp:tools)
      ↓
/mcp
      ↓
Coding tools
```

未授权 `/mcp` 返回 401 + RFC 9728 Protected Resource Metadata pointer。

### 2. OAuth

已实现：

- 内置单用户 Authorization Server
- `codex-mcp auth`
- Argon2id password hashing
- Authorization Code + PKCE S256 only
- RFC 9207 `iss`
- RFC 9728 Protected Resource Metadata
- CIMD capability + safe metadata fetch（loopback/private SSRF block；metadata `client_id` 必须精确匹配 URL；`client_name` 必填；redirect 仅 HTTPS/loopback HTTP）
- CIMD 支持 public `none` 与 ChatGPT 当前使用的 `private_key_jwt`；AS metadata 广告 RS256；JWKS public-key 验证、`iss=sub=client_id`、`aud` 精确接受当前 AS issuer URL 或 token endpoint URL且拒绝无关/混合 audience、必需 `exp/jti`、可选 `iat`；按 `client_id + jti` 做 assertion replay protection
- `/token` / `/revoke` 使用同一套 `private_key_jwt` client authentication；SDK 1.30 未覆盖的 server-side verification 由项目自有 handler 补齐
- CIMD cache 尊重 `Cache-Control: no-store/max-age`，最大 24h；remote JWKS 有独立 bounded cache + key-rotation refresh
- DCR fallback 仍仅接受 public client + PKCE；不生成/保存 client secret
- DCR issuer binding（跨 issuer 有直接回归）+ 256 client capacity；per-client 10/hour + global 100/day；达到 cap 时安全回收最旧 inactive client
- opaque authorization code / access / refresh token
- 磁盘只持久化 code/access/refresh SHA-256 digest
- access 15m
- auth code 5m one-time
- refresh 30d idle
- refresh rotation
- refresh reuse detection → whole family revoke
- MCP `resource` 强绑定：authorization / authorization-code token / refresh 请求都必须显式携带并匹配当前 MCP resource
- strict scope validation：显式 authorize/refresh scope 必须包含 `mcp:tools`，不做隐式扩权
- token revocation endpoint（E2E 验证 revoked access 返回 401；第二 client 无法跨 client 撤销第一 client token）
- 授权页显示 redirect host + 完整 URI；loopback redirect 显示 impersonation warning；最终使用 SDK 原生 GET/POST `/authorize`，删除 `/oauth/approve`/`pending_id`，POST 时 SDK 重新验证 client/redirect/PKCE/resource 后再执行密码校验并直接 302 callback；CSP 不设置 `form-action`，但继续禁止脚本、frame 与 base URI
- approval/OAuth endpoint rate limit（approval per-client 12/15m + global 60/15m + max-concurrent=2，限制 Argon2 瞬时内存）
- Cloudflare-aware request key，仅 loopback peer 时信任 `CF-Connecting-IP`

E2E 同时验证错误 PKCE verifier、三种缺 `resource` 请求拒绝、raw secret non-persistence、confidential DCR rejection、strict scope、refresh replay/family revoke、cross-client revoke isolation、管理员密码 reset 后旧 access/refresh 在运行中 server 立即失效，以及 Argon2 approval 并发 throttle。新增 `private-key-jwt.test.ts` 覆盖 RS256 code exchange / refresh / revoke、wrong audience、missing-`jti` rejection、短但唯一 `jti`、同 `jti` replay rejection；真实 ChatGPT CIMD 与 JWKS 均通过最终 safe fetch 返回 200，实际 `client.json` 可解析为 `private_key_jwt` 客户端。

### 3. Project root

文件工具从 lexical-only path check 改为 lexical + canonical containment：

- `..` escape
- directory symlink/junction escape
- dangling symlink write-through escape（真实 MCP `write` regression，验证 root 外目标不会被创建）
- symlink cycle
- new target nearest-existing-ancestor canonicalization

均被阻止。

注意：这是文件工具边界，不是 OS sandbox。授权后的 shell 仍以当前系统用户权限运行。

### 4. Network

`webfetch` / CIMD / remote JWKS 共用 `safe-http`：

- loopback/private/link-local/reserved address block
- IPv4 / IPv6 使用独立 BlockList；额外封锁 NAT64/Teredo/ORCHID/6to4/site-local 等特殊 IPv6 前缀
- direct 模式 DNS result validation
- 标准 `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`；macOS 自动读取静态 Secure Web Proxy
- HTTPS proxy 模式先通过独立 DoH 获取并验证全球可路由 A/AAAA，再把受信任系统/环境代理的 CONNECT 固定到已验证公网 IP；Host/TLS SNI/证书始终校验原 hostname；bounded keep-alive agent + 已验证 IP 间有限传输故障转移，包括连接 errno/reset 与项目自身 bounded timeout。HTTP URL 不进入代理路径
- manual redirects，每跳重新验证
- streaming byte limit
- request timeout
- no URL credentials

消除 SSRF、“先完整读入再检查 5MB”的内存问题，以及浏览器可联网但 Node CIMD/JWKS 因本机 DNS/直连路径失败的问题。

### 5. Process / resource governance

- bash timeout：TERM→KILL
- ripgrep probe/search：wall-clock timeout + bounded output + TERM→KILL；Node regex fallback 在 Worker 中执行并有 runtime cap，阻止 ReDoS 卡住主进程
- cloudflared short command/sidecar：统一 bounded output / TERM→KILL lifecycle
- cloudflared ready 后追加公网 end-to-end instance probe；DNS 指向其它 tunnel/Worker/旧实例时 fail-closed
- process group/tree termination
- async server shutdown
- ProcessSessionManager running process cap
- MCP session cap 32；公网 MCP session 绑定创建它的 OAuth `client_id`
- initialize rate limit
- ProcessSessionManager 全局 max=8、单 MCP session scope max=4；跨 scope processId 不可 poll/kill；transport close 清理本 scope
- non-zero exec/write_stdin = `isError=true`
- bounded shell/ripgrep/read/glob/grep/ls output/scan

### 6. Cloudflare

- codex-mcp config：`~/.codex-mcp/cloudflared.yml`
- 不再覆盖用户全局 `~/.cloudflared/config.yml`
- remote tunnel delete 默认拒绝，必须明确确认
- DNS `--overwrite-dns` 默认拒绝，必须明确确认
- saved `tunnelId` 只有与远端 exact `tunnelName` 查询结果一致时才复用，避免改名后错误连接旧 tunnel
- 文本 tunnel list fallback 使用 exact name 匹配，不再按子串误命中
- 单引号 YAML credentials path 支持 `''` → `'` round-trip

### 7. Downstream MCP

- `mcp.json` 敏感 env/header 只允许 `${ENV_VAR}` 引用，missing env 直接失败；Unix 文件权限收紧为 0600
- remote downstream MCP 默认必须 HTTPS，仅 loopback 允许 HTTP；URL credentials/fragment 拒绝
- parent instructions 只信任本地 `mcp.json` server key
- 不自动注入远端 instructions/title/description/name
- `mcp_tools` 返回当前 catalog，不承诺 immutable
- `listTools` connection closed 自动 reconnect + retry
- downstream initialize/reconnect 显式 15s total timeout；坏 server 标为 `status=error`，不拖住其它并行 downstream
- `mcp_call` 保留完整 MCP content，包括 image 等非 text 内容

### 8. Tool metadata / UI

- public：OAuth2 `mcp:tools`
- local：noauth
- write/edit：destructive + local-only
- bash/exec/write_stdin：destructive + open-world
- process_kill：destructive + local-only
- mcp_tools：read-only + open-world
- mcp_call：destructive + open-world
- tool-card：事件优先，fallback polling 最多约 10 秒，final 后停止；shell command 仅显示 hidden-length label，URL 去 credentials/query/fragment 后显示
- `summary(done=false)` 强制要求非空 `next`，确保继续工作指令始终有下一步

### 9. Windows

- CRLF read→edit 可 round-trip
- Windows `\u0003` 文档明确为 force process-tree termination，不冒充 Unix Ctrl-C
- installer：绝对 Unicode path 放入 UTF-8 `.ps1`，ASCII `.cmd` 只引用相对 launcher

## 测试 / CI

新增或强化：

- `test/oauth.e2e.test.ts`
- `test/security-regressions.test.ts`
- `test/tools.e2e.test.ts`
- `test/mcp-gateway.e2e.test.ts`
- downstream disconnect/rich content fixture
- `tsconfig.test.json`
- `.github/workflows/ci.yml`

CI matrix：

```text
Node 22
├─ Ubuntu
├─ macOS
└─ Windows
```

每个 OS：`npm ci` → typecheck → test → build；Linux 额外 production audit。

## 最终验证

### 当前环境（Node 24.18.0）

```text
npm ci --registry=https://registry.npmjs.org  PASS (120 packages added / 121 audited)
npm run typecheck                             PASS
npm test                                      PASS (6 groups)
npm run build                                 PASS
npm audit --omit=dev                          0 vulnerabilities
git diff --check                              PASS
real ChatGPT CIMD safe fetch + parse          PASS (10/10 HTTP 200, private_key_jwt)
real ChatGPT JWKS safe fetch                  PASS (HTTP 200, RSA/RS256 2048-bit)
final change-surface / untracked review       PASS
```

6 组 test：

```text
user-mcp-config.test.ts       PASS
tools.e2e.test.ts             PASS
mcp-gateway.e2e.test.ts       PASS
security-regressions.test.ts  PASS
private-key-jwt.test.ts       PASS
oauth.e2e.test.ts             PASS
```

### Node 22.23.2 focused compatibility

```text
src TypeScript compile         PASS
test TypeScript compile        PASS
private-key-jwt                PASS
security-regressions           PASS
oauth.e2e                      PASS
```

### Dependency state

```text
@modelcontextprotocol/sdk  1.30.0
@hono/node-server          2.1.0
hono                       4.13.0
@node-rs/argon2            2.0.2
https-proxy-agent          9.1.0
jose                       6.2.8
minimatch                  10.2.6
```

```text
npm audit                  0 vulnerabilities
npmmirror lock URLs        0
npmjs lock URLs            164
```

## Review 结果

完整逐项证据见：

- `review.md`：28 个原始问题 + 后续/真实接入 review R-029～R-052 全部 fixed（52/52）
- `task_plan.md`：全部阶段 complete
- `progress.md`：实现/测试/迭代时间线
- `findings.md`：规范研究与技术发现
- `decisions.md`：架构决策记录

## 明确未包含的工作

本轮**没有**把现有 Streamable HTTP session transport 同时迁移到 MCP 2026-07-28 stateless core。该项是独立 breaking protocol migration，并不是原 review 修复所必需；OAuth discovery/security hardening 已按当前方向实现。

如果未来做该 migration，应单独建立新计划并验证 ChatGPT/SDK interoperability。

## Git 状态

本轮所有改动保留在 working tree，未创建 commit。原因：用户要求完成整改，但没有要求自动提交。

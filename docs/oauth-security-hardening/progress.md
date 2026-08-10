# 进度日志

## 2026-08-07

### 基线与 review

- 打开项目仓库，确认 `main...origin/main` 且初始 working tree clean。
- 阅读 README、package.json、HTTP/MCP、tool、process、downstream、Cloudflare、UI、Windows installer 与全部测试。
- 初始 checkout 无 `node_modules`；安装后基线：
  - `npm run typecheck` PASS
  - `npm test` PASS
  - `npm run build` PASS
- 完成全量 review，确认 28 个问题；用独立 PoC 验证 symlink root escape 与 glob 多层递归 bug。
- 官方 npm audit 确认原 lockfile 的 `hono@4.12.33` moderate advisory。
- 用户选择内置 OAuth Server + 单一管理员密码，并批准整体整改设计。
- 建立 `docs/oauth-security-hardening/`，调整 `.gitignore` 只跟踪该工作目录。

### OAuth / HTTP

- 新增 `src/auth/storage.ts`：原子 owner-only JSON store + async mutex。
- 新增 `src/auth/password-store.ts`：Argon2id 管理员密码，`codex-mcp auth` 无回显设置/重置。
- 新增 `src/auth/oauth-state.ts`：DCR clients、authorization code/access/refresh token digest、resource binding、refresh rotation/replay family revoke、issuer binding。
- 新增 `src/auth/provider.ts`：SDK `OAuthServerProvider`、CIMD client store、DCR cap、授权密码页、RFC9207 `iss`。
- 新增 `src/auth/server.ts`：AS metadata + CIMD flag、SDK auth router、Bearer guard、CF-aware rate limit；最终授权交互采用 SDK 原生 GET/POST `/authorize`，不保留独立 `/oauth/approve`。
- `/mcp` 公网前置 OAuth；无密码公网启动拒绝；`--local` 强制 127.0.0.1 且不要求 OAuth。
- OAuth E2E 覆盖 discovery/DCR/PKCE/密码批准/token/Bearer MCP/refresh/replay revoke/raw token non-persistence。
- 最终攻击者视角复核补齐 MCP profile 强约束：authorization / code token / refresh 都要求 `resource`；CIMD metadata 必须 `client_id` 精确匹配 URL、`client_name` 非空、redirect 仅 HTTPS/loopback HTTP、client auth method 必须是实际支持的 `none` 或 `private_key_jwt`；授权页显示 redirect host/URI + loopback warning。真实 ChatGPT 复测后进一步迁移到 SDK 原生 GET/POST `/authorize`：POST 重新校验完整 OAuth 参数，页面不设置会约束最终 callback 的 `form-action`。
- `/revoke` 增加 client ownership：第二个 client 无法撤销第一个 client 的 token family；E2E 验证 cross-client revoke 后原 access 仍有效。
- CIMD cache 尊重 `Cache-Control: no-store/max-age`，缓存最长 24h；管理员密码 approval 增加 global 60/15m + per-client 12/15m 双层限流。
- 二次 review 将 DCR 固定为 public client + PKCE：拒绝 confidential/default-secret DCR，`oauth-state.json` 不保存任何 client secret；真实 ChatGPT 集成后，CIMD 按标准新增 `private_key_jwt` 公钥 confidential client，不引入 shared secret。
- DCR 注册增加 global 100/day + per-client 10/hour，persisted client 达 256 时只回收无活跃授权/令牌且超过保护窗口的最旧 inactive client；新增 bounded eviction regression。
- scope 语义改为严格模式：显式 authorize/refresh scope 必须包含 `mcp:tools`，不再静默扩权；仅 `offline_access` 均返回 `invalid_scope`。
- 管理员密码 reset 绑定 OAuth credential generation：旧 code/access/refresh 在运行中 server 与重启后都失效；E2E 验证 access=401、refresh=`invalid_grant`。
- Argon2id approval 增加 max-concurrent=2，限制瞬时密码哈希内存；并发 E2E 验证 throttle 429。
- MCP session registry 绑定创建 session 的 OAuth client owner，防跨 client 串 session。

### 文件边界 / 工具 correctness

- `ProjectContext.root` canonicalize。
- `path-guard` 改 lexical + canonical containment，处理 existing/new target、symlink、dangling symlink、cycle。
- `edit`：empty old_string 拒绝；replacement literal callback。
- `read`：streaming、CRLF 保留、80k output budget、line limit。
- `glob`：切换 minimatch；真实 globstar。
- `grep` / ripgrep / `ls`：增加 scan/output/resource budget。
- 回归覆盖 symlink/junction、dangling symlink、`$& $$ $'`、CRLF、多层 glob、大文件 read。

### 网络 / Process

- 新增 `safe-http`：DNS/IP SSRF policy、manual redirect 每跳复核、stream byte cap、timeout。
- ripgrep probe/search 增加 timeout/output budget/TERM→KILL；Node regex fallback 放到 Worker 并设 runtime cap；cloudflared command/sidecar 统一 TERM→KILL。
- `webfetch` / CIMD / remote JWKS 共用 safe-http；支持标准 HTTPS proxy 与 macOS Secure Web Proxy。HTTPS 代理模式先 DoH 获取并验证全球可路由 A/AAAA，再把 CONNECT 固定到已验证公网 IP，同时用原 hostname 做 Host/TLS SNI/证书校验；复用 bounded keep-alive proxy agent，仅对连接 reset、网络 errno 与项目自身 bounded timeout 等传输错误在已验证 IP 间有限故障转移。HTTP URL 不走代理，SSRF/redirect/size/timeout 边界逐跳保留。
- 新增 process-tree helper；bash timeout TERM→KILL；ProcessSessionManager 全局 max=8 + 每 MCP session scope max=4 + async shutdown；跨 scope processId 不可 poll/kill，transport close 自动清理本 scope；exec/write_stdin non-zero = MCP error。
- MCP session max=32；initialize rate limit；healthz 仅 `{ok:true}`。
- security regressions 覆盖 IPv4/IPv6/private SSRF、byte limit、process/session quota、shutdown、public-without-password refusal。
- 二次 SSRF review 扩展 IPv6 deny ranges：NAT64、discard-only、Teredo/ORCHID、benchmark、6to4、documentation/site-local 等特殊前缀均拒绝。

### Downstream / UI / Metadata

- Tool security schemes 改中央按 server config 注入：public OAuth2 / local noauth。
- destructive/openWorld annotations 恢复真实语义。
- Downstream parent instructions 只使用本地 `mcp.json` server key，不自动信任远端 instructions/title/description/name。
- `mcp_call` 保留下游原始 MCP content；fixture rich tool 验证 image + text。
- `mcp_tools` list 断线 reconnect；fixture disconnect tool E2E 验证。
- 删除 catalog immutable/once-per-server 保证。
- Tool card 从永久 4Hz polling 改 event-first + 最多约 10s fallback + final stop；shell command 在 UI 中只显示长度，URL 去 credentials/query/fragment，避免 bearer/signed-URL secret 泄漏。
- `mcp.json` 敏感 env/header 只允许 `${ENV_VAR}`，missing env 启动失败；Unix 文件权限收紧到 0600；remote HTTP 仅允许 loopback，其余必须 HTTPS。

### Cloudflare / Windows

- cloudflared config 改为 `~/.codex-mcp/cloudflared.yml`。
- remote tunnel delete 与 DNS overwrite 提取 explicit confirmation boundary，默认 false；测试 deny/allow。
- Windows installer 改 UTF-8 `.ps1` absolute-path launcher + ASCII relative `.cmd` shim。
- write_stdin 文档明确 Unix SIGINT / Windows force tree termination。

### Dependency / CI / Docs

- 新增 `@node-rs/argon2@2.0.2`、`minimatch@10.2.6`；`@modelcontextprotocol/sdk` 最低依赖提升为 `^1.30.0`，与实际 OAuth/CIMD API 使用保持一致。
- 真实 ChatGPT 集成新增 `jose`（RS256/JWT/JWKS verification）与 `https-proxy-agent`（标准/macOS HTTPS proxy transport）；未保留不需要的 `http-proxy-agent`。
- npm full lock refresh；`hono@4.13.0`，package-lock 全部官方 npm registry URL。
- `npm audit --omit=dev --registry=https://registry.npmjs.org` = 0 vulnerabilities。
- 新 `.github/workflows/ci.yml`：Node22 × Ubuntu/macOS/Windows；typecheck/test/build；Linux audit。
- 新 `tsconfig.test.json`；`npm run typecheck` 同时检查 src + tests。
- README 全面切换 OAuth、安全、Cloudflare、local mode、新测试模型。
- `normalizeHostname()` 改为 URL/DNS canonical validation：IDN 转 punycode；拒绝 IP/localhost、credentials、非 HTTP(S) 与非法 DNS label；配置测试覆盖。

## 最终验证结果

### 当前 Node 24 环境 clean-install release chain

```text
npm ci --registry=https://registry.npmjs.org      PASS
npm run typecheck                                 PASS
npm test                                          PASS
  user-mcp-config.test.ts                         PASS
  tools.e2e.test.ts                               PASS
  mcp-gateway.e2e.test.ts                         PASS
  security-regressions.test.ts                    PASS
  private-key-jwt.test.ts                         PASS
  oauth.e2e.test.ts                               PASS
npm run build                                     PASS
npm audit --omit=dev --registry=https://registry.npmjs.org
                                                    0 vulnerabilities
git diff --check                                  PASS
```

### Node 22 focused compatibility

使用临时 `node@22` runtime：

```text
Node                                                    v22.23.2
source tsc                                              PASS
test tsc                                                PASS
private-key-jwt                                         PASS
security-regressions                                    PASS
oauth.e2e                                               PASS
tools.e2e                                               PASS
```

第一次 Node22 source tsc 曾出现一次无法复现的参数数量错误；立即对当前源码重复 source/test tsc 及关键 E2E，全部持续通过，因此没有针对不存在的错误做猜测式代码修改。

### 最终依赖

```text
@modelcontextprotocol/sdk  1.30.0
@hono/node-server          2.1.0
hono                       4.13.0
@node-rs/argon2            2.0.2
https-proxy-agent          9.1.0
jose                       6.2.8
minimatch                  10.2.6
```

package-lock registry：

```text
registry.npmmirror.com  0
registry.npmjs.org      164
```

## 状态

- 原 review：28 / 28 fixed。
- 后续攻击面与残留一致性 review：R-029～R-043 全部 fixed；真实 ChatGPT 集成新增 R-044～R-052（`private_key_jwt`、代理/DNS-safe CIMD/JWKS、BlockList cross-family、tunnel end-to-end route verification、OpenID `private_key_jwt` 必需 `jti`、proxy bounded-timeout retry、Chrome OAuth callback CSP、router-native authorize flow、token-endpoint audience）也全部 fixed。
- Task plan：全部阶段 complete。
- 最终 Git diff 清单核对：PASS；仅包含本次整改相关源码、测试、CI、README 与工作记录。
- 最终多轮攻击面 review 与真实接入新增发现（dangling symlink write-through、MCP `resource` 必填、CIMD metadata、`private_key_jwt`/JWKS/assertion replay/audience、cross-client revoke、DCR secret/state DoS、OAuth scope、代理/DNS-safe HTTP 与 bounded-timeout retry、IPv4/IPv6 BlockList isolation、domain validation、password reset grant、Argon2 并发、MCP/session process ownership、downstream secret/HTTP、regex/subprocess DoS、UI secret leakage、Cloudflare tunnel/YAML 与公网 route postcondition、downstream timeout、summary invariant）均已修复并有 regression。
- 最终 clean-install 验收再次执行：`npm ci` 添加 120 packages / audit 121 packages；随后 typecheck、6 组 tests、build、production audit、`git diff --check` 全 PASS，audit=0 vulnerabilities。R-049 修复后真实 ChatGPT CIMD focused probe **10/10 HTTP 200** 且每次都解析为 `private_key_jwt` client；JWKS HTTP 200，RSA/RS256、2048-bit。公网 tunnel 是否在线属于运行态，源码验收不以 tunnel 常驻为前提。
- 最终 change-surface/untracked 核对 PASS；未发现任务外源码/测试/patch 临时文件。两个本机 `.DS_Store` 已被 Git 忽略，不进入变更集。
- 剩余工作：无。

# Review 问题清单与修复追踪

本文件是 2026-08-07 全量 review 的最终问题台账。`fixed` 表示已有代码修复，并具备自动测试、focused executable check 或发布级验证证据。

| ID | 严重度 | 问题 | 状态 | 修复 / 证据 |
| --- | --- | --- | --- | --- |
| R-001 | Critical | 公网 noauth + shell = RCE | **fixed** | 公网 `oauthRequired=true`；`/mcp` 前置 SDK Bearer guard；无管理员密码拒绝 listen。`oauth.e2e` 验证未授权 401 + PRM、完整 OAuth 后 Bearer MCP 成功；`security-regressions` 验证无密码拒绝公网启动。 |
| R-002 | Critical | destructive/openWorld annotations 低报风险 | **fixed** | write/edit destructive=true；bash/exec/write_stdin destructive=true/openWorld=true；process_kill destructive=true/openWorld=false；mcp_tools readOnly=true/openWorld=true；mcp_call destructive=true/openWorld=true。E2E 验证 annotations。security scheme 由 server config 中央注入：公网 OAuth2，本地 noauth。 |
| R-003 | Critical | symlink 绕过 project root | **fixed** | `path-guard` 改 canonical containment；existing/new target 都 canonicalize，含 dangling symlink 与 cycle 防护。`tools.e2e` 验证 read/write/edit/ls directory link escape；`security-regressions` 真实创建指向 root 外、目标尚不存在的 dangling symlink，验证 MCP `write` 拒绝且外部目标未创建。 |
| R-004 | High | 覆盖全局 `~/.cloudflared/config.yml` | **fixed** | 改为 `~/.codex-mcp/cloudflared.yml`；`security-regressions` 验证路径。 |
| R-005 | High | credentials 丢失自动 delete 远端 tunnel | **fixed** | `requireTunnelDeleteConfirmation()` 默认 false；未显式批准直接拒绝。`security-regressions` fake confirmer 验证 deny/allow。 |
| R-006 | High | DNS 冲突自动 overwrite | **fixed** | `requireDnsOverwriteConfirmation()` 默认 false；未显式批准拒绝 `--overwrite-dns`。`security-regressions` 验证 deny/allow。 |
| R-007 | High | `--local` 可监听 `0.0.0.0` | **fixed** | `loadConfig(local=true)` 无条件 host=`127.0.0.1`。`security-regressions` 输入用户 host `0.0.0.0` 验证结果。 |
| R-008 | High | session/process 无资源配额 | **fixed** | MCP max sessions=32、initialize 60/15m/client；ProcessSessionManager max running=8。`security-regressions` 验证第 33 个 MCP session 与超额 process 被拒绝。 |
| R-009 | High | edit replacement `$&/$'/$$` 非 literal | **fixed** | `replace(old, () => newString)`；`tools.e2e` 用 `$& $$ $'` 验证字面写入。 |
| R-010 | High | CRLF read→edit 不兼容 | **fixed** | `read` streaming 且保留原始 LF/CRLF；`tools.e2e` 验证 CRLF 多行 read 输出可直接作为 `old_string` edit。 |
| R-011 | High | `**` glob 多层递归错误 | **fixed** | 删除自制 glob parser，使用 `minimatch`；`tools.e2e` 验证 `deep/nested/deep.ts` 命中 `**/*.ts`。 |
| R-012 | High | bash timeout 无 SIGKILL escalation | **fixed** | Unix timeout TERM→2s→KILL；Windows force tree kill。`tools.e2e` 使用忽略 TERM 的 shell 验证有限时间退出且 `timedOut=true`。 |
| R-013 | High | shutdown 可能遗留子进程 | **fixed** | `ProcessSessionManager.shutdown()` async 并复用 TERM→KILL kill 流程；HTTP close await shutdown。`security-regressions` 验证 shutdown 后 processId 消失。 |
| R-014 | High | exec/write_stdin 非零退出仍 success | **fixed** | finished non-zero/signal 返回 `isError=true` 且保留 structuredContent。`tools.e2e` 验证 `exec_command exit 9`。 |
| R-015 | High | webfetch 先全量读入再检查 5MB | **fixed** | 新 `safe-http` 按 stream chunk 计 byte，Content-Length 仅作提前拒绝。`security-regressions` 用本机大响应 + `allowPrivate` 测试 1KB hard cap。 |
| R-016 | High | webfetch SSRF / redirect SSRF | **fixed** | DNS/IP validation、loopback/private/link-local/reserved block、manual redirect 每跳重验。`security-regressions` 验证 IPv4/IPv6/private block；`tools.e2e` 验证 loopback webfetch 被拒。 |
| R-017 | High | downstream 合法非 text content 丢失 | **fixed** | `mcp_call` 透传原 `result.content`。fixture `rich` 返回 text+image；`mcp-gateway.e2e` 验证两种 content 均存在。 |
| R-018 | Medium | downstream catalog immutable 错误保证 | **fixed** | 删除 immutable/once-per-server 文案；`mcp_tools` 每次真实 list，无 catalog cache。E2E 检查 descriptor 不含旧保证。 |
| R-019 | Medium | downstream instructions 注入上层 instructions | **fixed** | 顶层 instructions 只使用本地 `mcp.json` server key；远端 instructions/title/description/name 均不自动注入。fixture 故意带 `Tiny echo MCP...`，E2E 验证 parent instructions 不包含它。 |
| R-020 | Medium | downstream listTools 断线不 reconnect | **fixed** | `listTools` connection-closed → reconnect → retry。fixture `disconnect` 主动退出；E2E 随后 `mcp_tools` 成功重新列出工具。 |
| R-021 | Medium | tool-card 永久 4Hz polling | **fixed** | event-first，fallback 最多 40×250ms；final result 清 timer，hidden 时不 poll。`tools.e2e` 静态验证 card HTML 不再存在永久 `setInterval(readHost,250)` 且有 bounded attempts。 |
| R-022 | Medium | read limit 不是 I/O limit | **fixed** | `readFile` 改 `createReadStream`，按 requested lines/80k output budget 提前停止。`tools.e2e` 120k 单行文件验证 `truncated=true` 且输出 <81k。 |
| R-023 | Medium | edit 空 old_string | **fixed** | schema `z.string().min(1)`；`tools.e2e` 验证空 old_string 被 tool validation 拒绝。 |
| R-024 | Medium | healthz 泄露 projectRoot | **fixed** | `/healthz` 仅 `{ok:true}`；`security-regressions` 精确断言。 |
| R-025 | Medium | Windows `\u0003` 文档与实际强杀不一致 | **fixed** | tool description/代码注释明确 Unix=SIGINT、Windows=force process-tree termination；`tools.e2e` 验证 descriptor 文案。 |
| R-026 | Medium | Windows installer ASCII 损坏 Unicode path | **fixed** | 绝对 `distCli` 放入 UTF-8 `.ps1` launcher；ASCII `.cmd` 只引用相对 `%~dp0codex-mcp.ps1`。`security-regressions` 验证结构；CI 在 Windows 运行项目测试。 |
| R-027 | Medium | 生产依赖 hono advisory | **fixed** | lock refresh 后 `hono@4.13.0`；官方 registry `npm audit --omit=dev` = 0 vulnerabilities。 |
| R-028 | Medium | 缺 CI / 安全边界回归测试 | **fixed** | 新 `.github/workflows/ci.yml`：Ubuntu/macOS/Windows + Node22，`npm ci/typecheck/test/build`，Linux audit；增加 OAuth/security/downstream/tool 回归；`typecheck` 现在同时编译 src + test。 |

## 二次 review 新增项

| ID | 严重度 | 问题 | 状态 | 修复 / 证据 |
| --- | --- | --- | --- | --- |
| R-029 | High | DCR confidential client 会生成并明文持久化 `client_secret`，且与本项目 PKCE-only DCR 模型不匹配 | **fixed** | DCR 只接受 `token_endpoint_auth_method="none"` 的 public client；状态文件不保存 client secret。OAuth E2E 验证未声明 public client 的 DCR 被 `invalid_client_metadata` 拒绝，并断言 `oauth-state.json` 不含 `client_secret`。CIMD 的标准 `private_key_jwt` confidential client 走公钥认证，不生成或保存 shared secret（见 R-044）。 |
| R-030 | Medium | DCR persisted client 表可被长期填满形成注册 DoS | **fixed** | 注册 endpoint 增加 global 100/day + per-client 10/hour 限流；达到 256 client cap 时仅回收无 code/access/active refresh 且超过保护窗口的最旧 inactive client。`security-regressions` 验证 bounded eviction。 |
| R-031 | Medium | SSRF IPv6 policy 未覆盖 NAT64/Teredo/6to4/site-local 等特殊前缀 | **fixed** | `safe-http` 只允许全球可路由目标，新增 NAT64、discard-only、Teredo/ORCHID、benchmark、6to4、documentation/site-local 等 IPv6 block ranges；`security-regressions` 逐项断言。 |
| R-032 | Medium | OAuth 显式 scope 缺 `mcp:tools` 时会被自动扩权；refresh 校验结果未真正传给 state | **fixed** | `normalizeScopes()` 改为严格要求 `mcp:tools`，不再静默补权限；refresh 使用 normalized scope。OAuth E2E 验证 authorize/refresh 仅请求 `offline_access` 均返回 `invalid_scope`。 |
| R-033 | Medium | 公网 domain 输入校验宽松，非法 host 可延迟到 URL/Host/OAuth 阶段才失败 | **fixed** | `normalizeHostname()` 改 URL 解析 + IDN canonicalization，拒绝 IP/localhost、凭据、非 HTTP(S)、非法 DNS label；`user-mcp-config.test.ts` 覆盖合法规范化与无效输入。 |
| R-034 | High | 重置管理员密码不会撤销既有 OAuth code/access/refresh grant | **fixed** | 每次授权码/token 记录绑定由 Argon2id PHC hash 派生的 credential generation；`codex-mcp auth` 重设密码（即使同密码因随机 salt 也会换 generation）后，运行中与重启后的旧 grant 都失效。批准流程从“同一次被验证的 PHC hash”返回 generation，避免旧密码校验与新 epoch 配对的 reset race。OAuth E2E 在不重启 server 的情况下验证旧 access=401、旧 refresh=`invalid_grant`。 |
| R-035 | Medium | Argon2id 单次约 64 MiB，只有频率限制但无并发限制时可瞬时放大内存 | **fixed** | POST `/authorize` 最多 2 个并发密码校验，叠加 per-client 12/15m + global 60/15m；OAuth E2E 并发 5 个错误批准请求验证至少一个 429。 |
| R-036 | Medium | MCP session ID 未绑定 OAuth client，可被另一个已授权 client 串会话 | **fixed** | `McpSessionRegistry` 保存 `ownerClientId`；公网 session 创建/访问均匹配当前 bearer `client_id`，不匹配按 unknown session 处理；`security-regressions` 直接验证 owner isolation。 |
| R-037 | High | `ProcessSessionManager` 跨 MCP session 共享、processId 易猜，可跨会话 poll/kill | **fixed** | root manager 保留全局 8 进程容量；每个 MCP session 创建独立 process scope（最多 4 个），poll/kill 仅能访问同 scope process；transport close 自动清该 scope，server shutdown 清全部。`security-regressions` 验证跨 scope poll/kill 均 `Unknown processId`。 |
| R-038 | High | `mcp.json` 示例/解析允许敏感 token/header 明文落盘，远程 downstream URL 也未限制明文 HTTP | **fixed** | 敏感 env/header key 必须使用 `${ENV_VAR}`；缺失环境变量启动失败；Unix 加载时收紧 `mcp.json` 为 0600；remote MCP 默认 HTTPS，仅 loopback 可 HTTP，并拒绝 URL credentials/fragment。`user-mcp-config.test.ts` 覆盖明文 secret、missing env、HTTP remote rejection 与 env expansion。 |
| R-039 | Medium | ripgrep/Node regex fallback/cloudflared helper 可能被 pathological regex、无响应子进程或超量输出拖挂 | **fixed** | ripgrep probe/search 增加 wall-clock timeout、output budget、TERM→KILL；Node fallback regex 放进 Worker 并设 5s 上限；cloudflared short commands/sidecar 复用 process-tree TERM→KILL。`security-regressions` 验证忽略 TERM 的 rg/cloudflared 与 `(a+)+$` fallback ReDoS 都在有限时间返回。 |
| R-040 | Medium | MCP Apps tool card 会显示完整 shell command / URL query，可能把 bearer token、signed URL 等敏感值暴露到 UI | **fixed** | shell command 在 UI summary/args 中只显示字符长度并标记 hidden；URL 去除 username/password/query/fragment 后再显示。`security-regressions` 使用 `Authorization: Bearer super-secret-token` 与 `?access_token=...` 精确断言 UI 数据不含 secret。 |
| R-041 | Medium | Cloudflare 本地缓存 tunnelId 可能与当前 tunnelName 不一致；文本 list fallback 使用子串匹配；单引号 YAML credentials path 不完整 round-trip | **fixed** | `ensureTunnelCreated()` 仅在 saved id 与远端同名 tunnel id 一致时复用；文本 fallback 改 exact-name 匹配；YAML 单引号读取反解 `''`。`security-regressions` 验证 `codex-mcp-prod` 不误匹配 `codex-mcp`，并验证含 apostrophe 的 credentials path 完整 round-trip。 |
| R-042 | Low | 坏的 downstream MCP initialize 可使用 SDK 默认 60s timeout，拖慢整个 codex-mcp 启动/重连 | **fixed** | Downstream initialize/reconnect 显式 `timeout=maxTotalTimeout=15s`；失败 server 继续保留为 `status=error`，其它 downstream 并行连接不受影响。 |
| R-043 | Low | `summary` 描述要求 `done=false` 提供 `next`，handler 却允许缺失，导致“继续工作”没有下一步 invariant | **fixed** | `done=false && !next` 返回 MCP error；`tools.e2e` 增加缺 `next` regression。 |
| R-044 | High | 真实 ChatGPT CIMD 使用 `token_endpoint_auth_method=private_key_jwt`，旧实现仅接受 `none`，导致 `/authorize` 返回 `invalid_client`；SDK 1.30 服务端 token/revoke middleware 本身也不会验证 private-key assertion | **fixed** | CIMD 新增标准 `private_key_jwt`：仅 RS256，`jwks`/`jwks_uri` 公钥验证，`iss=sub=client_id`，必需 `exp/jti`、可选 `iat`；audience 最终按 R-052 对齐正式 RFC/OpenID 规则；自定义 `/token`/`/revoke` client-auth handler 完整验证 assertion，DCR 仍保持 public-only。`private-key-jwt.test.ts` 覆盖 code exchange / refresh / revoke / replay / missing-jti / wrong-aud；真实 ChatGPT CIMD+JWKS 现场 fetch/parse 成功。 |
| R-045 | High | macOS 浏览器通过系统 HTTPS proxy 可访问 ChatGPT，但 `safeHttpGet` 直连 Node DNS/HTTPS；在本机 DNS 被污染/直连受阻时 CIMD/JWKS 抓取超时并被折叠成 `invalid_client` | **fixed** | safe HTTP 支持标准 `HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`，macOS 自动读取静态 Secure Web Proxy；HTTPS 代理模式先经独立 DoH 验证目标 A/AAAA 都是全球可路由地址，再把 proxy CONNECT 固定到已验证公网 IP，同时以原 hostname 执行 Host/TLS SNI/证书校验；bounded keep-alive proxy agent + 仅连接 reset/timeout 等传输故障的有限 IP 故障转移。redirect/size/timeout policy 保持逐跳执行，HTTP URL 不走该代理路径。真实 ChatGPT CIMD/JWKS 通过最终实现稳定返回 200。 |
| R-046 | Medium | 单个 Node `BlockList` 同时加入 IPv4/IPv6 subnet 后产生 cross-family false positive，公网 Cloudflare IPv4 `172.64.155.209` 被误判为 reserved | **fixed** | IPv4 / IPv6 deny ranges 拆成独立 `BlockList`，`assertPublicAddress("172.64.155.209")` 新增 regression，同时保留全部特殊 IPv6 deny 测试。 |
| R-047 | Medium | `cloudflared tunnel route dns`/edge registration 成功不能证明公网 hostname 最终落到当前 tunnel；真实现场 DNS 曾指向另一个 tunnel，CLI 仍显示 ready，随后 ChatGPT 收到误导性 OAuth 错误 | **fixed** | HTTP server 生成每进程高熵 probe path + 独立随机响应；sidecar 注册后 CLI 必须经公网 hostname 回环并精确匹配当前实例，失败则停止 sidecar/server 并明确报告 DNS/Worker/tunnel route 错配。`security-regressions` 覆盖正确实例通过、错误实例响应失败。 |
| R-048 | Medium | 最终标准复核一度把通用 RFC 7523 的 optional `jti` 规则误套到 OpenID Connect `private_key_jwt`，导致中间实现允许无 `jti` assertion；但 `private_key_jwt` 的定义明确要求 `jti` REQUIRED | **fixed** | 恢复 `private_key_jwt` 必需 `jti`；缺失直接 `invalid_client`，重放缓存按 `client_id + jti` 保持到 assertion 失效；不额外要求非标准最小熵，只要求非空并设实现级长度上限。`private-key-jwt.test.ts` 覆盖 missing-jti rejection、同 `jti` replay rejection 与短但唯一 `jti` 可用。 |
| R-049 | Medium | IP-pinned proxy fallback 虽配置了多目标重试，但 `finishRequest()` 自己产生的 bounded timeout 没有 Node errno，retry classifier 只看 `ECONNRESET/ETIMEDOUT` 等 code，导致第一次内部 timeout 直接终止，真实 CIMD 抓取出现间歇失败 | **fixed** | retry classifier 显式识别项目自身精确格式的 `Request timed out after <n>ms` 传输错误，同时 TLS/证书/HTTP validation 错误仍 fail-closed；`security-regressions` 直接断言内部 timeout 可重试、证书错误不可重试。修复后真实 ChatGPT CIMD focused probe 10/10 HTTP 200。 |
| R-050 | High | OAuth 授权页 CSP 使用 `form-action 'self'`。Chrome 会继续对表单提交后的 302 重定向执行 `form-action` 检查，因此旧 `/oauth/approve` flow 可出现服务端已签发 code、浏览器却不完成 callback 的半成功状态 | **fixed** | 最终 R-051 架构不再设置 `form-action`，保留 `default-src 'none'` / `frame-ancestors 'none'` / `base-uri 'none'`；页面无脚本且 form action 固定到 `/authorize`。这消除了 CSP 对 OAuth callback 导航链的限制，而不是继续扩展 callback origin allow-list。 |
| R-051 | High | 独立 `/oauth/approve` + 内存 `pending_id` 把 SDK 原生 authorization lifecycle 拆成两层；真实 ChatGPT 复测在动态 CSP 修复后仍未稳定完成浏览器 callback，并且首次成功提交会消费 pending state，使重试变成“授权请求已过期” | **fixed** | 对照 DevSpace 后迁移到 SDK 原生 GET/POST `/authorize`：GET 渲染表单和完整 OAuth hidden fields；POST 时 SDK 再校验 `client_id/redirect_uri/PKCE/resource`，provider 验证 Argon2id 密码后创建 code 并直接 302 callback。删除 `/oauth/approve`、`pending_id` 和 pending Map；原 per-client/global/max-concurrent 密码治理迁移到 POST `/authorize` middleware。OAuth E2E 断言旧 endpoint=404、无 pending 字段、错误密码=401、并发限流=429、正确密码=302+code/state/iss；全量 typecheck/test/build/diff-check PASS。 |
| R-052 | High | 真实 ChatGPT 在 `/token` 使用的 `private_key_jwt` assertion 把 token endpoint URL 作为 `aud`，旧 verifier 却把 2026 audience 收紧 draft 当成已生效规范，强制 `aud` 唯一等于 AS issuer，导致授权成功后 `/token` 报 `invalid_client` / `unexpected "aud" claim value` | **fixed** | 按正式 RFC 7523 与 OpenID Connect Core 接受两个精确 AS audience：issuer URL 和 token endpoint URL；若 `aud` 为数组，只允许由这两个值组成，任何无关 audience（包括与合法 audience 混合）都拒绝。`private-key-jwt.test.ts` 新增 token-endpoint audience success、issuer+token dual audience success、unrelated/mixed audience rejection，并让 code exchange / refresh / revoke 使用 token-endpoint audience。 |

## OAuth 新增安全验收

| 项目 | 结果 |
| --- | --- |
| Authorization Code + PKCE S256 | PASS；错误 verifier=400 `invalid_grant`，随后正确 verifier 仍可兑换 |
| RFC 9728 PRM + 401 `WWW-Authenticate` | PASS |
| RFC 9207 `iss` | PASS；callback 精确断言 issuer |
| CIMD capability | PASS；AS metadata 宣告 `client_id_metadata_document_supported=true`；CIMD 支持 `none` 与标准 `private_key_jwt`；直接 regression 验证 loopback CIMD client_id 被 safe-http 拒绝；metadata `client_id` 必须与 URL 完全一致、`client_name` 必填、redirect 仅 HTTPS/loopback HTTP；CIMD cache 尊重 `Cache-Control: no-store/max-age`（最长 24h） |
| `private_key_jwt` client auth | PASS；AS metadata 广告 `private_key_jwt` + RS256；JWKS 仅接受公钥且 RSA≥2048；`aud` 精确接受 AS issuer 或 token endpoint 且拒绝无关/混合 audience；`iss/sub`、必需 `exp/jti`、可选 `iat`、`client_id+jti` replay protection；token/refresh/revoke 全链 regression + 真实 ChatGPT CIMD/JWKS fetch/parse |
| DCR compatibility | PASS；DCR 仅 public client + PKCE；confidential/default-secret DCR 被拒绝，state 不持久化 client secret；public client E2E 注册/授权/refresh |
| DCR issuer binding | PASS；直接 regression 使用 issuer A 注册、issuer B 查询得到 undefined |
| DCR growth bound | PASS；最多 256 persisted DCR clients；per-client 10/hour + global 100/day registration rate limit；达到 cap 时只回收无活跃授权/令牌且超过保护窗口的最旧 inactive client。`security-regressions` 验证 bounded eviction。 |
| Admin password storage | PASS；Argon2id PHC hash，E2E 断言 auth.json 不含明文密码；密码 reset 改变 credential generation 并立即使旧 code/access/refresh grant 失效 |
| Opaque token storage | PASS；E2E 断言 oauth-state 不含 raw code/access/refresh token |
| Access resource binding | PASS；authorization request、authorization-code token request、refresh request 都必须显式携带并匹配 MCP `resource`；access verify 再校验 resource URL + `mcp:tools`。E2E 对三种缺 `resource` 请求均验证拒绝。 |
| Scope semantics | PASS；显式授权/refresh scope 必须包含 `mcp:tools`，不会静默扩大权限；仅 `offline_access` 返回 `invalid_scope`。 |
| Refresh rotation | PASS |
| Refresh replay family revoke | PASS；旧 refresh 重放后 rotated access 也返回 401 |
| OAuth endpoint rate limit | PASS；Cloudflare-aware client key，仅 loopback peer 时信任 `CF-Connecting-IP`；管理员密码 approval 同时有 per-client 12/15m、global 60/15m 和 max-concurrent=2；E2E 验证并发 throttle |
| Public startup without password | PASS；拒绝 listen，不降级 noauth |
| Revocation ownership | PASS；E2E 用第二个 DCR client 调 `/revoke` 尝试撤销第一 client 的 refresh token，endpoint 幂等 200，但第一 client 的 rotated access 仍可建立 MCP 连接 |
| Authorization UX | PASS；授权页显示 redirect host/完整 URI；loopback callback 显示额外 impersonation warning；SDK 原生 GET/POST `/authorize`，无 `/oauth/approve`/`pending_id`；页面无脚本、固定 self form action，CSP 不设置 `form-action` 以避免限制最终 OAuth 302 callback |
| Tunnel route postcondition | PASS；sidecar edge registration 后从公网 hostname 命中每进程随机 probe 并匹配独立随机响应；错 tunnel/Worker/旧实例直接启动失败 |
| Local mode | PASS；127.0.0.1 only，HTTP 不要求 OAuth，tool metadata=noauth |

## 最终结论

截至本轮真实 ChatGPT 集成复核，原 review 的 28 个问题全部关闭；后续攻击面与残留一致性 review R-029～R-043，以及真实接入新增 R-044～R-052 也全部关闭。共 **52 / 52 fixed**，没有遗留 `open` 项。

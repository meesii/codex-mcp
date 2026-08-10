# 技术决策记录

## ADR-001：内置单用户 OAuth Authorization Server

- 日期：2026-08-07
- 状态：accepted
- 决策：codex-mcp 自己承载 OAuth Authorization Server，并以单一管理员密码完成用户认证。
- 原因：用户明确选择内置 OAuth；项目定位为个人单机服务，不需要多用户 IAM。
- 后果：项目必须自己负责授权码、PKCE、token 生命周期、client metadata、密码存储、rate limit 与 OAuth 安全测试。

## ADR-002：Opaque Token，而非 JWT

- 状态：accepted
- 决策：access token / refresh token 为高熵随机 opaque token，磁盘仅持久化 SHA-256 digest 和 metadata。
- 原因：AS 与 RS 同进程/同机，JWT 自包含验证没有扩展收益，反而引入 signing key/JWKS/rotation 管理。
- 生命周期：access 15 分钟；authorization code 5 分钟一次性；refresh 30 天 idle + rotation/reuse detection。

## ADR-003：CIMD 优先，DCR fallback

- 状态：accepted
- 决策：Authorization Server Metadata 宣告 CIMD 支持；当 client_id 是 HTTPS URL 时使用 Client ID Metadata Document；同时保留标准 `/register` endpoint 兼容 DCR。
- 原因：MCP 2026-07-28 已正式将 DCR 标记 deprecated，但现有客户端兼容不能一次切断。

## ADR-004：公网 OAuth mandatory，本地调试例外

- 状态：accepted
- 决策：存在公网 domain 的正常 serve 模式必须认证；`--local` 强制绑定 `127.0.0.1`，可无 OAuth用于 Inspector/test。
- 原因：既保留本地开发体验，又消除公网 noauth RCE。

## ADR-005：保留现有 MCP transport

- 状态：accepted
- 决策：本次不迁移 MCP 2026-07-28 stateless core。
- 原因：这是独立 breaking migration；本次目标已经包含 OAuth 与全量安全整改，混入 transport 重写会显著扩大回归面。

## ADR-006：安全 HTTP fetch 作为共用基础设施

- 状态：accepted
- 决策：新增统一 safe fetch 层给 `webfetch` 与 CIMD metadata 使用：DNS/IP policy、private/link-local/loopback block、manual redirect 每跳复查、stream byte limit、timeout。
- 原因：两处都有相同 SSRF/资源限制要求，单独实现容易产生策略漂移。

## ADR-007：Cloudflare 配置隔离

- 状态：accepted
- 决策：codex-mcp 只管理 `~/.codex-mcp/cloudflared.yml`，不再改写用户全局 `~/.cloudflared/config.yml`。
- 原因：避免破坏其它 tunnel/ingress；现有 sidecar 已支持 `--config` 自定义路径。

## ADR-008：风险 metadata 真实声明

- 状态：accepted
- 决策：不再为了减少 host confirmation 而将 destructive tools 标成非 destructive。shell/downstream proxy 同时声明 open-world 风险。
- 原因：安全 metadata 必须表达真实能力，approval UX 由 host policy 决定。

## ADR-009：Security scheme 由 server instance 中央注入

- 状态：accepted
- 决策：公网 server 的 tools/list 声明 OAuth2 `mcp:tools`；`--local` server 声明 noauth。scheme 不在每个工具文件里静态写死，而由 `config.oauthRequired` 对具体 McpServer 注入。
- 原因：同一进程可以同时存在 local/public server；metadata 必须与实际 HTTP authorization boundary 一致。

## ADR-010：Downstream 自动 instructions 只信任本地 server key

- 状态：accepted
- 决策：初始化 instructions 不采用远端 instructions/title/description/name，只展示本地 `mcp.json` key。远端 tool description/schema 仅在显式 `mcp_tools` 调用后进入模型上下文。
- 原因：所有远端自报 metadata 都属于不可信输入，没必要在 initialize 阶段扩大 prompt injection 面。

## ADR-011：DCR credentials 绑定 issuer

- 状态：accepted
- 决策：持久 DCR client 保存注册时 AS issuer；`clientsStore.getClient()` 只返回当前 issuer 下注册的 client。DCR persisted client 总数限制 256。
- 原因：符合 2026 authorization hardening 的 credential/issuer binding 方向，并阻止匿名 DCR 长期无限增长 state。

## ADR-012：生产与测试 TypeScript 都进入 typecheck

- 状态：accepted
- 决策：新增 `tsconfig.test.json`，`npm run typecheck` 同时编译 `src/**/*.ts` 与 `test/**/*.ts`。
- 原因：`tsx` 运行测试不会执行 TypeScript 静态检查；安全回归本身也应被类型系统约束。

## ADR-013：在 provider 层补齐 SDK 1.30 的 MCP OAuth 强约束

- 状态：accepted
- 决策：即使 SDK 1.30 schema/handler 把 `resource` 等字段定义为 optional，本项目仍按 MCP Authorization 规范强制 authorization request、authorization-code token request、refresh request 都携带并匹配当前 MCP resource；CIMD 必须自带与 metadata URL 完全一致的 `client_id`、非空 `client_name`、HTTPS 或 loopback HTTP redirect，并且 client auth method 必须是本服务实际广告/实现的 `none` 或 `private_key_jwt`。
- 原因：SDK 是通用 OAuth 基础设施，不会自动替本项目落实全部 MCP profile 约束。服务端必须在自己的 trust boundary 明确补齐。
- 附加 UX：授权页显示完整 redirect URI/host；loopback redirect 显示额外警告，降低 localhost impersonation 风险。

## ADR-014：Token revocation 必须绑定 client owner

- 状态：accepted
- 决策：`/revoke` 只撤销属于当前已认证 `client_id` 的 access/refresh token；其它 client 即使拿到 token 字符串也只能得到标准幂等成功，不会造成跨 client token-family DoS。
- 原因：revocation endpoint 的认证主体必须与被撤销 token 的 client ownership 一致。

## ADR-015：DCR 保持 public client；CIMD 支持标准公钥 confidential client

- 状态：accepted（2026-08-07 真实 ChatGPT 集成后修订）
- 决策：DCR 仍只允许 `token_endpoint_auth_method=none` 的 public client，不生成、不保存 `client_secret`。HTTPS CIMD 除 `none` 外允许 `private_key_jwt`，但只使用客户端发布的公开 JWKS 做 RS256 client authentication，不引入 shared secret。DCR 注册继续设置 per-client/global rate limit；达到 256 个 persisted client 时，只淘汰无活跃 code/access/refresh 且超过保护窗口的最旧 inactive client。
- 原因：真实 ChatGPT CIMD 已使用 `private_key_jwt`。正确做法是实现标准公钥客户端认证，而不是把它降级成 `none` 或给 DCR 引入静态 secret。

## ADR-016：OAuth scope 不做隐式扩权

- 状态：accepted
- 决策：authorization/refresh 显式 scope 必须包含 `mcp:tools`；不再自动把缺失的 `mcp:tools` 插入客户端请求。refresh token exchange 使用规范化后的 scope，并继续要求它是原 grant 的子集。
- 原因：Authorization Server 不应扩大客户端明确请求的权限，也不应签发随后无法访问 MCP 的 scope 组合。

## ADR-017：公网网络目标只接受全球可路由地址

- 状态：accepted
- 决策：`safe-http` 除传统 private/loopback/link-local 外，也封锁 IPv6 NAT64、Teredo、ORCHID、benchmark、6to4、documentation/site-local 等特殊前缀；IPv4/IPv6 使用独立 BlockList，避免 Node cross-family false positive。公网 MCP domain 同时经过严格 DNS hostname normalization，拒绝 IP、localhost、credentials 和非法 label。
- 原因：SSRF allow policy 应是“只允许全球可路由目标”，而不是维护一个容易漏项的最小 private denylist；public domain 也必须在进入 Host/OAuth URL 组合前形成确定的 canonical hostname。

## ADR-018：管理员密码 reset 是 OAuth credential epoch 轮换

- 状态：accepted
- 决策：authorization code、access token、refresh token 都绑定由当前 Argon2id PHC hash 派生的不可逆 credential generation。`codex-mcp auth` 每次重设密码都会产生新 salt/hash，因此 generation 改变；旧 grant 立即失效，不依赖 server restart。
- 原因：管理员重置密码通常意味着需要切断旧授权。仅改变登录密码而保留最长 30 天 refresh grant 会违背用户的安全预期。

## ADR-019：密码批准同时做频率与并发治理

- 状态：accepted
- 决策：POST `/authorize` 的管理员密码批准除 per-client/global fixed-window rate limit 外，最多允许 2 个并发 Argon2id verify。
- 原因：Argon2id 的 64 MiB memory cost 是安全特性，但也会把并发密码猜测转化成内存 DoS；并发上限让峰值密码哈希内存有确定边界。

## ADR-020：MCP session 与 process 都按授权会话隔离

- 状态：superseded by ADR-029
- 决策：公网 `Mcp-Session-Id` 绑定创建它的 OAuth `client_id`；长进程进一步绑定到单个 MCP session 的 process scope。ProcessSessionManager 共享全局 max=8，但每 scope max=4；其它 scope 即使猜到递增 processId 也只能得到 `Unknown processId`。transport close 自动清理本 scope。
- 原因：有效 OAuth token 不应成为访问其它 client/session transport state 的通行证；processId 比随机 session id 更易猜，更必须做 ownership check。

## ADR-021：下游 MCP secret 不进入 `mcp.json` 明文

- 状态：accepted
- 决策：`env` / `headers` 中 token、Authorization、secret、password、API key、private key 等敏感 key 必须通过 `${ENV_VAR}` 引用；missing env 直接拒绝启动。Unix 加载时将 `mcp.json` 权限收紧到 0600。远程 downstream MCP 默认要求 HTTPS，仅 loopback 允许 HTTP，URL credentials/fragment 禁止。
- 原因：README 原示例会鼓励把长期 token 写入用户配置；即便文件在 home 目录，也容易被备份、同步或误提交。remote MCP credentials 也不应通过明文 HTTP 传输。

## ADR-022：外部/正则子进程必须有 wall-clock 与资源预算

- 状态：accepted
- 决策：ripgrep probe/search 与 cloudflared short command/sidecar 使用 bounded output + timeout + TERM→KILL；没有 ripgrep 时，JS regex 搜索放入 Worker 并设置 runtime cap。
- 原因：正则灾难回溯、异常 binary 或忽略 TERM 的子进程都不能无限占用 MCP tool call / Node 主线程 / 内存。

## ADR-023：MCP Apps UI 不展示高风险原始参数

- 状态：accepted
- 决策：shell command 在 tool summary/card args 中只展示长度与 hidden 标记；URL 展示前移除 username/password/query/fragment。完整参数仍只存在于模型实际 tool call，不复制到可视卡片。
- 原因：命令行常直接包含 bearer/API token，URL query 常包含签名或 access token；UI metadata 是额外展示面，不应扩大 secret 暴露范围。

## ADR-024：CIMD `private_key_jwt` 使用严格公钥认证

- 状态：accepted
- 决策：AS metadata 广告 `private_key_jwt` + RS256；CIMD 必须通过 `jwks` 或 HTTPS `jwks_uri`（二选一）发布公开验证密钥。`private_key_jwt` 强制 `iss=sub=client_id`、必需且唯一的 `jti`、短期且必需的 `exp`，`iat` 可选并在出现时校验。`aud` 按当前正式 RFC 7523 / OpenID Connect Core 接受 Authorization Server issuer URL 或精确 token endpoint URL；若为数组，只允许由这两个受信 AS 身份组成，不允许混入无关 audience。重放防护按 `client_id + jti` 缓存到 assertion 失效，不额外施加非标准最小熵/长度门槛（仅要求非空且设置实现级上限）。JWKS 只接受可验证的 RSA/RS256 公钥且 modulus≥2048，支持受限 cache 与 key-rotation refresh。`/token` 与 `/revoke` 使用相同 client-auth verifier；SDK 1.30 不支持的部分由本项目自己的 endpoint handler 实现。
- 原因：这是 ChatGPT 当前 CIMD 的真实认证方式；将 `private_key_jwt` 当作 `none` 会破坏客户端身份认证，将 assertion 只做语法解析也会形成认证绕过。

## ADR-025：安全 HTTP 支持受信任代理，但不绕过 SSRF policy

- 状态：accepted
- 决策：HTTPS 出站支持标准 proxy env，并在 macOS 读取静态 Secure Web Proxy。代理模式不依赖可能受污染的本机 DNS：先经固定 DoH resolver 解析并验证目标 A/AAAA 全部为全球可路由地址，再把代理 CONNECT 目标固定到这些已验证公网 IP；HTTP Host 与 TLS SNI/证书验证仍使用原 hostname。为适配本机 forward proxy/CDN edge 的瞬时 reset/timeout，复用 bounded keep-alive proxy agent，并仅对连接 errno/reset 与项目自身精确 bounded-timeout 等传输错误在最多两个已验证公网 IP 间做有限故障转移；TLS/证书/HTTP validation 错误保持 fail-closed。redirect 每跳重复执行同一 policy，HTTP URL 不使用该代理路径。
- 原因：浏览器通过系统代理可访问 ChatGPT 时，Node 直连可能仍因网络/DNS 环境失败；直接改成任意 proxy fetch 又会破坏既有 SSRF 边界。系统/环境代理属于本机启动环境的受信任网络配置。

## ADR-026：Tunnel readiness 必须验证公网 end-to-end postcondition

- 状态：accepted
- 决策：cloudflared edge registration 只代表 connector 已上线，不代表 hostname 指向它。HTTP server 每次启动生成高熵 probe path 与独立随机 response；sidecar ready 后 CLI 必须经公网 hostname 访问并精确匹配当前实例，失败立即关闭 sidecar/server。
- 原因：Cloudflare proxied CNAME flattening 使公开 DNS 无法可靠看出 tunnel UUID；真实现场已经出现 DNS 指向另一个 tunnel、CLI 却显示 ready。端到端实例证明比 DNS 猜测更强。

## ADR-027：OAuth 授权页动态 `form-action` callback origin

- 状态：superseded by ADR-028
- 决策：曾尝试将 `form-action` 从 `'self'` 放宽到 `'self' <validated-redirect-origin>`，以允许 Chrome 跟随授权成功后的跨域 OAuth 302。
- 原因：该改动修复了明确的 CSP 冲突，但真实 ChatGPT 复测仍出现授权导航未完成，说明继续维护独立 `/oauth/approve` + `pending_id` 状态机不是最稳妥的授权交互结构。

## ADR-028：授权交互使用 SDK 原生 GET/POST `/authorize`

- 状态：accepted
- 决策：删除 `/oauth/approve` 与内存 `pending_id` authorization state。GET `/authorize` 仅显示密码表单，并把经过 SDK 首轮校验的 `response_type/client_id/redirect_uri/code_challenge/code_challenge_method/scope/state/resource` 作为 hidden fields；表单直接 POST 回 `/authorize`。SDK 在 POST 时重新解析并校验 client、redirect URI、PKCE 与 resource，provider 再验证管理员密码、创建 authorization code 并直接 302 到 callback。授权页继续使用 `default-src 'none'`、`frame-ancestors 'none'`、`base-uri 'none'`，但不设置 `form-action`，避免浏览器把 OAuth 302 callback 当作表单导航链再次限制；页面没有脚本能力且 form action 固定为 `/authorize`。
- 原因：DevSpace 的稳定实现使用 SDK 原生 authorize GET/POST 生命周期；该结构减少一层自定义 endpoint、一次性 pending state 和跨 handler 导航状态，同时让 OAuth 参数在密码提交时由 SDK 再验证一次。现有 CIMD、`private_key_jwt`、PKCE、resource binding、Argon2 限流均保留。

## ADR-029：公网 MCP transport 改为 request-scoped stateless serving

- 状态：accepted
- 决策：服务端 HTTP 栈迁移到 `@modelcontextprotocol/server` / `node` / `express` v2，`/mcp` 使用 `createMcpHandler` 的 per-request serving，并保留 2025-era client 的 stateless fallback。服务端不再建立 `Mcp-Session-Id` registry，也不再把 transport close 当作业务状态生命周期；OAuth `client_id` 仍是 process owner 与 tool policy 的稳定身份。`ProcessOwnerPool` 在每个 request factory 中 acquire，request-scoped `McpServer` close 时 release；最后一个 lease 释放后按 grace period 保留 owner process scope，重连请求可恢复 `processId`。请求 abort 由 Node adapter 的 `AbortSignal` 传播到 per-request transport，错误/提前 close 单独记录诊断事件。
- 原因：真实 ChatGPT + Cloudflare Tunnel 回归中，多种工具请求都可触发 `context canceled`，之后旧 sessionful connector 持续 502；同一时刻 origin 与公网 `/healthz` 均保持 200，本地工具/OAuth/gateway E2E 全绿。故障因此属于 transport/session failure amplification，而不是某个工具或 process manager。stateless serving 将一次 HTTP 取消限制在单次 exchange，避免 stale `Mcp-Session-Id` 毒化后续请求，同时仍通过 OAuth owner scope 保留真正需要跨请求存活的长进程状态。

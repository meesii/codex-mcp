# 研究发现与技术笔记

> 外部规范与网页信息只记录在本文件，执行决策以 `task_plan.md` / `decisions.md` 为准。

## 2026-08-07 规范基线

### MCP 2026-07-28

- MCP 2026-07-28 已发布，核心协议转向 stateless，`initialize`/`initialized` 和 `Mcp-Session-Id` 被新 core 移除；本轮不迁移该 transport，保持当前 ChatGPT/SDK compatibility，后续独立升级。
- Authorization hardening：Authorization Server 应在授权响应中返回 RFC 9207 `iss`，客户端必须校验。
- Dynamic Client Registration 已正式 deprecated，Client ID Metadata Documents (CIMD) 成为推荐路径；DCR 暂留兼容。
- OAuth 客户端 metadata 拉取属于 SSRF 边界，需要阻止内部网络、设置 timeout/size limit、严格 schema/redirect validation。

### MCP Apps Authorization

- 对本项目这种所有 coding tools 都敏感的服务，应采用 per-server authorization，在 HTTP 边界拒绝未授权请求。
- 受保护资源应提供 RFC 9728 Protected Resource Metadata，并通过 HTTP 401 + `WWW-Authenticate` 指向 resource metadata，而不是 tool-level error。
- Authorization Server Metadata 需要公开 authorize/token endpoint、PKCE 等能力以及 `client_id_metadata_document_supported`。

## 2026-08-07 Review 确认问题

### Critical / P0

1. 公网 Cloudflare Tunnel + `noauth` + `bash/exec_command` = 知道 URL 即以本机用户权限 RCE。
2. `destructiveHint` 被刻意设为 false，风险 metadata 与真实工具能力不符。
3. `path-guard` 只做 lexical containment，symlink 可绕过 root；已通过临时目录 PoC 验证写出 root。
4. Tunnel wizard 直接覆盖 `~/.cloudflared/config.yml`。
5. Tunnel wizard 在远端同名 tunnel 本地 credentials 缺失时自动 `delete -f` 重建。
6. DNS 冲突时自动 `--overwrite-dns`，可能接管已有 hostname。

### P1

- `--local` 仍继承用户配置的 `host=0.0.0.0`，不保证 loopback。
- MCP session 24h idle 且无 max session/rate limit；process manager 无 max process。
- `edit` 使用 `String.replace(oldString,newString)`，`$&/$'/$$` 被 replacement parser 解释。
- `read` CRLF→LF 后 `edit` 要求磁盘 exact match，Windows 多行 edit 容易失败。
- 自制 glob→regex replacement 会二次处理生成的 regex，`**/*.ts` 两层以上匹配失败。
- `bash` timeout 只发 SIGTERM，无 SIGKILL escalation，忽略 TERM 可无限挂。
- process shutdown 只 TERM、不等待、不 KILL，可能留下子进程。
- `exec_command/write_stdin` 非零退出仍为 MCP success，与 `bash` 不一致。
- `webfetch` 先 `arrayBuffer()` 后检查 5 MB，无法限制内存占用。
- `webfetch` 允许 loopback/private/link-local 并 follow redirect，是 SSRF primitive。
- downstream gateway 只保留 text + structuredContent，图片/resource/audio 等 content 丢失。

### P2

- downstream tool catalog 被描述为 conversation 内不变，未处理动态 list change。
- downstream `instructions` 首行直接进入上层 server instructions，形成不必要的 prompt trust boundary。
- `listTools` 断线不 reconnect，`callTool` 才 reconnect。
- tool card iframe 永久 250ms polling。
- `read` 的 limit 在整文件 `readFile` 后才应用；大文件仍全部进内存。
- `edit.old_string` 未禁止空字符串。
- `/healthz` 公网返回 projectRoot 绝对路径。
- Windows `\u0003` 实际使用 `taskkill /F`，不是 Ctrl-C。
- Windows installer 用 ASCII 写 `.cmd`，Unicode repo path 会损坏。
- 现有测试没有 path-guard/symlink/tunnel/mcp-session/process-session direct coverage，没有 CI。

## 依赖

- 基线安装解析到 `@modelcontextprotocol/sdk@1.30.0`。
- 官方 npm audit 曾报告 `hono@4.12.33` moderate CORS ReDoS（GHSA-8j4g-w8fx-2239），依赖链来自 MCP SDK；当前源码走 Express，reachability 较低，但应更新 lockfile。
- `package-lock.json` 大量 resolved URL 指向 npmmirror；跨地区/开源可重复安装性需通过官方 registry 重生成或至少验证。

## 基线验证

- Node `v24.18.0`，npm `11.16.0`。
- 安装依赖后：`npm run typecheck` PASS；`npm test` PASS；`npm run build` PASS。
- 初始 Git：`main...origin/main`，working tree clean。

## MCP SDK 1.30 OAuth 服务端能力

- SDK 已提供 `mcpAuthRouter()`，可安装 authorization server metadata、authorize/token/register/revoke，并自带 endpoint rate limiting；适合复用协议解析/错误响应，避免手写 OAuth wire protocol。
- `OAuthServerProvider` 需要实现 `clientsStore`、`authorize`、authorization code challenge lookup/code exchange、refresh exchange、access-token verify，以及可选 revoke。
- `mcpAuthRouter` 支持显式 `issuerUrl`、`resourceServerUrl`、scopes；SDK helper 生成 RFC 9728 protected-resource metadata。
- SDK 的 provider API 仍围绕 registered client store，需要继续核对 CIMD URL client_id 是否由 authorize handler/clients store 原生支持；如果没有，需要在 client store 适配安全 CIMD fetch。

### SDK authorize handler 细节

- SDK authorization handler 已强制 `response_type=code`、`code_challenge_method=S256`，并在进入 provider 前从 `clientsStore.getClient(client_id)` 取 client metadata。
- redirect URI 对非 loopback 要求 exact match；loopback 按 RFC 8252 仅放宽端口，scheme/hostname/path/query 仍一致。
- 因为 `clientsStore.getClient()` 允许异步返回，所以可以在 unknown HTTPS URL client_id 时安全拉取 CIMD，并将验证后的 metadata 作为虚拟 registered client 返回；DCR client 则由本地持久 store 返回。

### SDK router 取舍

- SDK demo provider 的 code/token 生命周期只是内存示例，明确标注非生产；本项目仍需自己的持久化 store、password login、refresh rotation/replay detection。
- `mcpAuthRouter()` 当前生成的 endpoints 是根路径 `/authorize`、`/token`、`/register`、`/revoke`，同时生成 RFC 9728 path-specific PRM；可以直接复用这些标准路径。
- SDK 1.30 的 `createOAuthMetadata()` 尚未自动写 `client_id_metadata_document_supported: true`。实现将先挂载自定义 authorization-server metadata 响应（基于 SDK metadata + CIMD flag），再挂 SDK router 处理协议 endpoints；避免 fork SDK handler。

### SDK token/schema 行为

- SDK token handler 自身执行 PKCE verifier→challenge 校验；provider 只需保存/返回 code challenge，并在 code exchange 时验证 code/client/redirect/resource 一致性与一次性消费。
- token handler 支持 `authorization_code` 与 `refresh_token`，并通过 client store 做 client auth；DCR public client 可使用 `token_endpoint_auth_method=none`。
- SDK `OAuthMetadataSchema` 已包含 `client_id_metadata_document_supported` 字段，只是 `createOAuthMetadata()` 1.30 尚未设置它；自定义 metadata 增补字段与 SDK schema 兼容。

### DCR / password dependency

- SDK DCR handler 对 `token_endpoint_auth_method=none` 的 public client 不签发 secret；其它 client 生成 32-byte hex secret，并默认 30 天过期。client store 需要完整返回 client 信息供 SDK middleware 校验。
- `@node-rs/argon2@2.0.2` 提供 Node 22 可用的 async `hash/verify`，支持 `Algorithm.Argon2id`；将使用显式 Argon2id 参数和编码后的 PHC hash，不保存密码明文。

### CIMD/client error handling

- MCP SDK client在 AS metadata 宣告 CIMD 后，会直接把 `provider.clientMetadataUrl` 作为 `client_id`，而不是先 DCR；因此服务端 `clientsStore.getClient(https-url)` 必须负责拉取/校验 metadata document。
- SDK 提供 `InvalidGrantError`、`InvalidScopeError`、`InvalidTargetError`、`InvalidTokenError` 等标准 OAuth errors；provider 应抛这些类型，避免 SDK 把可预期客户端错误包装成 500。

### Bearer middleware

- SDK 提供 `requireBearerAuth()`：解析 Bearer、调用 verifier、校验 required scopes/expiry，并在 401/403 的 `WWW-Authenticate` 中支持 `resource_metadata="..."`。公网 `/mcp` 将直接复用该 middleware，避免自定义认证错误格式。

### Downstream 回归验证设计

- 现有 echo fixture 的 server instructions 是 `Tiny echo MCP...`，server metadata name 是 `echo-fixture`；整改后的测试应明确断言顶层 description/instructions 只出现 `echo-fixture`，不出现远端 instructions 文本。
- fixture 将增加包含 image content 的 rich tool，用协议级 E2E 证明 `mcp_call` 不再只保留 text。

## 2026-08-07 最终规范复核

- MCP 官方 2026-07-28 发布说明再次确认：authorization response 应返回 RFC 9207 `iss`；DCR 已正式 deprecated、CIMD 成为推荐注册路径，但 DCR 暂时继续兼容。
- MCP Apps Authorization 文档明确推荐：全工具敏感时使用 per-server authorization；未授权请求应在 HTTP 边界返回 401 + `WWW-Authenticate` 指向 Protected Resource Metadata，而不是返回 tool-level error。本实现使用 SDK `requireBearerAuth()` 在 `/mcp` transport 前完成该边界。
- 官方 CIMD 说明：HTTPS metadata URL 本身作为 `client_id`，Authorization Server 在授权时 fetch metadata，用其中 `redirect_uris` 等信息验证客户端。本实现通过异步 `clientsStore.getClient(https-url)` 完成该流程，并复用 safe HTTP SSRF policy。
- MCP 2025-11-25 Authorization profile 明确要求 OAuth `resource` 参数必须同时出现在 authorization request 与 token request，并指向 canonical MCP resource。SDK 1.30 的通用 handler/schema 仍把该参数建模为 optional，因此本项目必须在 provider/state 层额外强制：authorization、authorization-code exchange、refresh exchange 缺失或不匹配 `resource` 均拒绝。
- 同一规范对 CIMD 的服务端要求包括：metadata document 自带的 `client_id` 必须与 URL 完全一致、必须包含 `client_name`/`redirect_uris`，redirect URI 必须校验；localhost redirect 存在 impersonation 风险，授权 UI 应显著展示 redirect host。本实现新增纯解析 regression，并在密码批准页展示完整 redirect URI/host 与 loopback warning。
- SDK 1.30 client-auth middleware 对“无 client_secret”的 client 按 public client 处理，服务端没有完整 `private_key_jwt` verification。真实 ChatGPT CIMD 已声明 `token_endpoint_auth_method=private_key_jwt` + RS256 + `jwks_uri`，因此本项目必须自行实现标准 client assertion 验证并在 AS metadata 精确广告能力；不能把它降级成 `none`。
- Token revocation 终检确认 provider 必须按 authenticated `client_id` 约束 ownership；否则知道别的 client token 字符串可造成跨 client token-family DoS。实现已绑定 client owner，并有双 client E2E。
- SDK DCR 默认会为未声明 `token_endpoint_auth_method=none` 的客户端生成 `client_secret`；对本项目的 DCR fallback 没有收益，反而会把长期静态 secret 带入 persisted state。因此 **DCR** 继续收紧为 public client only；CIMD 则可使用标准 `private_key_jwt` 公钥 confidential client，仍不产生/保存 shared secret。E2E 断言 confidential/default-secret DCR 被拒绝且 state 不出现 `client_secret`。
- persisted DCR client 即使有固定 cap，也可能被低速填满形成长期 DoS。最终实现采用 endpoint per-client/global 双层限流，并在 cap 到达时只回收没有 code/access/active refresh 且超过保护窗口的最旧 inactive client。
- OAuth scope 不应由服务端静默扩权：客户端显式只请求 `offline_access` 时，服务端不能自动补 `mcp:tools`。实现改为显式缺 `mcp:tools` 即 `invalid_scope`，authorization/refresh 都有 E2E。
- SSRF 最终策略按“仅允许全球可路由地址”理解，而不是只封传统 RFC1918；IPv6 NAT64、discard-only、Teredo/ORCHID、benchmark、6to4、documentation/site-local 等特殊前缀均进入 deny ranges。
- 公网 `domain` 是 OAuth issuer/resource/Host allow-list 的共同输入，必须先 canonicalize。实现使用 WHATWG URL 做 IDN punycode 归一化，再验证 DNS label；拒绝 IP、localhost、credentials、非 HTTP(S) 与非法 label。
- 管理员密码 reset 如果只改登录哈希而不关联 token，会让旧 refresh grant 在密码重置后继续存活。最终将 code/access/refresh 绑定到 Argon2id PHC hash 派生的 credential generation；重设密码即 epoch rotation，运行中 server 也会在下一次 token 校验时读取新 generation 并拒绝旧 grant。
- Argon2id 配置 memoryCost=64 MiB；仅用请求次数 rate limit 仍允许少量高并发造成瞬时内存放大。最终在 POST `/authorize` 的密码批准路径限制 max-concurrent=2，并有并发 E2E。
- Streamable HTTP session 原 registry 只按随机 session id 寻址，没有 owner；有效 token client 若拿到其它 session id 可串会话。最终 session entry 绑定 OAuth `client_id`，不匹配按 unknown session 处理。
- 长进程原先共享全服务器 ProcessSessionManager 且 processId 为可猜递增整数，因此跨 MCP session poll/kill 是实际隔离缺口。最终 root manager 只负责共享容量/全局 shutdown，每个 MCP session 获得独立 scope；跨 scope processId 不可见，transport close 自动终止 scope 内进程。
- `mcp.json` 原先允许直接写 `Authorization: Bearer ...`、token env 等敏感值，README 甚至给了明文式示例。最终把敏感 key 改为 `${ENV_VAR}` 引用强制策略，missing env fail-closed，Unix 文件权限收紧 0600；remote downstream MCP 非 loopback 必须 HTTPS。
- fallback JS regex 在主线程执行 pathological pattern 会形成 ReDoS；ripgrep/cloudflared 也可能忽略 TERM 或持续输出。最终 regex fallback 转 Worker + runtime cap，ripgrep/cloudflared 增加 wall-clock/output budget 和 TERM→KILL escalation，并有 executable regression。
- MCP Apps tool card 原先会复制完整 `command` 与 URL 到可视 metadata；命令可能包含 Authorization/token，URL query 可能是 signed URL。最终 UI summary/args 对 command 只显示长度，对 URL 去 credentials/query/fragment；security regression 直接断言 secret 字符串不出现在 card 数据。

## 2026-08-07 真实 ChatGPT 接入补充发现

- ChatGPT 实际 CIMD `client_id` 是 `https://chatgpt.com/oauth/<id>/client.json`，metadata 使用 `private_key_jwt`、RS256 和 `https://chatgpt.com/oauth/jwks.json`。`/authorize` 的 `invalid_client` 不是密码问题，而是旧 CIMD policy 与真实 client auth model 不兼容。
- client assertion 按 OpenID Connect `private_key_jwt` 语义使用 `iss=sub=client_id`、必需 `exp/jti`、可选 `iat`。`jti` 在通用 RFC 7523 中可选，但 OpenID Connect `private_key_jwt` profile 明确要求 REQUIRED。audience 则必须以当前正式规范为准：RFC 7523 明确允许 token endpoint URL，OpenID Connect Core 还建议使用 token endpoint URL；因此 verifier 精确接受 AS issuer 或 token endpoint，audience 数组不得混入其它目标。先前把 2026 收紧 draft 的 issuer-only 规则当成已生效规范，真实 ChatGPT `/token` 以 token endpoint 为 `aud` 后暴露该错误。replay cache 按 `client_id + jti` 保留到 `exp + clock tolerance`；`/token` 和 `/revoke` 共用同一 verifier。
- 本机浏览器能访问 ChatGPT 不代表 Node 直连能访问。当前 macOS 使用 `127.0.0.1:7897` Secure Web Proxy，而直连 DNS/HTTPS 被干扰。safe HTTP 因此支持标准/macOS HTTPS proxy。HTTPS 代理路径先通过独立 DoH 获取并验证全球可路由 A/AAAA，再把 CONNECT 固定到已验证公网 IP，同时用原 hostname 做 Host/TLS SNI/证书校验。单次连接对部分 CDN edge 会瞬时 reset/timeout；最终复用 bounded keep-alive proxy agent，并在最多两个已验证 IP 间仅重试传输错误。终检又发现项目自身 `Request timed out after <n>ms` 不带 errno，原 classifier 会提前终止 fallback；将该精确 bounded-timeout 纳入 retry 后，真实 ChatGPT CIMD focused probe 达到 10/10 HTTP 200。TLS/证书/HTTP validation 错误仍不重试，HTTP URL 不走代理路径。
- Node `BlockList` 的 IPv4/IPv6 subnet 放在同一实例时出现 cross-family false positive；现场把 Cloudflare 公网 `172.64.155.209` 判成 reserved。拆分两个 BlockList 后解决，并增加公网 IPv4 regression。
- Cloudflare `Registered tunnel connection` 仅证明 connector 已注册，不证明 hostname 指向它；proxied CNAME flattening 又让普通 DNS 查询看不到 tunnel UUID。最终采用每进程随机 probe 的公网 end-to-end postcondition，真正证明 hostname 命中当前实例。
- Chrome 会把 CSP `form-action` 约束应用到表单提交后的跨域 302 导航。旧 `/oauth/approve` flow 因此可出现服务端已签发 authorization code、浏览器却未进入 ChatGPT callback 的半成功状态；动态加入 callback origin 后真实 ChatGPT 仍未稳定完成。对照 DevSpace 后确认更合适的结构是 SDK 原生 GET/POST `/authorize`：hidden fields 带回完整 OAuth 请求，SDK 在 POST 时重新验证 client/redirect/PKCE/resource，provider 验密码后直接 302；删除 pending state，并从授权页 CSP 中移除 `form-action` 指令。

## 外部参考

- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://apps.extensions.modelcontextprotocol.io/api/documents/authorization.html
- https://blog.modelcontextprotocol.io/posts/client_registration/
- RFC 9728 Protected Resource Metadata
- RFC 7636 PKCE
- RFC 9207 Authorization Server Issuer Identification
- RFC 9700 OAuth 2.0 Security Best Current Practice
- OpenID Connect Core 1.0 incorporating errata set 2（`private_key_jwt` 的 `iss/sub/aud/jti/exp/iat` 要求）
- OpenID Foundation 2025/2026 `private_key_jwt` audience hardening notice（issuer-identifier audience）

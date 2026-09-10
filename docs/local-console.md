# 本机控制台设计

## 产品定位

codex-mcp Web 不是只读状态页，而是 CLI 的本机 GUI 控制面。除内部 `daemon` 入口和机器输出格式外，所有用户级 CLI 能力都必须有对应 Web 操作，并且 CLI 与 Web 调用同一套业务 service。

## 进程模型

```text
Browser
  │ localhost only
  ▼
Local Controller
  ├─ Web Console / management API
  ├─ setup / auth / doctor / update
  ├─ project registry operations
  └─ runtime lifecycle orchestration
        │
        ▼
     MCP Runtime
       ├─ /mcp + OAuth
       ├─ project runtimes
       └─ Cloudflare Tunnel
```

`stop` 只停止 MCP Runtime/Tunnel，Controller 继续运行，因此网页仍能重新 `start`。Controller 永远只监听 loopback，不通过 Cloudflare 暴露。

## 共享业务层

业务动作从 CLI formatter / terminal prompt 中下沉为无 UI service：

- Runtime：start / stop / restart / status / runtime intent
- Project：list / add / remove / info
- Doctor：check / fix
- Auth：password status / set password
- Setup：inspect / public access / Cloudflare login and selection / capabilities / verification
- Logs：tail / follow
- Update：check/install，并在需要时重启 controller/runtime

CLI 负责参数解析与终端交互；Web 负责表单、状态和进度展示。

## Web 功能等价矩阵

- `start` 与 `--local` / `--no-tunnel` / `--tunnel-logs` / `--root`
- `stop`, `restart`, `status`
- `project list/add/remove/info`
- `logs --lines`, `logs --follow`
- `doctor`, `doctor --fix`
- `setup` 全流程，包括 Cloudflare 登录/域名/Tunnel/DNS/公网验证和外部能力配置
- `auth`
- `update`
- `version`, `help`

内部 `daemon` 命令不提供 Web 按钮；`status --json` 是 CLI 表示形式，不是独立业务能力。

## 长任务

setup/update/doctor 等操作不能占用单个长 HTTP 请求。Controller 使用 operation 模型：创建 operation 后返回 id，通过状态查询或 SSE 推送 phase/result/error；支持取消可取消的操作。

日志 follow 使用 SSE。

## 本机安全边界

- controller socket 仅 loopback
- 严格 Host/Origin 校验
- 浏览器使用随机 HttpOnly + SameSite=Strict session cookie
- mutation 使用 CSRF token
- CLI 使用 controller state 中的随机 control token
- Cloudflare credential、OAuth token、密码哈希不返回前端
- 危险/破坏性操作在 UI 明确确认

Controller management API 与公网 MCP/OAuth listener 分离，公网 route 永远不挂载 management API。

## UI 方向

控制台面向开发者本人，信息密度高于普通 SaaS dashboard。视觉以“本机运行台”为主题：左侧稳定导航，顶部持续显示 controller/runtime/tunnel 三层状态，主区域按当前任务显示可操作表格/表单/日志流；不使用装饰性 KPI 卡片堆叠。移动端可查看和执行常规操作，复杂 setup 仍保持完整可用。

## 验收标准

1. Runtime 停止后 Web Console 仍可访问并重新启动 Runtime。
2. CLI 用户级能力都有 Web 对应入口。
3. CLI/Web 不复制核心业务逻辑。
4. Web mutation 无 controller token 泄漏，跨站请求不能触发操作。
5. setup/update/日志 follow 有明确进度与失败信息。
6. 现有 MCP/OAuth/SSRF/项目隔离/Tunnel transaction 安全回归不退化。
7. Node 22 + 当前 Node typecheck/test/package smoke 通过。

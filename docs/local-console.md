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

控制台面向项目使用者，采用接近 ChatGPT 网页端的本机工作区风格：安静、轻量、内容优先。主导航收敛为“首页、项目、连接 ChatGPT”，系统维护从技术详情进入，也可通过首页“检查并修复”直接打开。

- 前端使用 React、Tailwind CSS 和基于 Radix primitives 的 shadcn/ui 组件模式；脚本和样式在发布时打包到 `dist/ui/console`，不依赖 CDN。
- 画布使用 `#ffffff`，侧栏使用 `#f9f9f9`，主文字为 `#0d0d0d`，次要文字为 `#6f6f6f`；绿色只表示服务正常或操作成功。
- 首页展示“选择项目 → 连接 ChatGPT → 验证连接”三步引导、可用项目和可复制的连接地址，主要按钮指向下一步。
- 普通界面使用“控制面板、MCP 服务、公网连接、连接密码、可用工具与技能”等用户语言；PID、运行模式和内部连接状态只在技术详情中显示。
- 项目添加、连接设置和危险操作使用 Dialog；手机端导航和技术详情使用 Sheet；操作反馈统一使用 Toast 和进度面板。
- 深色模式使用 `#212121` 画布、`#171717` 侧栏和 `#2f2f2f` 面板。手机端侧栏变为左侧抽屉，页面和表单均折为单栏。
- 所有交互元素提供清晰的键盘焦点，并尊重 `prefers-reduced-motion`。

## 项目选择与连接检查

- “添加项目”优先打开系统文件夹选择器：macOS 使用 osascript，Windows 使用 FolderBrowserDialog，Linux 使用 zenity/kdialog。取消不会注册项目，浏览器取消请求会结束等待进程；系统不支持时可选推荐项目或展开手动路径。
- 推荐列表包含仍存在的已停用项目，以及常见开发目录中的浅层项目候选；最多展示 20 项，不递归扫描用户目录。只选择候选不会注册，仍需点击“添加项目”。
- 文件夹在服务端验证真实性、目录类型和可读权限。普通 Web 添加沿用现有运行方式，未启动时先以本机模式启动，避免添加项目意外切换公网服务。
- 项目页展示持久会话选择记录、最近使用时间和匿名编号；这些是历史绑定，不代表在线状态，不暴露原始客户端标识。
- “测试连接”通过正在运行的 MCP handler 完成 initialize、tools/list 和只读 project_control(list)，检查公网地址是否指向同一实例并返回登录保护挑战。内部工具探测只接受固定操作，管理接口受本机控制令牌保护。
- 检查不模拟 ChatGPT 账户授权，也不把已配置地址视为已连接。最终账户授权仍需在 ChatGPT 中完成；结果页明确说明检查范围，配置或运行实例变化后清除旧结果。

## 验收标准

1. Runtime 停止后 Web Console 仍可访问并重新启动 Runtime。
2. CLI 用户级能力都有 Web 对应入口。
3. CLI/Web 不复制核心业务逻辑。
4. Web mutation 无 controller token 泄漏，跨站请求不能触发操作。
5. setup/update/日志 follow 有明确进度与失败信息。
6. 现有 MCP/OAuth/SSRF/项目隔离/Tunnel transaction 安全回归不退化。
7. Node 22 + 当前 Node typecheck/test/package smoke 通过。

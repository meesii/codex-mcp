# AGENTS.md

## 项目身份

- 本仓库是面向 ChatGPT 的本机 coding MCP，核心由本机 Controller、MCP Runtime、项目注册/会话绑定、OAuth/公网入口和 Web Console 组成。
- Web Console 是本机控制面，不是独立 SaaS：主要入口为 `src/ui/console/**`，技术栈固定为 Vue 3 + TypeScript + Element Plus + Vite。
- Controller 与 CLI 应尽量复用 `src/control/services.ts` 等共享 service；除纯 UI 状态外，不在 Web 或 CLI 复制一套业务规则。
- 优先最小、可运行、可验证的实现；不要为了统一风格、提前抽象或顺手清技术债扩大 diff。
- 不得以“个人工具”为理由削弱已有的 OAuth、CSRF、Origin、SSRF、路径隔离、Cloudflare 所有权或持久化事务边界。

## 执行协议

开始修改前按顺序执行：

1. 读取当前路径生效的 `AGENTS.md`。
2. 检查 `git status`，区分已有脏文件和本任务改动；不要碰与任务无关的脏文件。
3. 确认真正生效的 CLI → Controller → service → Runtime / Tunnel 调用链，以及 Web route → component → API → service 调用链；存在但没有入口或调用方的旧文件不能作为当前事实。
4. 先检查用户需求是否存在错误前提、逻辑跳跃或信息缺失；区分事实、推测和主观判断，发现冲突直接指出。
5. 涉及外部系统时确认所有权与回滚边界：Cloudflare DNS/Tunnel、OAuth client、文件系统、项目状态都不能靠名称或猜测直接覆盖/删除。
6. 定义最小必要修改范围和能证明结果的最低成本验证方式，再开始修改。
7. 修改过程中如果真实测试暴露新的根因，先补行为回归，再修实现；不要顺着现有代码写只会通过的测试。

## 生命周期不变量

- `project add/remove` 只改变项目注册状态，不隐式启动 Runtime。
- `open` 只确保 Controller / Web Console 可用，不启动 Runtime。
- `start` 启动 Runtime，并使用显式模式或已持久化的运行偏好；项目注册应先于 Runtime 前置校验完成。
- `stop` 只停止 Runtime/Tunnel，Controller 与 Web Console 保持在线。
- `shutdown` 才完全关闭 Runtime 与 Controller。
- 配置状态、持久化状态和当前运行状态是不同概念；UI/CLI 不得把其中一个伪装成另一个。
- Runtime、Tunnel、Controller 的长生命周期操作必须使用各自真实 deadline；探活 timeout 不能复用于启动/停止操作。

## Web Console 架构

- 页面组件负责页面编排和交互状态；网络请求统一通过 `src/ui/console/api.ts`，页面不得自行拼 Controller URL、CSRF 或 fetch 基础设施。
- Web 只调用 Controller API；业务语义放到共享 service，确保 CLI 与 Web 对同一操作具有一致行为。
- `App.vue` 负责全局导航、跨页面状态和生命周期；View/Component 保持局部职责，不把所有逻辑重新堆回根组件。
- 外部 CLI、Runtime 或配置文件可能在页面打开期间改变状态；Web 必须有明确的状态同步策略，不能只依赖用户手动刷新。
- 异步请求、EventSource、timer、AbortController、原生文件选择等由谁创建就由谁 cleanup；组件卸载、Dialog 关闭或 Controller 替换后不得留下 owner 不明的后台任务。
- 异步旧结果不得覆盖更新后的页面状态；轮询/刷新要防并发竞态，长操作结束后再解锁相关 UI。
- 用户未保存的本地表单编辑不能被后台状态刷新静默覆盖；需要同步外部变化时先区分 server state 与 draft state。

## Vue / Element Plus

- 使用 Vue Composition API 和明确 TypeScript 类型；当前规模不引入 Pinia，除非出现真实跨页面状态复杂度证明需要。
- Element Plus 使用当前按需导入方案；禁止恢复 `app.use(ElementPlus)` 或 `element-plus/dist/index.css` 全量导入。
- 通用 Button、Dialog、Drawer、Table、Tabs、Form、Switch、Message、MessageBox 等优先 Element Plus，不再自建一套通用 UI primitives。
- 所有 Dialog/Drawer 必须有明确取消或关闭路径；异步提交期间防重复触发，同时允许用户理解当前正在做什么。
- 面向用户的默认文案使用中文；内部 PID、revision、Tunnel ID、命令等技术信息只在需要的位置展示，避免首页堆内部术语。
- 操作名称必须描述真实副作用，例如“生成并设置密码”不能写成看起来只会生成。

## UI / CSS

- Web Console 定位是简洁的本机工具控制台：优先状态、下一步操作和可恢复错误，不为了装饰增加大卡片、冗余说明和动效。
- 视觉与布局基线参考 `/Users/lkw/workspace/桔道商城/jdny-shop-admin` 的 PC Admin：稳定的侧栏 + 64px 顶栏 + 灰色工作区 + 白色内容面 + 轻边框/轻阴影 + 24/16/12 间距节奏；只借鉴后台工作区感觉，不复制商城绿色品牌色和商城业务组件。
- 桌面侧栏保持可折叠的后台导航语义（展开约 228px、折叠约 64px）；内容区使用工作区宽度，不退回居中限宽的网站式页面；顶栏已有页面标题时正文不重复大标题。
- 桌面端与窄屏都必须可用；重要布局至少检查约 1440×900 和手机窄宽视口，不只验证 DOM 能挂载。
- 样式优先复用 `src/ui/console/styles.css` 中现有 design token 和 Element Plus token；不要在组件中散落新的品牌色/阴影/圆角体系。
- 页面主布局使用 flex/grid；同级间距优先 `gap`。避免依赖 `backdrop-filter` 等效果作为唯一可读性手段。
- 响应式结构规则要有明确优先级，避免按需组件 CSS 的加载顺序意外覆盖关键 `display/layout` 规则。
- 破坏性操作必须有确认与清晰后果说明；普通刷新、复制、查看等操作不要多余确认。

## 状态与反馈

- Web 操作成功后应尽快反映真实 server state，而不是只弹成功 Toast。
- CLI 与 Web 同时使用时，项目、会话、Runtime、连接地址、密码状态等应在合理时间内自动同步；窗口重新聚焦时应立即刷新。
- 后台轮询避免在页面不可见时高频执行；恢复可见后立即同步。
- 全局 busy 状态必须支持并发 owner，不能因为第二个短操作结束而提前解锁第一个长操作。
- SSE/日志/长操作断线应保持可观察并允许自动重连或恢复，不得永久卡在“处理中”。
- 连接检查、doctor 等结果中的术语应与产品信息架构一致；“项目”只表示 project，不用来泛指“检查项/问题项”。

## Cloudflare / OAuth / 安全边界

- Web Console 始终只监听本机回环地址；浏览器写操作继续要求本机 session + same-origin + CSRF。
- 密码、OAuth token、private key、Cloudflare 凭据不得写进 DOM、URL、普通日志或测试输出；生成密码只有用户明确触发时才短暂显示。
- Cloudflare 托管资源只能在能够证明属于 codex-mcp 时自动修改/清理；DNS 删除前必须确认仍精确指向预期 Tunnel。
- 切换公网入口时先验证 candidate，再提交本机配置，最后清理旧资源；失败或取消需要按当前事务边界补偿。
- Tunnel 复用优先可靠 ownership（已知 ID、本机匹配账号凭据、无歧义远端状态），不能只依赖 hostname 或 tunnel name 猜测。
- Cloudflare `deleted_at` 等软删除语义要当作已删除处理，不能仅凭 GET 200 判断资源存在。
- OAuth、PKCE、refresh/revoke、proxy hostname routing 等安全路径修改时必须同时覆盖失败与重放/跨 host 等负面路径。

## 验证

- 没有实际执行过的测试、浏览器、操作系统或外部流程不得报告为通过。
- 修改 TypeScript/Vue 后至少运行 `npm run typecheck`。
- 修改 Web 入口、Vite、Element Plus 导入、构建或 CSS 关键布局时运行 build/完整测试，并用真实浏览器渲染验证相关页面。
- 修改 Controller/Runtime/Tunnel/OAuth 行为时运行对应行为测试；涉及真实 Cloudflare 时使用隔离 HOME、独立端口和一次性测试域名，测试后精确清理资源并再次核对正式实例未受影响。
- 发布相关改动至少运行 `npm test`、`npm run test:package` 和 `git diff --check`。
- 自动化测试不能替代真实生命周期验证；真实外部路径若受环境限制，明确写出未验证部分。

## Git

- 修改前后保护与任务无关的既有脏文件；不要格式化或删除无关文件。
- 只有用户明确要求“提交代码”才 commit；只有用户明确要求“推送代码”才 push。
- 需要提交时只暂存本任务文件，并在提交前检查 staged diff。
- `AGENTS.md`、测试和实现应保持一致；规则变化不要偷偷夹在无关功能提交中。

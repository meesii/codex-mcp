# codex-mcp test contracts

这些测试把 codex-mcp 当成一个外部系统，而不是一组 TypeScript 函数。

## 测试边界

场景测试只能依赖：

- CLI 进程及其退出码/输出
- HTTP/OAuth 公共端点
- MCP `tools/list` / `tools/call`
- README 已公开的 `~/.codex-mcp/*.json` 持久化文件
- 文件系统、Git 和子进程产生的外部结果

`harness.ts` 可以使用生产构造器启动内嵌服务，但不把 Registry、Runtime、Owner key 等内部对象暴露给场景测试。预期值不得调用生产算法计算。

## 核心不变量

### CLI / daemon

1. `--help` / `--version` 可独立运行。
2. `codex-mcp --local` 注册当前项目；多个目录共享一个 daemon。
3. `status` 只展示真实注册状态；`exit` 只停当前项目；`exit -a` 停整个 daemon。
4. daemon 控制路由没有 control token 时必须拒绝。

### MCP 文件 / 命令 / Git

1. 项目内相对路径以绑定项目为根。
2. 读、写、编辑、patch、grep、glob、ls、Git、短命令和托管进程必须产生可在文件系统/Git/进程层验证的结果。
3. 路径逃逸、悬空 symlink 写入、私网 webfetch 等危险输入必须 fail closed。
4. 大输出必须有界，而不是崩溃或无限返回。

### 权限

1. 工作区外只读允许；写入和 `cwd` 执行必须授权。
2. `once` 只消费一次；`session` 只属于当前 owner/session；`permanent` 跨连接保留直到 revoke。
3. 不同 conversation 不共享 session grant / process handle。
4. 两个不同 OAuth client 即使使用相同 `openai/session`，也不能共享项目绑定、session grant 或 process handle。

### 多项目

1. 未绑定项目时所有 project-level tool fail closed。
2. 一个 conversation 同时只绑定一个 Registered Project。
3. 已绑定后无 `force` 不得切到另一个项目；`force=true` 只影响当前 owner。
4. 项目 display/package name 改变后，既有 durable identity / binding 仍有效。
5. deactivate 后旧 binding 失效，不得继续访问原项目。
6. daemon restart 后 durable binding 仍按合同恢复，陈旧 binding 按 GC 规则删除。

### Global Trusted Roots

1. add 是 daemon-global：已存在 runtime 和未来 runtime 都立即可用。
2. remove 是 daemon-global：所有 live runtime 立即失去 write/exec trust。
3. 删除 global trust 不得撤掉某 Registered Project 自己的 primary root。
4. 重复 add 必须幂等；remove 未注册 root 必须明确失败。
5. 配置中暂时离线的 root 不得因新增/删除其他 root 被悄悄抹掉。

### ChatGPT frozen action ABI

1. tool 名存在不代表 frozen input schema 支持后来新增参数。
2. 手工冻结的旧 `workspace_projects(max_depth)` 快照必须判为无法完成 daemon project bootstrap。
3. selector-capable 快照可走兼容绑定。
4. 不可兼容时必须明确要求 Refresh / re-publish，而不能绕过权限或伪装成功。

### OAuth / HTTP security

1. 未认证 MCP 请求拒绝；OAuth metadata/DCR/PKCE/token/refresh/revoke 按标准流程工作。
2. authorization code / refresh token 防重放和 client 隔离。
3. 密码与 token 不以明文写入公开状态文件或日志。
4. Host/Origin/control-token 边界 fail closed。

### 外部能力 / downstream MCP

1. Codex / Claude / Agent Skills 的用户配置是引用来源，不复制 secret 到 `~/.codex-mcp`。
2. source priority / local override 对用户可见结果稳定。
3. downstream MCP 断线/重连/能力变更不会使核心文件工具不可用。
4. downstream 返回值和分页必须有界。

## Mutation sanity

最终验收必须临时注入至少三个典型错误并确认新合同测试变红：

1. 重新注册同一路径时重算 project id。
2. workspace remove 只更新当前 runtime，不广播。
3. binding owner key 丢掉 OAuth/local namespace，只保留 `openai/session`。

Mutation 后必须恢复生产代码，再跑完整套件。
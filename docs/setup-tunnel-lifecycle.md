# Setup / Tunnel 生命周期设计

## 目标

让公网配置、Cloudflare 远端资源和 daemon 运行态拥有清晰的唯一 owner。配置命令负责交互和变更，检查命令保持只读，daemon 只消费已经提交的配置。

保留单 daemon、多项目注册模型。公网 route 验证默认允许最多 5 分钟，并支持 Ctrl+C 立即取消，不恢复测试目录。

## 状态边界

公网配置只有两种已提交状态：

- `external`：用户提供 HTTPS 入口，仅保存 hostname。
- `cloudflare`：codex-mcp 管理 locally-managed Tunnel，保存 hostname、Tunnel ID/name、cloudflared 路径和账号/zone identity。

运行意图与公网配置分开：本机或公网、是否启动 managed sidecar、是否镜像 Tunnel 日志。daemon state 必须保存完整运行意图，使 restart 和 setup 后恢复不会改变语义。

Cloudflare 状态分为：

- account certificate：账号级管理凭据，登录成功是独立 durable checkpoint。
- Tunnel credential：只允许运行特定 Tunnel，与远端 Tunnel 一起管理。
- runtime YAML：由已提交配置生成的运行制品。
- Tunnel、DNS record、connector：三个独立的远端/运行时生命周期。

## 命令职责

| 入口 | 职责 |
|---|---|
| `setup check` | 只读检查 committed config、运行态和公网实例 |
| `setup public` | 唯一公网 mutation 入口 |
| `tunnel` | `setup public` 的兼容别名 |
| daemon/foreground start | 只读取 committed config；不 prompt、不登录、不改 DNS |
| `status` | 展示 daemon 与 sidecar observed state，并比较公网/本机 instance |
| `doctor` | 只读 reconcile config、YAML、credential、Tunnel、DNS、connector |

## Managed Tunnel 配置顺序

```text
取得 lifecycle lock
→ 识别端口 owner；未知占用则在任何 Cloudflare mutation 前失败
→ 保持已知 daemon 在线
→ 登录 checkpoint / 账号和 zone discovery
→ 生成变更计划
→ 创建或复用 candidate Tunnel 与 credential
→ 写 candidate YAML
→ candidate 准备完成后短暂停止已知 daemon
→ 启动本机随机 probe origin
→ 启动 candidate connector 并等待 ready
→ 通过 Cloudflare API snapshot 旧 DNS record
→ 切换 DNS 到 candidate Tunnel
→ 在默认 5 分钟兜底窗口内验证公网随机 probe；Ctrl+C 可立即取消并进入补偿
→ 原子提交本地配置与 runtime YAML revision
→ 恢复此前 daemon 完整运行意图
→ 比较 local/public instance
```

DNS 只能在 candidate connector ready 后切换。交互式登录、zone/hostname 选择和 candidate 准备不能提前中断一个正常 daemon；停机窗口只覆盖实际 origin/connector/DNS 验证与 commit。配置 mutation 不允许复用“端口占用时比较旧 daemon”的检查分支。

## 失败与补偿

- 登录成功不因后续 route 失败删除。
- DNS 变更前保存完整 record；失败后恢复旧 record，原来不存在则删除本次记录。
- 只自动删除本次 session 新建且尚未投入使用的 Tunnel。
- committed config 在最终验证成功前保持旧值。
- 补偿失败必须报告 phase、已完成的远端变更和精确恢复动作，不能声称事务回滚成功。
- DNS mutation 阶段收到 Ctrl+C 时先标记取消，让当前远端请求收敛并进入同一补偿路径，而不是直接终止进程。

## 持久化

配置和运行制品使用 private temp file、`0600` 和 rename。YAML 是派生 revision，先完整写入，再由一次原子 config commit 指向它；旧 revision 在成功切换后清理。

账号切换在 session-specific 临时 HOME 中完成，新 cert 解析并确认账号后才替换旧 cert。

## 运行态

Sidecar 状态为 `off | starting | connected | degraded | exited`。ready 后退出必须传播到 daemon status；daemon 保持本机 control plane 可用，并对意外退出执行有上限的退避重启。连接固定使用 IPv4 edge workaround，但不固定传输协议，让 cloudflared 的 `auto` 模式自行在 QUIC 和 HTTP/2 间选择/回退。

正式 public server 启动后，无论 managed Tunnel、自定义 HTTPS 还是 `--no-tunnel`，都使用同一个随机 end-to-end probe 验证公网 hostname 到达当前实例。

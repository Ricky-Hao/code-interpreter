# FP-004 — 一次性可写 Debian MicroVM

**状态：必须保留。** 原始 11 提交的 rebase 终点为 `4529d241b1b7e2db0cd431be9f465d7421b57042`，后续本地集成另含已审阅的 devpts 等修复；该终点不是永久当前 HEAD。manager 16 项及 passt 3 项 mock/假进程测试通过，真实 VM 启动、apt/dpkg 和端到端交付未验收。

## 目标与历史证据

**用户要求：** 每次执行获得全新可写 Debian libkrun guest，支持正常 apt/dpkg、每 VM passt/virtio-net、真实同 guest loopback、私有 PTY/shared memory/FD 设施及常规 Python/Node 路径；保留鉴权、manifest、资源上限和 teardown。

`d2794d4` 引入 manager、独立 ext4 scratch/overlay、passt supervisor、guest control-token middleware、NsJail config renderer、image/Compose target。[FP-003](engineering-tools-and-dependencies.md) 的非特权 payload 提取无法替代正常系统路径和 maintainer setup，这是独立模式。

## 行为与边界

- 一次执行一个全新 VM，manager 限制并发；health 不启动 VM。root image 只读，唯一 scratch overlay 提供 OS 修改。
- guest root 支持常规 `apt-get update/install`、dpkg；`/usr`、`/etc`、`/var` 等、可执行 `/tmp` 与 `/mnt/data` 只属于该 VM，`/pkgs` 保持基础 runtime 边界。不承诺 systemd 为 PID 1 或所有服务包可用。
- 每 VM 使用 passt-backed virtio-net，不回退 TSI。显式联网控制外部 egress；禁网时同一 jail 的 listener/client 仍可通过独立 loopback 通信。
- 私有 devpts/PTY、`/dev/shm`、`/dev/fd` 与标准 FD links、选定 guest proc 统计和常规 `/usr/bin/python`、`python3`、`node`、`nodejs` 可用。Debian 工具保留 distro Python，并对其应用匿名管道 patches。
- 每 VM 生成强 control token，保护 guest API 所有路由，拒绝缺失/错误 token，覆盖客户端伪造 header，token 不进入 jailed job env。签名 execution manifest 仍单独授权执行与产物。
- CPU/memory/PID/file/output/deadline 上限、readiness 失败、HTTP 错误语义、process group 终止、passt 清理、scratch 删除和 slot 释放必须保留。
- 返回成功前完成产物交付和 job cleanup；只有合格 `/mnt/data` artifacts 按合同保留，下个请求不能继承 OS/依赖/进程/session。

**非目标：** host root/包安装、持久机器、改变其他上游 session/bridge 模式、恢复 AF_UNIX tool-call transport 或 Python blocking 集成。

## 当前代码与固定上游等价性

| 路径 | 关键实现 |
|---|---|
| [manager](../../docker/full-debian-vm-manager.py) | `ManagerConfig`、`PortPool.lease`、`VmManager`、`running_passt_supervisor`、HTTP framing/limits |
| [passt supervisor](../../docker/passt-supervisor.py) | `start/stop/close`、ID/port validation、私有 control socket |
| [overlay](../../docker/full-debian-overlay.sh) | scratch `/dev/vdb`、每目录 overlay、私有 `/run`、machine-id |
| [NsJail renderer](../../api/src/full-debian-nsjail-config.ts) | `renderFullDebianNsJailConfig` |
| [guest auth](../../api/src/vm-control-auth.ts) | `validateVmControlAuthStartup`、`vmControlAuthMiddleware` |
| [Compose override](../../docker-compose.full-debian.yml) | Full Debian target 选择 |

集成锚点：[API Dockerfile](../../api/Dockerfile)、[entrypoint](../../api/src/entrypoint.sh)、[index](../../api/src/index.ts)、[nsjail](../../api/src/nsjail.ts)、[job](../../api/src/job.ts)、[launcher](../../launcher/src/main.rs)、[rootfs builder](../../docker/build-rootfs-image.sh)、[guest DNS](../../api/src/guest-dns.sh)、[checkpoint](../../api/src/session-checkpoint.ts)。

固定上游 `c854ab5f37c656e88e6e4ad8b834cc8d17659151` 已提供 baked block-root、manifest、supervisor、匿名管道、secure startup/cleanup，这些是可复用的等价基础；Lambda/stateful/hosted-app/remote-bridge 不是一次性可写 Debian，manager/overlay/passt 合同未被吸收。

## 冲突规则与最终决定

1. 保留当前管道执行、setup gate、supervised API 和 smoke stderr；未恢复已删除的 `tool-call-socket-proxy.test.ts`。
2. 保留 Bun 1.4.2、guest-dns/hosted-app assets、package runtime pipe patches；额外 distro Python 也执行 patch installer，未知 stdlib 布局 fail-fast。
3. `/run` 使用 remount，避免旧脚本再次挂载 tmpfs 遮蔽 resolver。rootfs 预建 DNS target，guest entrypoint 验证 virtio-net/DHCP 后才启动 API。
4. 原 manager 未启动 passt supervisor；现由 `running_passt_supervisor` 启停并验证 socket readiness，launcher passt 路径不竞争共享 DNS relay 端口。
5. 不恢复旧 netlink/audit 例外或 descriptor passing。AF_INET/AF_INET6 支持 loopback；禁网时保留 net namespace，启网才共享 VM 接口。
6. manager 强制 manifest 和一次性模式开关，控制 token 只通过 launcher allowlist 进入受信 API；现有 auth/manifest middleware 保留。
7. 跟踪 active launcher、shutdown 拒绝新任务、终止私有进程组（即使 leader 已退出）、限制 HTTP body 等待，保留 scratch/passt/slot 的 finally cleanup。
8. manager 的公开端点仍限 health 与 execute；当前默认 HTTP 执行路径不需要持久 session/discovery。manager 没有实现独立 metrics 聚合，不能宣称支持全部上游长会话功能。
9. 独立审阅确认旧基础 devpts 的 `gid=5` 在受限模式仅映射 GID 65534 时会导致 mount EINVAL。后续本地修复将基础配置改为 `gid=65534`，仅 Full Debian renderer 将 devpts 转为 `gid=5`，对应完整 `0:0:65536` GID 映射；保留 PTY options 与安全 mount flags。回归同时检查两种配置与实际 `buildArgs` 范围，不能只断言字符串存在。
10. 新增 renderer/测试的 CommonJS/import.meta 类型冲突已修复；使用 `require.main === module` 与 `__dirname`。测试实际运行 guest entrypoint 所用的 Bun CLI，验证输出等于 renderer 并具有 0600 权限。

## 正反向验收

本地 mock 需要 Python 3.11、Bun/API dependencies 和 Unix/loopback socket 权限，无需 KVM 或真实 passt：

```sh
python3 tests/full_debian_vm_manager_test.py -v
python3 tests/passt_supervisor_test.py -v
(cd api && bun test src/full-debian-nsjail-config.test.ts src/vm-control-auth.test.ts src/nsjail.test.ts src/job-cleanup.test.ts src/session-checkpoint.test.ts src/secure-startup.test.ts src/execution-manifest-request.test.ts)
bash -n docker/full-debian-overlay.sh api/src/entrypoint.sh
```

**正向 mock：** health 不分配、唯一 scratch 与 passt 配置、覆盖伪造 token、响应状态/body 保留、teardown 清理与释放容量；假 supervisor 可启动/回收。

**反向 mock：** 无效 ID/port/framing、重复/负 Content-Length、unsupported endpoint、错误 guest token、launcher 失败、supervisor 启动失败、closed manager、leader 退出后的进程组清理。

**审阅后配置回归：** 默认 devpts 不要求未映射 GID，Full Debian 仍使用已映射 tty GID 5；CLI 与函数渲染一致。相关七文件 139 pass，API 全量 510 pass / 2 skip / 0 fail；这是配置/进程 fixture 证据，未实际 mount devpts 或在 guest 打开 PTY。

**必须补做的真实验收：** 在隔离 KVM fixture 构建 `sandbox-runner-full-debian`，通过当前签名执行接口检查 guest UID 0、安装并运行 Debian 包、在 `/tmp` 编译执行、PTY/shm/FD、常规 Python/Node、同 guest nonce loopback；下载 `/mnt/data` 产物后确认 VM 消失。下次执行不得看到旧 OS/包/进程。启网/禁网、错误 token/manifest、timeout/overflow/cancellation/readiness failure 均须验证资源清空。

**限制：** `cargo check --tests` 通过，`cargo test --locked` 因缺 `libkrun` 无法链接；没有 Docker/KVM。mock 未证明真实 apt/dpkg 在当前 seccomp 下全兼容，也未覆盖所有资源/响应/取消组合。建议在发布前完成上述 live gates，不以 string-policy 断言代替。

## 退役条件

同一自托管后端的上游提供全新可写 Debian guest、正常包工具、真实 loopback、guest 设施、auth/manifest/limits、产物交付和可证明的 teardown，才能退役 manager/overlay。持久 cloud VM 或可写 host container 不等价。

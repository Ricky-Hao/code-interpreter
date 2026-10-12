# FP-003 — 工程工具与每次执行依赖层

**状态：必须保留；相关提交均已重放。** sandbox-pkg fixture 和生命周期测试通过；workspace-command 后续本地兼容修复已审阅，真实包安装未验收。

## 目标与历史证据

**用户要求：** 内置工程 CLI，提供 `sandbox-pkg pip|uv|npm|bun|apt|deb`，新依赖在同次执行立即可用、相互隔离并完整清理，采用当前上游 runtime 版本。

`067dd55` 增加依赖 workspace/installer，`bf9bcf4` 隔离测试的 workspace 创建，`9b0cfc5` 增加 CLI/Debian payload，`9edf12a` 修复不依赖 alternatives 的 nc，`618ec21` 提供身份/APT 文件与安全父目录遍历，`d2794d4` 增加不同边界的完整 Debian 模式。仅在镜像里安装二进制并不意味着 jail 能找到其别名、库和配置。

## 行为与边界

- 工具包括 git/git-lfs/gh、curl/wget/OpenSSH/rsync、rg/fd、patch/less/压缩工具/tree/which/time、GCC/G++/Clang/CMake/Ninja/pkg-config/binutils、SQLite、iproute2/ping/DNS/netcat/socat、lsof/strace/pstree、shellcheck/shfmt。`fd`、`awk`、`nc` 必须在 jail 内解析；特权操作仍受安全策略限制。
- 每次执行有独立、可执行的 `/mnt/deps`，带 `nosuid,nodev`，与 `/mnt/data` 分离。Python/JS imports、包二进制、cache/tmp 立即可用；保留 baked modules、CommonJS 和动态 ESM。
- 受限模式保持非特权、只读 OS/`/pkgs`、noexec `/mnt/data`；不能修改共享 runtime。
- sandbox-pkg 的 apt/deb 是可信源下载和 **payload 提取**，使用私有 APT/cache，不运行 maintainer scripts、`dpkg --install`、服务或修改系统。校验 specs/architecture、拒绝选项注入，清除 suid/sgid。
- 提取失败不能激活半成品，临时 archive 必须删除。清理删除 dependency lease 和合成 `node_modules` symlink，不删除用户真实目录。
- 依赖不得进入 artifacts/checkpoints，即使普通上游 session 工作区保留，依赖仍按执行销毁。保留 UID quarantine/retry、路径/符号链接校验和资源限制。
- 远程安装需 [FP-002](opt-in-network-dns-ca.md) opt-in；正常系统 apt/dpkg 属于 [FP-004](full-debian-microvm.md)。

**非目标：** 所有 Debian 包可重定位、宿主服务安装、任意特权诊断、跨执行持久依赖/进程、退回旧 runtime 或加入 Python blocking。

## 当前代码与固定上游等价性

- [sandbox-pkg](../../docker/sandbox-pkg)、[fixture](../../tests/sandbox_pkg.sh)。
- [job.ts](../../api/src/job.ts)：`sandboxDependencyEnv`、`removeDependencyNodeModulesSymlink`、`createDependencyWorkspace`、`dependencyWorkspaceLease`。
- [nsjail.ts](../../api/src/nsjail.ts)：`SANDBOX_DEPENDENCY_MOUNT`、`renderJobConfigOverlay`；[workspace isolation](../../api/src/workspace-isolation.ts)、[checkpoint](../../api/src/session-checkpoint.ts)。
- [API Dockerfile](../../api/Dockerfile)、[sandbox.cfg](../../api/config/sandbox.cfg)、[worker Dockerfile](../../docker/Dockerfile.worker-sandbox)、[launcher Dockerfile](../../launcher/Dockerfile)、[package-init](../../docker/package-init.sh)。
- 后续本地兼容修复：[workspace-command.ts](../../api/src/workspace-command.ts) 及其测试。

在固定 `c854ab5f37c656e88e6e4ad8b834cc8d17659151`，Python 3.14/Node 24/Bun、精选包、匿名管道 stdlib patches、现代 cleanup/metrics 已存在，应保留。其他 remote-code 后端有依赖功能，不等于吸收 HTTP/libkrun 的 `/mnt/deps` 合同。

## 冲突规则与最终决定

1. 以当前 Job lifecycle 合并 dependency lease，保留上游取消、cleanup metrics 和 UID 延迟释放。多个 lease 清理失败时，全部完成 retry 后再释放一次性 job UID。
2. session 只保留用户 workspace/UID，依赖单独清理；仅删除已识别的合成链接，保持 checkpoint 排除规则。
3. 保留测试用 workspace 创建 seam，不能用共享目录递归 chown 绕过测试失败。
4. 工具 mounts 与当前 runtime manifests 对齐，保留所有匿名管道 patches；不因 ip/ss 旧断言恢复 netlink 或 sendmsg 权限。
5. Full Debian 增加 distro Python 时也运行相同 stdlib pipe patch，未知布局令 image build 失败，而非静默使用未修补解释器。
6. 集成检查发现上游 workspace-command 调用需要适配新增 `dependencyDir`；后续本地修复创建独立 lease，并在正常/异常退出清理，已有测试扩展验证两种路径。
7. 独立审阅进一步发现仅传目录不足以支持包导入；workspace-command 现于 `aggregateBashExtras` 后复用 `sandboxDependencyEnv`，保留原 runtime 搜索路径并加入 Python/Node/二进制/缓存路径，预建并按 workspace identity 拥有 `tmp/.cache/bin`。
8. Job 的 `removeDependencyNodeModulesSymlink` 导出复用；workspace-command 执行前清理上次残留，finally 删除本次合成链接，嵌套 finally 确保链接清理失败也尝试清理 lease。只删指向 `/mnt/deps/js/node_modules` 的 symlink，不删除真实目录或其他用户链接。

## 正反向验收

```sh
(cd api && bun test src/job-helpers.test.ts src/job-cleanup.test.ts src/job-cleanup-metrics.test.ts src/workspace-isolation.test.ts src/session-checkpoint.test.ts src/nsjail.test.ts src/workspace-command.test.ts)
bash -n docker/sandbox-pkg
bash tests/sandbox_pkg.sh
```

shell fixture 需要 Bash/coreutils、Node、支持的 Linux 架构及隔离环境的 root/免密 sudo，以允许测试专用临时 root override；包管理器被替换，不下载真实包。

**正向：** pip/uv/npm/bun 路由、动态 ESM+baked import、Debian payload 搜索路径、headers/libs/pkg-config/CMake/shared-data、身份/APT 可见、每次独立 lease。

**反向：** 拒绝 relative root、未知架构、恶意 package spec、无精确候选包、提取失败；断言 suid/sgid 与 archive 删除、不继承先前依赖、不导出到 checkpoint、不删真实 node_modules；prime 失败/取消/超时仍清理。

**已验证（审阅后）：** sandbox-pkg fixture 再次通过；七文件依赖/配置/cleanup/checkpoint 聚焦 139 pass，完整 API 510 pass / 2 skip / 0 fail。Python 与 Node 使用真实本地解释器导入临时 fixture 模块，测试仅将 `/mnt/deps`/`/mnt/data` 映射为临时路径，没有运行真实 jail 或下载 registry 包。合成链接在成功/抛错后消失；真实 node_modules 数据及无关 symlink 在两条路径均保留。
**未验证：** 实际 jail 中完整工具 inventory、安装/import 真实 pinned Python/JS 包、重定位 Debian 工具、下一 VM 的清空效果。建议在隔离 runner 同时检查禁网/启网、只读基础 OS 与 `/mnt/data` 产物交付。

## 退役条件

同一上游 HTTP/libkrun runner 必须提供相同 CLI 清单、私有可执行依赖层、语言搜索路径、Debian 提取安全与生命周期排除合同并通过正反向验收。共享 cache 或持久 remote 环境不是等价替代。

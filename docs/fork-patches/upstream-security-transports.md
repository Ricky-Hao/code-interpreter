# FP-006 — 上游安全与匿名管道约束

**状态：上游已有、持续强制保持。** 本次所有历史提交均已重放并适配；没有恢复旧 socket-proxy transport。

## 目标与历史证据

**用户要求：** 保留最新上游 anonymous-pipe tool-call/runner supervisor、FD 隔离与关闭、结果/错误、startup、manifest/auth 和 cleanup 修复，保留现代 adapter；不能为 Full Debian 恢复 AF_UNIX descriptor passing。

固定上游 `c854ab5f37c656e88e6e4ad8b834cc8d17659151` 使用匿名管道并禁止 descriptor-passing syscall。旧 `b57e4f3` 改写较老 seccomp，`6e4a296` 删除较老 CI，`d2794d4` 修改已被删除的 tool-call-socket-proxy 测试；这些冲突必须按行为解决，不能盲目 replay。

## 行为与边界

- 只有获得授权的 tool-call job 拿到请求写 FD 3/响应读 FD 4。spec-guard 验证 FIFO 类型/方向并关闭无关 FD；普通 job 无此 capability。
- subprocess stdin/stdout/stderr、NsJail control/startup 使用匿名管道；多路大流保持 backpressure，spawn failure/exit/EOF/cancellation 不泄漏 FD 或留下 blocked writer。
- 保留 socketpair/sendmsg/sendmmsg/io_uring、PI-futex、VSOCK、namespace 和 supervisor-signal 防护；[联网例外](opt-in-network-dns-ca.md) 不能扩展为 IPC descriptor 权限。
- 保留 manifest/capability scope、close-on-exec、auth、fail-fast startup；guest control token 与 artifact grant 不替代签名执行授权。
- 保留 overflow/truncation、timeout/signal/error 字段、setup-gate race 处理、stdout/stderr drain、cleanup ordering 和 retained workspace/UID 安全。
- 保留 Python/Node/Bun、remote bridge/hosted app 及其回归。一次性 Debian 不改变其他 adapter 的持久语义。

**非目标：** 新 PTC 或 Python blocking、绕过 seccomp、恢复 AF_UNIX 以求方便、删除 adapter、用 policy 字符串测试宣称真实 exploit 已被阻断。旧 CodeAPI 审计不能推断当前上游行为。

## 当前代码与上游等价性

- [pipe-process.ts](../../api/src/pipe-process.ts)、[anonymous-pipes.c](../../api/src/anonymous-pipes.c)。
- [tool-call-pipe-broker.ts](../../api/src/tool-call-pipe-broker.ts)、[bridge C](../../api/src/tool-call-pipe-bridge.c)、[spec-guard.c](../../api/src/spec-guard.c)。
- [supervisor-policy.c](../../api/src/supervisor-policy.c)、[NsJail control patch](../../docker/nsjail-anonymous-control.patch)、[Python patches](../../docker/python-runtime/install.py)。
- [nsjail.ts](../../api/src/nsjail.ts)、[setup gate](../../api/src/nsjail-setup-gate.ts)、[job](../../api/src/job.ts)、[secure-startup](../../api/src/secure-startup.ts)、[preamble](../../service/src/preamble.ts)、[CI](../../.github/workflows/ci.yml)。

这些保护已由固定上游提供，不需要另造 fork transport；它们是所有 fork 增量的横向回归约束。

## 冲突规则与最终决定

1. 以现代 pipe runner 为基础叠加 mounts/env/identity；Full Debian 保留 supervisor、guest DNS、startup 错误语义和 pipe grants。
2. 旧 netlink 断言已改成验证当前 deny 合同；不为 ip/ss 或 audit 兼容解除 sendmsg/socketpair。无法兼容的真实程序应报告具体冲突。
3. 保留 native addon 和 runtime patch 的镜像构建步骤，Full Debian distro Python 同样 patch。
4. CI 删除冲突保留上游全部检查；后续本地发布协调修复使 fork 发布依赖这些检查。
5. 删除冲突中的旧 socket-proxy 测试副本；行为验证迁移到当前 NsJail pipe/auth 测试，不恢复旧实现。

## 正反向验收

按[索引](README.md)构建 native addon 后：

```sh
(cd api && bun test src/pipe-process.test.ts src/tool-call-pipe-broker.test.ts src/nsjail.test.ts src/nsjail-setup-gate.test.ts src/secure-startup.test.ts src/execution-manifest-request.test.ts src/execute-capability.test.ts src/job-cleanup.test.ts)
(cd service && bun test src/preamble.test.ts src/preamble-bash.test.ts src/internal-service-auth.test.ts src/execution-manifest.test.ts)
mkdir -p node_modules/.fork-validation
gcc -O2 -static -Wall -Wextra -Werror -o node_modules/.fork-validation/spec-guard api/src/spec-guard.c
SPEC_GUARD_BINARY="$PWD/node_modules/.fork-validation/spec-guard" python3 tests/specguard_tool_call_pipes.py
gcc -O2 -static -Wall -Wextra -Werror -DSPEC_GUARD_TEST_DISABLE_CLOSE_RANGE -o node_modules/.fork-validation/spec-guard-fallback api/src/spec-guard.c
SPEC_GUARD_BINARY="$PWD/node_modules/.fork-validation/spec-guard-fallback" python3 tests/specguard_tool_call_pipes.py
```

**正向：** 有效 FIFO grant、并发多 MB 流、broker 正确结果、早期 child 输出、正常 futex wait/wake、必要 TCP supervisor 流量。
**反向：** unrelated/reversed/non-FIFO FD 不保留；缺 executable、kill、blocked stdin、broker EOF 正确结束；错误 manifest/capability 拒绝；启网/禁网均拒绝危险 IPC API。

**已验证：** 审阅后 API 510 pass / 2 skip / 0 fail、service 沿用未变源码的此前 1214 pass / 17 skip / 0 fail；spec-guard 正常/fallback 各四项 FD 检查，supervisor warnings-as-errors 编译通过。devpts 修复不扩展默认 UID/GID 映射，依赖修复复用既有 env/链接清理，不放宽 IPC 政策。
**历史证据：** 初测 FD 回收失败及后续复测记录完整保留在[索引](README.md)指定的外部报告；最终通过不能用于抹去历史失败或推断其原因已确定。

**镜像/live gates 未执行：** `ci.yml` 的 `nsjail-ipc-tests` 构建 NsJail/Kafel 并运行 `nsjail_unix_gc.py`、`tool_call_pipes.py`、`supervisor_policy.py`、`supervisor_dns.py`、`pipe_relay_backpressure.py`、`pipe_runtime_image.cjs` 和 hosted-app 网络检查。它们需要隔离 Docker image/capabilities；本地 mock 不证明真实 filter、Python/Node image IPC、hosted-app 或 Full Debian 安全运行。

## 退役条件

这不是等待“上游吸收”后删除的 fork 功能。只有新的上游设计以替代回归证明相同或更强 FD/capability/生命周期隔离，才能退役特定实现断言；禁止回退不安全 IPC 的行为要求持续有效。

# FP-002 — 显式联网、DNS 与 CA 信任

**状态：必须保留；已重放并完成静态/fixture 验证。** DNS relay 使用上游等价实现；实际 guest 联网和 TLS 尚未验收。

## 目标与历史证据

**用户要求：** 只有显式 opt-in 才允许公网/私网访问，默认禁网；正确传递 resolver、私有搜索域与 CA trust，并保留现代安全防护。

**实现证据：** `b57e4f3` 加入布尔解析、网络策略和 resolver helper；旧公共 DNS fallback 无法满足私有域名解析。`9436ea1` 改为离线策略测试；`5d314d9` 暴露 CA；`9b0cfc5` 增加网络 CLI；`d2794d4` 加入 passt/virtio-net。

## 行为与边界

- 缺失/非法 `SANDBOX_DISABLE_NETWORKING` 值保持禁网；`safeBoolean` 与 shell helper 对显式 false-like 值一致。
- 默认受限模式使用独立 net namespace，拒绝普通 Internet socket；启用后只放行必要的 AF_INET/AF_INET6。产物/工具网关授权不是通用流量防火墙。
- Full Debian 禁止外网时仍允许独立 net namespace 内的 loopback；不得因允许本地 socket 而使用 `--disable_clone_newnet` 接通外网。
- 保留 nameserver、search/options 和服务域名；容器 loopback resolver 经正确 relay，非法/缺失解析配置 fail-fast，不悄悄替换公共 DNS。
- 受限 jail 的 `/etc/ssl/certs` 只读，TLS 不跳过证书验证；Full Debian 只可改动自己的临时 guest trust。
- metrics ingress 独立于 egress 开关。socketpair/sendmsg/sendmmsg/io_uring、VSOCK 和 kernel-control family 约束遵循 [FP-006](upstream-security-transports.md)。

**非目标：** 生产私网或集群测试、DNS bypass、默认联网、所有流量强制走产物网关、保留旧 B64 编码本身，或让每种特权网络诊断都可用。

## 当前代码与固定上游等价性

[config.ts](../../api/src/config.ts) 的 `safeBoolean`；[nsjail.ts](../../api/src/nsjail.ts) 的 `buildSeccompPolicy`/`buildArgs`；[entrypoint](../../api/src/entrypoint.sh)；[resolver helper](../../docker/runtime-resolver.sh)；[launcher entrypoint](../../launcher/entrypoint.sh)；[main.rs](../../launcher/src/main.rs)；[guest-dns.sh](../../api/src/guest-dns.sh)；[NetworkPolicy](../../helm/codeapi/templates/network-policy.yaml)；[sandbox.cfg](../../api/config/sandbox.cfg)。

固定上游 `c854ab5f37c656e88e6e4ad8b834cc8d17659151` 已提供 `canonical_loopback`、`encode_resolv_conf`、`start_resolver_relay`、guest 私有 `/run/codeapi-resolver/resolv.conf`、自定义 `LAUNCHER_EXEC` wrapper 和 Rust 环境长度/编码检查。这些覆盖旧 fallback 的必要行为，但未吸收 fork 的普通网络 opt-in。

## 冲突规则与最终决定

1. 保留上游 relay、wrapper 和 env 限制；jail helper 读取已配置的 guest resolver。B64 仅为兼容入口。
2. 不恢复旧 netlink 白名单：工程工具可安装，但 kernel-control families 仍被拒绝。Full Debian 的联网与本地 loopback 用 Internet families 实现。
3. NsJail job 最后设置 `RES_OPTIONS=single-request`，与上游 supervisor 一致，避免 glibc DNS 使用被禁止的 sendmmsg；不放宽 descriptor API。
4. Full Debian 将已有 `/run` tmpfs remount，避免另盖 tmpfs 隐藏 DNS。三个 API rootfs 路径都准备 guest DNS 目标。
5. Passt 路径不启动共享 TSI 53 端口 relay；每 VM 在 API 启动前经 virtio-net/DHCP 配置 DNS，缺接口/DHCP 失败立即退出。
6. Helm 测试已改为离线渲染，保留 metrics ingress peers。fixture 成功不能替代 jail 中真实解析 syscall 的测试。

## 正反向验收

```sh
(cd api && bun test src/config.test.ts src/config-defaults.test.ts src/nsjail.test.ts)
bash tests/kvm_guest_dns.sh
bash tests/runtime_resolver_handoff.sh
bash tests/network_policy_networking.sh
bash tests/sandbox_runner_metrics.sh
```

前两个 shell fixture 不需要集群；策略/metrics 渲染需要本地 Helm、jq、Python/PyYAML。

**正向：** 私有/routable resolver、search/options、多种 loopback 表示、自定义 guest 入口、显式联网、Full Debian 独立 loopback 和 CA mount。启用 egress 渲染为 `[{}]`，metrics 来源仍明确限定。

**反向：** 非法/缺失 nameserver、过长 handoff、stale resolver symlink、relay 未 ready、非法开关、默认外网访问、网络启用后的 descriptor/kernel-control socket 仍受拒绝。禁网渲染不得出现宽泛 `{}` egress。

**已验证：** 上述配置/策略断言包含在审阅后 API 510 pass / 2 skip / 0 fail 内；四个 DNS/策略/metrics shell 检查沿用此前通过证据，passthrough 无共享 relay fixture 通过。
**真实验收未执行：** 在隔离 KVM fixture 中分别解析受控公网域名和私有服务，服务换 IP 后仍按域名连接，可信 TLS 成功且不可信证书失败；禁网时相同外部连接失败、同 guest nonce loopback 成功。不能用静态测试声称 CA/apt 联网已成功。

## 退役条件

上游同一 runner/jail 模式提供安全默认、显式公网/私网联网、DNS/CA 与等价策略验收后，才可退役整个补丁。单独 DNS 等价只允许删除重复 resolver 代码。

# FP-001 — 自托管与 fork 镜像发布

**状态：必须保留；11 个提交重放完成。** 默认 HTTP、六镜像命名属于原始重放；发布流程协调和不可变标签预检属于已审阅的后续本地集成。本次集成未发布或部署，真实镜像构建/发布未验收。集成边界见[索引](README.md)。

## 目标与历史证据

**用户要求：** 默认部署使用无 AWS 依赖的 HTTP/libkrun，从检出的 fork 源码构建六个自有 amd64 镜像，使用不可变 SHA 标签并记录 OCI digest。发布由 fork 控制，保留上游新增回归和安全 CI。

**实现证据：** `b57e4f3` 增加镜像 CI、删除 `open-sync-pr.yml`；`03afea0` 修正命名；`9436ea1` 使策略测试脱离集群；`6e4a296` 整合 CI；`d2794d4` 将既有 sandbox-runner 镜像切至 Full Debian target。Compose 默认仍是 baked KVM，不能把两个选择混为一谈。

## 行为与边界

- 默认 API/worker 不要求 AWS 凭据、Lambda、ECR；本地/S3 兼容存储可用。保留可选 Lambda/stateful/remote-bridge 的既有 profile 隔离。
- 六个包为 `ghcr.io/ricky-hao/code-interpreter-{api,worker,file-server,egress-gateway,tool-call-server,sandbox-runner}`，架构 `linux/amd64`；本地检查可以覆盖额外 build target。
- 源码来自当前 checkout，不下载 monorepo snapshot。标签为 `sha-<full-commit>` 与 `sha-<12-character-commit>`，每个镜像记录 digest，不新增 `latest` 或可变 `main` 发布。
- 重跑不得覆盖已有 SHA 内容。两个标签存在且 revision/digest 相符时复用；碰撞、部分发布、权限或 registry 故障必须失败，而非当作“镜像不存在”。
- PR 只能验证；发布权限必须按 job 显式授予，仅默认分支允许发布。上游原生 IPC、安全、cleanup、launcher、bridge 等检查仍可达。
- 保留 baked/default 与 direct 开发路径；Full Debian 的不同生命周期遵循 [FP-004](full-debian-microvm.md)。

**非目标：** rebase 时执行 push/release/deploy、改变 registry 所有者、增加架构、迁移部署、删除可选 AWS 适配器或恢复上游七镜像发布方案。

## 当前代码与固定上游等价性

- [build-images.yml](../../.github/workflows/build-images.yml)、[ci.yml](../../.github/workflows/ci.yml)、[标签预检](../../.github/scripts/fork-image-tags.sh)。
- [service Dockerfile](../../service/Dockerfile)、[API Dockerfile](../../api/Dockerfile)、[Compose](../../docker-compose.yaml)。
- [execution-profile.ts](../../service/src/execution-profile.ts)、[backend selection](../../service/src/sandbox-backend/index.ts)。

在 `c854ab5f37c656e88e6e4ad8b834cc8d17659151`，HTTP/default、源码构建、baked block-root 和大量 CI 已存在，属于应保留的部分等价实现。`service/Dockerfile` 有 `api`/`worker` stages；`service/Dockerfile.api` 与 `.worker` **也仍存在**且有 Bun 1.4.2 的 `production` target。不能依据 README 表格推断旧文件被删除。fork 的所有权、六镜像合同与发布策略没有被上游吸收。

## 冲突规则与最终决定

1. `6e4a296` 删除 CI 的冲突已解决为保留 `ci.yml` 全部上游检查。
2. 后续本地集成将 `ci.yml` 作为可复用 workflow，发布 job 依赖它；更新 Bun 1.4.2、原生 addon 编译和 Redis fixture 前置条件。
3. 后续本地集成将 `images.yml`/`release.yml` 的入口限制为原上游仓库；fork 使用 `build-images.yml`，未删除上游检查。
4. 发布矩阵保持五个 service 镜像与一个 Full Debian runner；验证矩阵额外包含 baked runner，不代表发布第七个包。
5. 同一 ref 的发布不互相取消；只对 PR 取消旧运行。不可变预检与 digest 输出已经加入，不能只检查标签拼写。
6. 保留目标/版本与当前源码对应关系；旧 Bun 1.3.14 不是需保留的需求。

## 正反向验收

前置条件见[索引](README.md)。本地可运行：

```sh
bash tests/fork_image_tags.sh
(cd service && bun test src/execution-profile.test.ts src/config.test.ts src/sandbox-backend/index.test.ts src/sandbox-backend/http.test.ts)
(cd api && bun run build)
(cd service && bun run build)
bash tests/sandbox_runner_healthcheck.sh
```

**正向：** 六个发布 package identity 与各自 target 存在；默认 HTTP 不调用 AWS；新标签可构建、已存在标签复用同 digest；source/revision label 指向 checkout。

**反向：** PR 不发布、非默认分支不发布、SHA 碰撞/部分标签/registry 权限失败不覆盖、不生成 latest、不丢失上游安全 job、错误 profile 路由被拒绝。标签测试的 registry 命令是 mock。

有 Docker/Buildx 的隔离测试机还应执行：

```sh
bash tests/block_root_package_delivery.sh
bash tests/package_init_runtime_rollout.sh
docker buildx build --check --platform linux/amd64 --target production -f service/Dockerfile.api .
docker buildx build --check --platform linux/amd64 --target sandbox-runner-full-debian -f api/Dockerfile .
```

**已验证：** service 全量 1214 pass / 17 skip / 0 fail，API/service build 通过；六种标签 fixture、healthcheck、YAML/target 结构及三个工作流的 actionlint 通过。
**限制：** 无真实 registry/Buildx 执行；block-root 因 Docker 缺失失败。actionlint 1.7.7 全仓检查不支持上游已有 alias。工作流静态有效不能证明镜像可构建或发布成功。

## 退役条件

上游必须可配置地提供同一 AWS-free HTTP/libkrun 默认、fork 自有六镜像源码发布、不可变标签/digest 及等价 CI，且 fork 明确采用该配置，才能删除重复代码。一次上游 release 不能满足条件。

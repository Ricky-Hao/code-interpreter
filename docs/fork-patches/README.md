# Fork 长期行为需求

**集成记录（2026-10-12）：原始 11 个提交已全部完成本地 rebase。**
原始重放过程中没有跳过或合并提交；文档、发布协调及审阅修复属于后续本地集成。
“完成 rebase”不等于完成真实 MicroVM 或镜像发布验收；未通过和未执行的检查见下文。

**独立审阅后更新：** 默认 devpts 未映射 GID，以及 workspace-command 的依赖环境/合成链接清理均已修复并通过审阅，范围内无剩余必修问题。后续本地集成不改变原始 11/11 重放映射。

## 基线、权威来源与证据

- 固定上游基线：`c854ab5f37c656e88e6e4ad8b834cc8d17659151`。
- 原 fork tip：`d2794d4bdab9c64fe9560a5b574753a4502331f3`；保护引用：`backup/pre-upstream-rebase-d2794d4`。
- 原始 11 提交的 rebase 终点：`4529d241b1b7e2db0cd431be9f465d7421b57042`；这是历史边界，不代表后续本地提交后的当前 HEAD。
- 证据报告：`/workspaces/code-interpreter-rebase-20261012/report.md`；原始日志：`node_modules/.rebase-tools/*.log`。
- **用户要求**是必须保持的行为；**实现证据**描述实际代码；**建议**只表示推荐的验收方式，不增加任务范围。
- 本目录以行为组织，不要求逐行重放旧补丁。部分功能已被上游等价实现吸收，但需求本身仍需保持。

历史实现可直接读取，例如 `git show d2794d4:docker/full-debian-vm-manager.py`；不要为查看历史而覆盖当前文件。

## 需求索引

| ID | 行为需求 | 集成及吸收状态 |
|---|---|---|
| [FP-001](publishing-self-hosting.md) | 自托管与 fork 镜像发布 | 六镜像及默认 HTTP 已重放；本地发布协调修复已审阅；真实构建未验收 |
| [FP-002](opt-in-network-dns-ca.md) | 显式联网、DNS、CA | 已重放；采用上游 DNS relay；离线策略/解析器测试通过 |
| [FP-003](engineering-tools-and-dependencies.md) | 工程工具与每次执行依赖层 | 已重放；保留上游清理；workspace-command 本地兼容修复已审阅 |
| [FP-004](full-debian-microvm.md) | 一次性可写 Debian MicroVM | 已重放并适配现代管道、DNS、passt 生命周期；mock 通过，真实 VM 未验收 |
| [FP-005](file-upload-artifact-contract.md) | UTF-8 上传、元数据回退、产物 | 已重放；UTF-8/回退部分采用上游等价实现；API/service 测试通过 |
| [FP-006](upstream-security-transports.md) | 上游安全和匿名管道约束 | 上游已有，完整保留；新增 fork 行为必须持续遵守 |

## 全部提交映射

11/11 原始提交一一重放。下表只映射原始重放，不包含后续文档、发布协调及审阅修复；不能用重放终点代替完整集成版本。

| 原提交完整 SHA | 新提交完整 SHA | 行为 / 需求 ID |
|---|---|---|
| `b57e4f35d9c7b30a07b93ec1c4b05b8b8ea3f88c` | `569493bf67c8aa695eae13f82b14bee6d7fa7af8` | 自托管、镜像、联网、上传；FP-001/002/005/006 |
| `9436ea19672cd6a15c24e972166d5799422aaddc` | `1b348964c348c6b6148e94a367885925a6577f4c` | 离线策略测试；FP-001/002 |
| `03afea0927e2eb7fb5c00dc44a3cc0cbfba5b718` | `dd02d0f36fd77e3e2e9b7e69b5769469f707e60a` | fork 镜像命名；FP-001 |
| `6e4a2964798831d0826e8e6105899c11ba5707fb` | `94c8f75dad7ccba35898e5dc8a1744f48f4a4763` | CI 整合并保留上游检查；FP-001/006 |
| `5d314d944083a531d2f3366cc98433ad9d5081b7` | `28b9de809f0b6a454fe5f56270189f21255ffde0` | CA 信任；FP-002 |
| `067dd551e30dce67def69a0445a980fcfa5609e3` | `d884755f10657301def8c67fcd61fc90ac1c0234` | 每次执行依赖层；FP-003 |
| `bf9bcf48498035d4c81e47351f93eacd0270249c` | `5e7209d285ba91b8febc3917cc86cbab0f6f236b` | 隔离清理测试；FP-003 |
| `9b0cfc550d51d1d29d6593cde0318e40bc876a93` | `cee7019a2ad200d799181ef5403693c5ec133daa` | 工程 CLI、Debian payload；FP-003/002 |
| `9edf12aa0540259bdb7b40e76da788c55ac72c1f` | `56f3ee91d20e15511f019dd4c6b220ffd394ab06` | 可用的 nc 别名；FP-003 |
| `618ec2171ba0f9545061485da877bd4b97754944` | `baa81b8e66eb8ee20f3da7f25c7c60a5cd10925e` | jail 工具、身份/APT 文件及目录遍历；FP-003 |
| `d2794d4bdab9c64fe9560a5b574753a4502331f3` | `4529d241b1b7e2db0cd431be9f465d7421b57042` | Full Debian、passt、guest auth 及现代兼容；FP-001 至 FP-006 |

## 后续 rebase 规则

1. 先读本目录及报告最新追加章节，检查 HEAD、index、worktree、todo、原补丁和固定上游等价实现。保护备份与未提交内容。
2. 按可观察行为解决冲突；优先采用满足合同的上游新实现，记录吸收证据。不得恢复被删除的 socket transport 或弱化安全测试。
3. 精确暂存已审阅文件。删除旧 CI 必须先保留等价新检查；提交变空、需求冲突或无法满足的安全边界需要具体证据，不能盲目跳过。
4. 先跑相关测试，保留初次失败；按原因修复后复测。区分静态、mock、本地进程测试和真实 VM 验证。
5. 更新状态与完整 SHA 映射。额外修复不能悄悄混入无关历史提交，应单独审阅并按本地提交授权处理；本地提交不等于发布或部署授权。

## 验收前置条件

命令默认从仓库根目录执行。JS 使用当前 manifests/locks 和 Bun 1.4.2；本次 Node 为 24.16.0。原生管道测试需要 Linux、GCC 和 Node headers：

```sh
(cd api && bun ci && bun run build)
(cd service && bun ci)
NODE_HEADERS="$(dirname "$(dirname "$(command -v node)")")/include/node"
gcc -shared -fPIC -O2 -Wall -Wextra -Werror -I"$NODE_HEADERS" \
  -o api/.build/anonymous-pipes.node api/src/anonymous-pipes.c
```

本次验证使用禁用 lifecycle scripts 的有界 npm 安装，未改 manifests/locks，**不是冻结锁文件复现**；安装尝试的历史记录见外部报告。Bash preamble 需要 jq，完整 service 测试需要能启动本地 Redis fixture 的 `redis-server`。这些工具均局部安装。策略渲染使用 Helm/jq/PyYAML；manager/passt 测试使用 Python 3.11 和本地 Unix/loopback socket。Rust 1.90 局部安装后 `cargo check --tests` 通过；完整链接需要 libkrun。

## 集成验证与限制（2026-10-12）

- 包含审阅修复的本地集成：API **510 pass / 2 skip / 0 fail**（1944 assertions）；相关七文件聚焦 **139 pass**，API 构建通过。service 源码未变，沿用此前 **1214 pass / 17 skip / 0 fail** 和构建通过证据，文档整理未重跑其全量测试。
- 新回归将 devpts 配置中的 GID 与实际 `buildArgs` 映射交叉校验；默认 GID 65534、Full Debian GID 5 均在映射内。真实 user-namespace mount 尚未执行。
- workspace-command 已验证 Python/Node fixture 真实导入、依赖 cache/tmp 配置、成功/异常清理旧/新合成链接，以及保留真实 node_modules/无关 symlink；不等同于真实 pip/npm 联网安装。
- manager **16** 个 mock/本地假进程测试、passt **3** 个 mock 测试、sandbox-pkg fixture、六种不可变标签 fixture 均通过。
- DNS/解析器、离线 NetworkPolicy、metrics 和 healthcheck 测试通过；spec-guard 正常及 fallback 各四种 FD 检查通过。
- 历史失败、诊断归因及复测过程单独保留在外部报告，不能用最终通过结果抹去原始证据。
- `tsc --noEmit` 仍 exit 2，但 **本次引入的 9 项 API 诊断已修复**：`full-debian-nsjail-config.ts` 一项、对应测试四项、`nsjail.test.ts` 四项。CLI 改为 CommonJS 兼容入口并实际运行验证，测试读取路径改用 `__dirname`。没有改全仓 tsconfig。
- 同一依赖下对固定上游源码快照重新 typecheck：API 基线/最终各 **7 项**，service 基线/最终各 **7 项**，忽略行号后路径、错误码、消息和数量完全一致，新增 **0 项**。基线诊断涉及 Buffer/fetch、hosted-app narrowing、原有 import.meta/top-level await、headers/casts；完整分类见报告与 `review-typecheck-comparison.log`。这不是声称全仓 typecheck 已通过，也不是冻结 lock 复现。
- `cargo test --locked` 仍受缺失 `-lkrun` 限制；`cargo check` 不是运行 launcher 测试。未更改追踪依赖。
- 三个修改工作流通过 actionlint 1.7.7；其全仓模式不支持上游 `images.yml` 已有 YAML alias，保留失败。YAML/目标结构检查另行通过。
- Docker/Buildx、真实 KVM/libkrun、真实 apt/dpkg、guest DNS/TLS/loopback、运行中 seccomp、产物端到端及部署验收未执行。block-root 检查因缺少 Docker 未完成。
- 没有 push、release、deploy、生产访问或 Python blocking 集成。旧 CodeAPI 审计不能替代当前上游实现的验证。

## 退役原则

只有同一后端的上游实现满足相同正反向验收时，才可移除重复 fork 代码；不能因为名字相似、补丁已合并或其他后端提供功能而退役需求。各文档给出具体条件。

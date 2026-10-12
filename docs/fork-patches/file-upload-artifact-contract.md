# FP-005 — UTF-8 上传、元数据回退与产物合同

**状态：必须保留；已重放。** UTF-8/元数据/产物流程部分采用上游等价实现，保留 fork 授权后 alias 去重；API/service 回归通过，真实存储/VM roundtrip 未验收。

## 目标与历史证据

**用户要求：** 保留 UTF-8 上传、filename metadata fallback 和现有产物交付。`/mnt/data` 产物在销毁执行环境后可下载，不要求进程持久化。

`b57e4f3` 增加 UTF-8 parser 回归和已授权对象 alias 去重。当前上游已设置 UTF-8 field/parameter charset、保留相对路径、处理缺失 metadata/opaque filename。`d2794d4` 的一次性 VM 必须沿用交付后清理顺序，避免乱码、路径丢失、回退名称错误和未授权 alias 被提前消除。

## 行为与边界

- 单个和 batch multipart filename 按 UTF-8 解码，保留合法相对子路径；路径验证、上传大小上限、ownership 登记与 session fencing 继续有效。
- 区分已验证原始 metadata 和 opaque storage key，兼容 legacy/base64 metadata；没有可信原名时保持 caller fallback，下载使用标准 UTF-8 disposition。缺 metadata 不等于免授权或信任任意 header/path。
- 每个输入引用都必须先做 resource/session/upload ownership 校验，再按 storage session + object ID 去重。不能按目标文件名去重，两个同名不同对象不能被静默合并。
- 保留 manifest/grant/internal-service auth、resource/storage ID 区别、大小/路径/symlink 防护、下载取消/重试/错误语义。
- 先上传合格产物，再清理 workspace/VM，再返回结果；不是保证返回所有目录项。
- 保留 `artifact_delivery`、`artifact_truncation`、`deleted_files`：不完整扫描不能报告推测删除，交付失败不能伪装成成功的空列表。

**非目标：** 新存储协议、持久进程/OS、绕过鉴权或限制、任意绝对上传路径、扩大产物类型或 Python blocking；其他 stateful adapter 维持自己的合同。

## 当前代码与固定上游等价性

- [upload-parser.ts](../../service/src/service/upload-parser.ts) 的 `createUploadParser`；[router.ts](../../service/src/service/router.ts) 单个/batch 路由。
- [file-authorization.ts](../../service/src/service/file-authorization.ts) 的 validate/authorize；[upload-session.ts](../../service/src/service/upload-session.ts)。
- [file-metadata.ts](../../service/src/file-metadata.ts) 的 `originalFilenameFromMetadata`、`decodeOriginalFilename`、`contentDispositionForOriginalFilename`、`isOpaqueObjectContentDisposition`。
- [file-object-resolver](../../service/src/file-object-resolver.ts)、[egress gateway](../../service/src/egress-gateway.ts)、[job](../../api/src/job.ts)、[v2 routes](../../api/src/api/v2.ts)。

固定上游 `c854ab5f37c656e88e6e4ad8b834cc8d17659151` 已有 `defCharset: 'utf8'`、`defParamCharset: 'utf8'`、`preservePath: true`，以及 metadata/交付错误/cleanup 合同。fork helper 只是可测试封装，授权后的 storage-alias 去重是剩余增量。

## 冲突规则与最终决定

1. helper 保留两个 UTF-8 charset、相对路径、limits 和后续 validation；`Readable` 仍是 runtime value import。
2. 保留上游 ownership/bridge/manifest/timeout 准备，不用旧 router 整文件覆盖。
3. 去重发生在所有引用授权之后，包括 resource identity 不同的 alias；保留独立对象。
4. filename fallback 使用上游 helpers，保留 sealed-handle 和 internal redirect 防护。
5. Full Debian manager 等 guest 响应完整后才回收；guest 仍走现有上传/cleanup 流程，不新增旁路，也不宣称 mock 已证明真实交付。

## 正反向验收

```sh
(cd service && bun test src/service/upload-parser.test.ts src/service/upload-session.test.ts src/service/file-authorization.test.ts src/file-metadata.test.ts src/file-download.test.ts src/file-object-resolver.test.ts src/internal-service-auth.test.ts)
(cd api && bun test src/download.test.ts src/delivery.test.ts src/api/v2-files.test.ts src/api/v2-cleanup.test.ts src/api/v2-timeout.test.ts)
```

**正向：** 非 ASCII 名称精确 roundtrip、合法 nested path、metadata 与缺失回退、授权后同对象去重、不同对象保留、正确 bytes、响应在 upload/cleanup 后完成。

**反向：** 一条合法 alias 不能掩盖另一条未授权引用；拒绝 ownership 缺失、非法 session/resource、绝对路径/traversal/symlink/oversize；opaque key 不能冒充原名；不完整 scan 保留 truncation/error 且不虚构删除。

**已验证：** service 沿用此前完整 1214 pass / 17 skip / 0 fail，审阅后 API 完整 510 pass / 2 skip / 0 fail；build 通过。workspace-command 链接清理另有成功/失败下保留用户真实目录与无关链接的回归。早期聚焦测试记录见外部报告。
**未验证：** 真实 HTTP/storage/Full Debian roundtrip。建议使用 fixture storage 上传中文 nested 文件，按返回引用执行并生成 `/mnt/data` 产物，VM 销毁后下载比较名称/bytes；metadata 缺失重复一次，另一测试主体的引用必须失败。parser unit 不能代替端到端覆盖。

## 退役条件

上游同时提供 UTF-8、fallback、逐引用 auth、alias 去重与一次性 VM artifact 顺序的等价正反向覆盖，才可移除重复 fork 代码。UTF-8 默认值只能吸收封装的一部分。

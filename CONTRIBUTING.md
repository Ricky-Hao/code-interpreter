# Contributing

Thanks for your interest in Code Interpreter!

## How this repository is maintained

本 fork 直接维护检出的源码，通过审阅后的 rebase 集成上游；保留作者归属及
rebase 前的保护引用。上游 monorepo 同步不是本 fork 的发布入口。

集成前先读 [Fork 长期行为需求](docs/fork-patches/README.md)及证据报告最新章节。
按行为和上游等价实现解决冲突，保留现代安全/回归测试。2026-10-12 的 11 个原始
提交已全部重放，后续本地集成修复已通过审阅。本次集成未发布或部署；本地提交
不代表获得 push/发布授权。

## Releases

fork 拥有六个 amd64 镜像包，使用不可变 SHA 标签并记录各镜像 OCI digest。
[FP-001](docs/fork-patches/publishing-self-hosting.md)说明发布合同、本地集成的协调修复
及尚未完成的真实镜像验收。上游[发布文档](docs/RELEASING.md)仅供 chart/version
工具参考，不授权本 fork 发布或重新启用同步自动化。

## Development

See the [README](README.md) for the architecture overview and
`docker compose up --build` for a local stack. Component-level docs live in
`api/`, `service/`, and `helm/codeapi/`.

## Reporting issues

Open a GitHub issue with reproduction steps. For suspected security issues,
please do not open a public issue — contact the maintainers instead.

# 内核

本仓库不包含完整 Chromium 源码；可自行构建，或使用维护者提供的 artifact。
当前**没有公开的预编译 Release**。

## 1. 版本与产物

| 项 | 值 |
|---|---|
| Chromium | `156.0.8078.74`（[`chromium/VERSION`](../chromium/VERSION)） |
| 构建修订 | `87e334d`（见 `build-info.json`） |
| GN 参数 | [`chromium/args.gn.linux`](../chromium/args.gn.linux)（`is_official_build=false`、`symbol_level=1`） |
| 产物 | `build/chrome`，SHA256 见 `build-info.json` |
| artifact | `sumeru-kernel-<chromium>-<revision>-linux-x64.tar.gz`（维护者/发布流程提供；当前无公开 Release） |

`build/` 是 gitignored；`npm run setup` 负责校验/解压本地 artifact。

## 2. 为什么源码不在仓库

Chromium 全量源码约 25 GB（含 `.git`），不适合放进 git。仓库维护：

- **最小 overlay**：`chromium/overlay/current.patch`（对 pristine Chromium tag 的 diff）；
- **构建入口**：`chromium/Dockerfile.kernel`、`chromium/scripts/build-kernel.sh`、`package-kernel.sh`；
- **artifact + checksum**：按许可提供的交付物（当前无公开 Release）。

## 3. overlay 内容

| 模块 | 文件 |
|---|---|
| Gateway | `sumeru/browser/gateway/sumeru_gateway.{cc,h}`、`sumeru_gateway_start.h` |
| 标签 | `sumeru/browser/tabs/tab_ops.{cc,h}`、`tab_registry.{cc,h}`、`chrome/browser/sumeru/tabs/*` |
| 快照 | `sumeru/browser/snapshot/snapshot_serializer.{cc,h}` |
| 截图 | `content/browser/renderer_host/sumeru_page_capture.cc`、`content/public/browser/sumeru_page_capture.h` |
| 接线 | `content/browser/BUILD.gn`、`browser_main_loop.cc`、`chrome/browser/BUILD.gn`、`chrome_browser_main.cc`、`chrome/browser/ui/tabs/tab_strip_model.cc` |

内容约 20 文件 / 123 KB；不包含页面注入、空间/所有权、agent layer、Windows 工具链补丁等。

## 4. 构建

```bash
# 1) 获取 pristine 源码（Chromium 156.0.8078.74）
#    可用官方 tarball / Gitiles archive，或已有完整源码树

# 2) 构建内核镜像（context 是 chromium/）
docker build -f chromium/Dockerfile.kernel -t sumeru-kernel-build chromium

# 3) 应用 overlay + gn/ninja（源码挂 /src，产物落 build/）
docker run --rm -v /path/to/chromium/src:/src -v "$PWD/build:/out" sumeru-kernel-build

# 4) 打包 artifact
bash chromium/scripts/package-kernel.sh /out
```

首次 4–8 h；增量 10–30 min。构建机要求 Linux x64、≥150 GB 磁盘、≥32 GB 内存。

## 5. 升级 Chromium

1. 改 `chromium/VERSION` 与 `args.gn.linux`；
2. 在新 tag 上 rebase `current.patch`（`git apply --3way`）；
3. 构建 + 跑 smoke / acceptance；
4. 更新 `build-info.json`（chromium/revision/SHA/artifact）；
5. 发布新 artifact + 镜像。

## 6. 稳定性修复

关闭“有在途求值”的标签曾触发 socket 线程检查失败。修复已包含在构建修订
`87e334d`：`AgentHostClosed` 只清 agent 指针，pending 清理与 socket 写入统一
post 到 IO 线程。回归：`npm run acceptance:m09`。

## 7. 产物校验

```bash
npm run setup -- --check     # build/chrome 与 build-info.chromeSha256 比对
npm run setup -- --from ./sumeru-kernel-*.tar.gz
```

artifact 的 SHA256 记录在 `build-info.json`；发布时同时给 `SHA256SUMS`。

## 8. 相关文档

- 架构：[architecture.md](architecture.md)
- 排障：[troubleshooting.md](troubleshooting.md)
- 发布：[release-checklist.md](release-checklist.md)
# 内核

本仓库不包含完整 Chromium 源码；可自行构建，或从私有 registry 拉取内核镜像。
当前**没有公开的预编译 Release**。

## 1. 版本与产物

| 项 | 值 |
|---|---|
| Chromium | `156.0.8078.74`（[`chromium/VERSION`](../chromium/VERSION)） |
| 构建修订 | `87e334d`（见 `build-info.json`） |
| GN 参数 | [`chromium/args.gn.linux`](../chromium/args.gn.linux)（`is_official_build=false`、`symbol_level=1`） |
| 产物 | `build/chrome`，SHA256 见 `build-info.json` |
| kernel image | `registry.ops.lingya.tech/sumeru/sumeru-kernel:<chromium>-<revision>`（私有；运行时从这里取 `/opt/sumeru`） |
| archive | `sumeru-kernel-<chromium>-<revision>-linux-x64.tar.gz`（OSS 归档/SHA256；当前无公开 Release） |

`build/` 是 gitignored。CI 从 kernel image 的 `/opt/sumeru` 取出内容；本地可用
`npm run setup` 校验已有 `build/`，或解压归档。

## 2. 为什么源码不在仓库

Chromium 全量源码约 25 GB（含 `.git`），不适合放进 git。仓库维护：

- **最小 overlay**：`chromium/overlay/current.patch`（对 pristine Chromium tag 的 diff）；
- **构建入口**：`chromium/Dockerfile.kernel`、`chromium/scripts/build-kernel.sh`、`package-kernel.sh`；
- **kernel image + checksum**：私有 registry 交付物；archive 只做 OSS 归档/灾备。

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

# 2) 构建内核构建镜像（context 是 chromium/）
docker build -f chromium/Dockerfile.kernel -t sumeru-kernel-build chromium

# 3) 应用 overlay + gn/ninja（源码挂 /src，产物落 /src/out/release-linux）
docker run --rm -v /path/to/chromium/src:/src sumeru-kernel-build

# 4) 打包 artifact（归档/备份）
mkdir -p dist build
SUMERU_SRC=/path/to/chromium/src SUMERU_VERSION=156.0.8078.74 \
  SUMERU_COMMIT=87e334d bash chromium/scripts/package-kernel.sh dist
tar -xzf dist/sumeru-kernel-*.tar.gz -C build

# 5) 构建并推送 kernel image（私有 registry）
docker build -f chromium/Dockerfile.kernel-artifact \
  -t registry.ops.lingya.tech/sumeru/sumeru-kernel:156.0.8078.74-87e334d \
  build/
docker push registry.ops.lingya.tech/sumeru/sumeru-kernel:156.0.8078.74-87e334d
```

CI 使用 `.github/workflows/kernel-build.yml`（self-hosted runner）。

首次 4–8 h；增量 10–30 min。构建机要求 Linux x64、≥150 GB 磁盘、≥32 GB 内存。

## 5. 升级 Chromium

1. 改 `chromium/VERSION` 与 `args.gn.linux`；
2. 在新 tag 上 rebase `current.patch`（`git apply --3way`）；
3. 构建 + 跑 smoke / acceptance；
4. 更新 `build-info.json`（chromium/revision/kernelImage/kernelTag/SHA）；
5. 发布新 kernel image + 运行时镜像；OSS 保留归档。

## 6. 稳定性修复

关闭“有在途求值”的标签曾触发 socket 线程检查失败。修复已包含在构建修订
`87e334d`：`AgentHostClosed` 只清 agent 指针，pending 清理与 socket 写入统一
post 到 IO 线程。回归：`npm run acceptance:m09`。

## 7. 产物校验

```bash
# 从私有 registry 取出内核文件（CI 使用同一方式）
docker pull registry.ops.lingya.tech/sumeru/sumeru-kernel:156.0.8078.74-87e334d
CID="$(docker create registry.ops.lingya.tech/sumeru/sumeru-kernel:156.0.8078.74-87e334d /bin/true)"
rm -rf build && mkdir build
docker cp "${CID}:/opt/sumeru/." build/
docker rm "${CID}"

npm run setup -- --check     # build/chrome 与 build-info.chromeSha256 比对
npm run setup -- --from ./sumeru-kernel-*.tar.gz
```

kernel image 的 label 记录 chromium/revision/chrome SHA/overlay SHA；archive 的
SHA256 记录在 `build-info.json`，发布时同时给 `SHA256SUMS`。

## 8. 相关文档

- 架构：[architecture.md](architecture.md)
- 排障：[troubleshooting.md](troubleshooting.md)
- 发布：[release-checklist.md](release-checklist.md)
# Chromium（自建内核）

本目录只放**内核版本与定制入口**，不放 Chromium 全量源码。

## 当前状态

| 项 | 值 |
|---|---|
| 版本 | `156.0.8078.74`（`VERSION`） |
| Linux GN 参数 | `args.gn.linux`（`is_official_build=false`、`symbol_level=1`） |
| 产物 | `../build/chrome`（gitignored；SHA 见 `../build-info.json`） |
| overlay | `overlay/current.patch`（20 文件 / 123 KB） |
| 构建镜像 | `Dockerfile.kernel`（context 是本目录） |

## overlay 内容

- `sumeru/browser/gateway/`：K-Gateway（UDS + JSON-line）。
- `sumeru/browser/tabs/` + `chrome/browser/sumeru/tabs/`：真实 TabStripModel 标签、最后标签守卫。
- `sumeru/browser/snapshot/`：AX 快照序列化。
- `content/browser/renderer_host/sumeru_page_capture.cc`：页面截图。
- 5 处接线：`content/browser/BUILD.gn` / `browser_main_loop.cc`、`chrome/browser/BUILD.gn` /
  `chrome_browser_main.cc`、`chrome/browser/ui/tabs/tab_strip_model.cc`。

## 构建

- 默认：预编译 artifact（`npm run setup -- --from ...`），或已有 `build/`（`npm run setup -- --check`）。
- 源码构建：`Dockerfile.kernel` + `scripts/build-kernel.sh`，步骤见 [docs/kernel.md](../docs/kernel.md)。

## 为什么不在仓库里放源码

Chromium 全量约 25 GB（不含 `out/`），不适合 git。仓库维护“最小 overlay + 构建脚本 +
artifact + checksum”；完整源码按 `VERSION` 的 tag 从 Chromium 官方获取。
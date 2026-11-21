# 版本管理（Versioning）

本项目使用 **Semantic Versioning 2.0.0**，Git tag 采用 `v` 前缀，Docker 镜像按同一版本发布。

## 1. 单一事实源

| 位置 | 作用 |
|---|---|
| `package.json` 的 `version` | 唯一版本号来源 |
| Git tag `vX.Y.Z` | 发布标记；必须与 `package.json` 一致 |
| `build-info.json` 的 `sumeruVersion` | 与包版本对齐；同时记录内核 provenance |
| `CHANGELOG.md` | 面向用户的变更说明 |

发布前用：

```bash
npm run version:check
node scripts/version.mjs --tag v2.1.0
```

不一致时脚本退出 1。

## 2. 语义化规则

| 变更 | 版本位 | 示例 |
|---|---|---|
| 不兼容的 gateway/MCP 工具/参数变更 | MAJOR | `2.1.0 → 3.0.0` |
| 向后兼容的功能 | MINOR | `2.1.0 → 2.2.0` |
| 向后兼容的修复/安全补丁 | PATCH | `2.1.0 → 2.1.1` |
| 预发布 | 后缀 | `2.2.0-rc.1` |

预发布版本不作为稳定版发布：不产生 `latest` 与 `X.Y` 标签。

## 3. Docker 镜像标签

| 标签 | 何时产生 | 说明 |
|---|---|---|
| `X.Y.Z` | 每次发布 | 精确版本，推荐生产引用 |
| `X.Y` | 稳定版 | 该 minor 的最新补丁 |
| `latest` | 稳定版 | 仅指向最新稳定版 |
| `sha-<7位>` | 每次构建 | 对应 commit；即使非发布也可追溯 |

预发布只产生 `X.Y.Z-<pre>` 和 `sha-<7位>`。

示例（`v2.1.0`）：

```text
<dockerhub-user>/sumeru-runtime:2.1.0
<dockerhub-user>/sumeru-runtime:2.1
<dockerhub-user>/sumeru-runtime:latest
<dockerhub-user>/sumeru-runtime:sha-57bc193
```

## 4. 内核版本矩阵

镜像版本与内核是**分开**的：

| 字段 | 含义 |
|---|---|
| `package.json.version` | Sumeru 运行时版本 |
| `build-info.chromiumVersion` | Chromium 版本（如 `156.0.8078.74`） |
| `build-info.kernelCommit` | 内核构建 revision |
| `build-info.chromeSha256` | chrome 二进制 |
| `build-info.artifact.sha256` | kernel tar.gz（归档/备份） |
| `build-info.kernelImage` | 私有 OCI registry 的内核镜像名 |
| `build-info.kernelTag` | 内核镜像 tag：`<chromium>-<kernelCommit>` |
| `src/mcp/core.mjs` 的 `PROTOCOL_VERSION` | MCP 传输协议（`2025-06-18`） |
| MCP `serverInfo.version` | 工具 schema 版本（当前 `0.4.0`） |

发布记录应能回答：**这个镜像里的 chrome 是哪个 SHA、由哪个 kernel commit 构建、
对应哪个 kernel image digest。**

## 5. 发布流程

1. 更新 `CHANGELOG.md`；
2. 修改 `package.json.version` 与 `build-info.sumeruVersion`；
3. 跑 `npm run ci` / `npm run verify`；
4. commit；
5. `git tag -a vX.Y.Z -m "..."`；
6. `git push origin main` 与 `git push origin vX.Y.Z`；
7. GitHub Actions `release-image` 从私有 registry 拉取 kernel image，构建并推送 Docker Hub；
8. 验证镜像 digest 与 `docker pull`；
9. 记录版本、运行时镜像 digest、kernel image tag/digest。

## 6. 分支与 hotfix

- `main` 为发布主线；
- 需要并行维护旧 minor 时建 `release/X.Y`；
- hotfix 从 `main`（或对应 release 分支）切出，PATCH 版本；
- 禁止在 tag 上直接改代码；tag 不可移动（需重新发布则新 PATCH）。

## 7. 提交与 PR

- 推荐 Conventional Commits：`feat:` / `fix:` / `docs:` / `chore:` / `security:`；
- PR 必须过 `ci`；
- 发布 tag 只由维护者创建；
- 不开源 BSD 版本：v2.0.0 的 Release/tag 已撤回，后续只发社区版/商业版。

## 8. 许可证与商业版

- 社区版：PolyForm Noncommercial 1.0.0；
- 商业版：单独商业许可；
- Docker 镜像标签需带 `org.opencontainers.image.licenses=PolyForm-Noncommercial-1.0.0`；
- 发布镜像不等于授予商业使用权。

## 9. 相关文件

- `scripts/version.mjs`
- `.github/workflows/ci.yml`
- `.github/workflows/release-image.yml`
- `chromium/Dockerfile.kernel-artifact`
- `CHANGELOG.md`
- `build-info.json`
- `docs/release-checklist.md`

## 10. GitHub Actions / 私有镜像仓库

### 工作流

| 文件 | 触发 | 行为 |
|---|---|---|
| `.github/workflows/ci.yml` | push `main` / PR / 手动 | `version:check`、单测、repo checks |
| `.github/workflows/release-image.yml` | tag `v*` / 手动 | **只拉取** kernel image，构建 runtime image 并推送 Docker Hub |

**Chromium 构建不在 GitHub 上执行**；只允许在本地/内网构建机完成
（构建脚本由维护者本地维护，不提交到仓库）。

### 必需 secrets / variables

在 GitHub 仓库 **Settings → Secrets and variables → Actions** 配置：

| 名称 | 类型 | 说明 |
|---|---|---|
| `KERNEL_REGISTRY_USERNAME` | secret | `registry.ops.lingya.tech` 拉取/推送账号 |
| `KERNEL_REGISTRY_PASSWORD` | secret | registry 密码/robot token |
| `DOCKERHUB_USERNAME` | secret | Docker Hub 用户或组织 |
| `DOCKERHUB_TOKEN` | secret | Docker Hub access token，需 write 权限 |
| `KERNEL_REGISTRY` | variable，可选 | 默认 `registry.ops.lingya.tech` |
| `KERNEL_IMAGE` | variable，可选 | 默认 `registry.ops.lingya.tech/sumeru/sumeru-kernel` |
| `DOCKERHUB_REPOSITORY` | variable，可选 | 默认 `sumeru-runtime` |

镜像名：`${DOCKERHUB_USERNAME}/${DOCKERHUB_REPOSITORY:-sumeru-runtime}`。

### kernel image 要求

- 镜像名：`registry.ops.lingya.tech/sumeru/sumeru-kernel`
- tag：`<chromiumVersion>-<kernelCommit>`，例如 `156.0.8078.74-87e334d`
- 内容：`/opt/sumeru/` 下的 `chrome`、`icudtl.dat`、`.pak`、`locales/`、GPU 库等；
- **必须包含 `LICENSES.chromium.html`**；本地 publish 脚本硬校验；runtime workflow
  在 v2.1.0 首版验证期只 warning，正式发布前恢复硬校验；
- 私有仓库；运行时 workflow 通过 `docker cp` 取出 `/opt/sumeru`，不使用签名 URL。

### 内核本地构建/发布

GitHub 只引用镜像，不编译 Chromium。维护者在本地/内网构建机执行
（脚本不提交到仓库；手动步骤见 [kernel.md](kernel.md) §4）：

```bash
docker login registry.ops.lingya.tech
# 按 kernel.md 构建、打包并推送 kernel image
```

前置条件：

```text
Linux x64 / WSL2 + Docker
源码: /src = Chromium 156.0.8078.74（含 .git、buildtools/linux64/gn、
      third_party/ninja/ninja；首次构建需要网络拉 clang/sysroot）
资源: ≥150 GB 磁盘、≥32 GB 内存；首次 4–8 小时
```

### 发布行为

- 推送 tag `v2.1.0`：构建并推送 `2.1.0`、`2.1`、`latest`、`sha-<7>`（稳定版）；
- 推送 `v2.2.0-rc.1`：只推 `2.2.0-rc.1`、`sha-<7>`；
- 手动运行：默认只构建不推送；勾选 `push` 才推送；
- Docker Hub token 不要用账号密码；不要提交到仓库。

### 首次发布前

1. 配置上述 secrets/vars；
2. 在本地构建机构建并推送 kernel image（脚本不提交，步骤见 kernel.md），确认包含 license；
3. 手动跑一次 `release-image`（push=false）确认拉取/构建；
4. 再打 tag 触发正式推送。
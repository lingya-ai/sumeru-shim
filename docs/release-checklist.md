# 发布检查清单（Community Edition v2.1.0）

> 当前无公开 Release；本清单用于下一次社区版/商业版发布。
> `node scripts/release.mjs --check` 校验本地输入。

## 1. 法务门禁

- [ ] `LICENSE` = PolyForm Noncommercial 1.0.0
- [ ] `LICENSE-COMMERCIAL.md` 存在且联系方式有效
- [ ] `THIRD_PARTY_NOTICES.md` 覆盖 Chromium/noVNC/Node/Debian
- [ ] `TRADEMARK.md` 存在
- [ ] `CLA.md` / `CONTRIBUTING.md` 已就位（接受外部 PR 前）
- [ ] 二进制分发包含 `LICENSES.chromium.html`
- [ ] 不再对外提供任何 BSD-3 版本的 Release/tag

## 2. 本地门禁

```bash
npm run ci
npm run verify
npm run smoke
npm run acceptance
npm run acceptance:m09
```

- [ ] `git status` 干净
- [ ] `node scripts/setup.mjs --check` 通过
- [ ] `node scripts/release.mjs --check` 通过

## 3. 内核镜像

- [ ] 本地内网构建机已产出
      `registry.ops.lingya.tech/sumeru/sumeru-kernel:<chromium>-<revision>`
      （构建脚本不提交）
- [ ] 镜像内 `/opt/sumeru/LICENSES.chromium.html` 存在
- [ ] `build-info.json` 的 `kernelImage` / `kernelTag` 已更新
- [ ] 可选：OSS 归档 tar.gz + SHA256

## 4. GitHub Actions / Docker Hub

- [ ] 配置 `KERNEL_REGISTRY_USERNAME`、`KERNEL_REGISTRY_PASSWORD`
- [ ] 配置 `DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN`
- [ ] 可选：`KERNEL_REGISTRY`、`KERNEL_IMAGE`、`DOCKERHUB_REPOSITORY`
- [ ] 本地已完成 kernel image 构建并推送（GitHub 不构建 Chromium）
- [ ] 手动跑 `.github/workflows/release-image.yml`（push=false），确认拉取/构建
- [ ] 打 tag `vX.Y.Z` 并 push，触发 runtime image 推送
- [ ] 验证 Docker Hub 上的 `X.Y.Z` / `X.Y` / `latest` / `sha-*` 标签

## 5. 发布

- [ ] `git push origin main`
- [ ] 记录 kernel image digest / runtime image digest
- [ ] 按商业策略决定是否创建社区 Release

## 6. 发布后复验

```bash
git clone https://github.com/lingya-ai/sumeru-shim.git
cd sumeru-shim
npm run setup -- --from ./sumeru-kernel-*.tar.gz
npm test
npm run up
npm run smoke
```

- [ ] `/healthz` ready，八层全绿
- [ ] smoke 10/10
- [ ] m09 6/6
- [ ] noVNC 可看可点
- [ ] `scan-secrets` 0 命中

## 7. 回滚

- 运行时镜像：回到上一个 tag。
- 内核：切回 `build-info.kernelTag` / `kernelImage` 对应的旧 kernel image。
- profile：回滚前备份 `/data` 卷。
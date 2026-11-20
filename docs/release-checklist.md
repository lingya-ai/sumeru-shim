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

## 3. 产物

- [ ] kernel artifact（含 `LICENSES.chromium.html`）
- [ ] `SHA256SUMS`
- [ ] 镜像 `sumeru-runtime:v2.1.0`（如发布镜像）
- [ ] `build-info.json` 的 `artifact.url` 指向新托管位置

## 4. 托管（决定后执行）

- [ ] 选择 artifact 托管
- [ ] 上传 artifact 与 checksum
- [ ] 写入 `build-info.json.artifact.url`
- [ ] `git push origin main`
- [ ] 按商业策略决定是否创建社区 Release

## 5. 发布后复验

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

## 6. 回滚

- 镜像：回到上一个 tag。
- 内核：`npm run setup -- --from <旧 artifact>`（仅限你有权使用的版本）。
- profile：回滚前备份 `/data` 卷。
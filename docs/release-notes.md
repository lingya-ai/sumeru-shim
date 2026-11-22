# 发布说明

## 当前状态

- **v2.2.0（当前）**：在 2.1.0 基础上加入 MCP/VNC 可配置认证、TigerVNC Xvnc
  （Unicode 剪贴板）与 fcitx5 默认启用并在启动时激活（中文输入）。
- **v2.0.0（BSD-3-Clause）已撤回**：GitHub/Gitee 的 Release 与 tag 已删除。
  已经下载或 fork 的副本仍受 BSD-3 授权；该授权无法追溯撤销。
- v2.1.0 未单独对外发布，内容已包含在 2.2.0 中。

## 许可

- 原创代码：**PolyForm Noncommercial 1.0.0**（个人/非商业使用免费）。
- **商业使用需要商业许可证**：[LICENSE-COMMERCIAL.md](../LICENSE-COMMERCIAL.md)。
- 这是 **source-available**，不是 OSI 开源项目。
- Chromium 仍为 BSD-3-Clause；商业许可不覆盖 Chromium 或第三方组件。

## 如何获取/构建

当前**没有公开的预编译 artifact Release**。两种方式：

1. 自行构建：见 [kernel.md](kernel.md) 与 [development.md](development.md)；
2. 从维护者获取 community artifact，然后：

```bash
npm run setup -- --from ./sumeru-kernel-*.tar.gz
```

已有 `build/` 时用 `npm run setup -- --check`。

## 已验证的构建指标

以下数字来自 v2.0.0 构建，仅用于说明当前代码质量，不代表已发布 Release：

| 指标 | 值 |
|---|---|
| 单测 | 97 pass / 1 skip |
| smoke | 15/15（含认证矩阵） |
| m-series | 12/12 |
| 1000 次顺序求值 | avg 3.3 ms，worst 19 ms |
| m09（关标签 + 在途求值） | 6/6 |

## 许可证与商标

- [LICENSE](../LICENSE)：PolyForm Noncommercial 1.0.0
- [LICENSE-COMMERCIAL.md](../LICENSE-COMMERCIAL.md)：商业许可
- [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)：Chromium / noVNC / Node 等
- [TRADEMARK.md](../TRADEMARK.md)：Sumeru 与 Google Chrome/Chromium 商标说明
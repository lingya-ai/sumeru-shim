# 文档索引

| 文档 | 内容 |
|---|---|
| [architecture.md](architecture.md) | 现行架构：单窗口、gateway-only、无 CDP、无页面常驻注入 |
| [development.md](development.md) | 本地开发：单测、shim 调试、CLI/MCP、验收 |
| [operations.md](operations.md) | 部署与运维：compose、端口、卷、健康、升级/回滚 |
| [kernel.md](kernel.md) | 内核：版本、artifact、overlay、构建 |
| [troubleshooting.md](troubleshooting.md) | 常见故障与已知边界 |
| [security.md](security.md) | 权限模型、`/gw` 鉴权、`evaluateTarget` 风险 |
| [auth.md](auth.md) | MCP 与 VNC 认证（v2.2）：配置矩阵、401 语义、口令生命周期 |
| [../.dsh/skills/sumeru-browser/SKILL.md](../.dsh/skills/sumeru-browser/SKILL.md) | Agent skill：通过 MCP 操作云浏览器 |
| [versioning.md](versioning.md) | 版本管理：SemVer、镜像标签、发布流程 |
| [release-notes.md](release-notes.md) | 版本发布说明 |
| [release-checklist.md](release-checklist.md) | 发布检查清单 |

## 阅读顺序

1. 第一次接触：根目录 [README](../README.md) → 本页 → [architecture.md](architecture.md)。
2. 要跑起来：[development.md](development.md) → [operations.md](operations.md)。
3. 要改内核：[kernel.md](kernel.md)。
4. 遇到问题：[troubleshooting.md](troubleshooting.md) → [security.md](security.md)。
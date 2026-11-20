# Changelog

All notable changes to Sumeru runtime are documented here. The format follows
Keep a Changelog; versions follow Semantic Versioning.

## [2.1.0] - 2026-11-20

### Added

- Community Edition licensing: PolyForm Noncommercial 1.0.0 + commercial license.
- `LICENSE-COMMERCIAL.md`, `CLA.md`, `CONTRIBUTING.md`, `TRADEMARK.md`.
- MCP agent skill at `.dsh/skills/sumeru-browser/` (tools, recipes, troubleshooting).
- `chromium/scripts/fetch-kernel-source.sh`: per-version Chromium source cache under
  gitignored `chromium-src/<version>/src`.
- Local-only kernel publish flow (script not committed) publishes immutable
  kernel images to the private registry `registry.ops.lingya.tech`; `release-image`
  consumes them instead of a signed artifact URL. Chromium is never built on GitHub.
- Versioning policy and `scripts/version.mjs` consistency check.
- GitHub Actions release workflow for Docker Hub images.

### Changed

- README/README.en rebuilt around the AI-native cloud browser positioning.
- Docker image labels and license files are included in the image.
- Image version aligned with `package.json` (2.1.0).

### Removed

- `v2.0.0` GitHub/Gitee Release and tags (BSD-3 licensed version withdrawn).
- Public prebuilt kernel artifact from the Release; use a maintainer-provided
  artifact or build from source.

### Security

- No CDP listener, no page SDK injection; gateway remains private UDS.
- Per-boot random gateway token; `/gw` API key supported.

## [2.0.0] - 2026-11-19

Initial contraction release (BSD-3-Clause). Withdrawn; do not redistribute as a
community edition. Copies already distributed retain their BSD-3 rights.
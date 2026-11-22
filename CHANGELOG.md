# Changelog

All notable changes to Sumeru runtime are documented here. The format follows
Keep a Changelog; versions follow Semantic Versioning.

## [2.2.0] - 2026-11-22

### Added

- `/mcp` authentication, shared with `/gw` through one `SUMERU_API_KEY`
  (single, comma-free value) or `SUMERU_API_KEY_FILE`; `SUMERU_MCP_AUTH=auto`
  (default), `required`, `off`. Failures are HTTP `401` +
  `WWW-Authenticate: Bearer` (RFC 6750) — transport level, not JSON-RPC errors.
- `/gw` also accepts `Authorization: Bearer <key>`; `X-Sumeru-Token` keeps working.
- VNC (TigerVNC Xvnc) RFB password auth: `SUMERU_VNC_AUTH=vnc` with
  `SUMERU_VNC_PASSWORD` or `SUMERU_VNC_PASSWORD_FILE`; a missing, unreadable or
  over-long password fails fast at startup instead of running unauthenticated.
- `Xvnc -localhost` by default: port 5900 is bound to container loopback, so
  publishing it does not expose the display. `SUMERU_VNC_LOCALHOST=0` opts out.
- `/healthz` reports an `auth` block (`gw`/`mcp` = `token`/`open`) without
  exposing credentials; the eight layers are unchanged.
- `scripts/smoke.mjs` asserts the auth matrix; `test/auth.test.mjs` and
  `test/mcp-auth.test.mjs` cover the credential kernel and HTTP semantics.
- `docs/auth.md`: design, threat model, rotation and acceptance checklist.

### Changed

- **Breaking**: when `SUMERU_API_KEY` is set, `/mcp` now requires credentials.
  Set `SUMERU_MCP_AUTH=off` to keep the 2.1 behaviour while migrating clients.
- Compose now starts the bundled fcitx5 by default (`SUMERU_IME=fcitx`) and keeps it
  **active** (a fresh data volume gets `[Behavior] ActiveByDefault=True`; existing
  volumes fall back to `fcitx5-remote -o`, since fcitx5 otherwise starts inactive with
  no candidate window) so pinyin works in noVNC out of the box; `SUMERU_IME=off` skips it. noVNC cannot forward
  local IME compositions — type pinyin with the remote IME (`docs/troubleshooting.md`).
- VNC server switched from x11vnc to TigerVNC `Xvnc` (X server + VNC in one process): noVNC only uses UTF-8
  clipboard when the server advertises Extended Clipboard, so pasting Chinese into
  noVNC now works instead of turning into `?`. The password file is derived with
  `vncpasswd -f` from stdin, so the plaintext never appears in a command line.
- Credentials live in memory only: the API key is reduced to a sha256 digest,
  removed from the process environment after load and stripped from the chrome
  child env. A restart always uses the current configuration; nothing is persisted.
- MCP server schema version `0.5.0` (tool list and schemas unchanged).

### Security

- Constant-time credential comparison; tokens are never logged (only a sha256
  prefix on rejection) and never echoed in responses.
- Credentials are not inherited by helper processes: `start-all.sh` unsets the
  auth variables before starting Xvnc/websockify (and passes the key back
  only for the shim), and the shim spawns chrome with a sanitized environment.
  Container-level env is still visible to `docker exec`; use `_FILE` secrets to
  narrow that further (`docs/auth.md` §4).
- VNC passwords are limited to the 8 bytes RFB actually uses; longer values are
  rejected at startup rather than silently truncated.

## [2.1.0] - 2026-11-20

### Added

- Licensing: PolyForm Noncommercial 1.0.0 + commercial license.
- `LICENSE-COMMERCIAL.md`, `CLA.md`, `CONTRIBUTING.md`, `TRADEMARK.md`.
- MCP agent skill at `.dsh/skills/sumeru-browser/` (tools, recipes, troubleshooting).
- MCP `capture_page` now returns an MCP **image content block**
  (`{type:"image",data,mimeType:"image/png"}`) instead of base64 inside text JSON.
- MCP **Streamable HTTP** endpoint `POST /mcp` (protocol `2025-06-18`, stateless
  JSON-only) served by the shim; clients no longer need Node. HTTP is the only
  supported MCP transport. MCP server schema version is `0.4.0`.
- `chromium/scripts/fetch-kernel-source.sh`: per-version Chromium source cache under
  gitignored `chromium-src/<version>/src`; `--shallow` / `--depth` /
  `--no-history` avoid the full 70 GB git history.
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
current release. Copies already distributed retain their BSD-3 rights.
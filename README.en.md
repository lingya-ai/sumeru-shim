# Sumeru · AI-native cloud browser (Community Edition)

An **AI-native cloud browser built on Chromium** — the open-source core behind
Google Chrome.

The browser runs in a cloud container, **24/7**; agents drive a real browser through
one gateway or MCP, and humans watch/take over through noVNC. **No local computer is
required** — no Chrome install, no Playwright, no automation runtime on the client.

> Not a headless scraper, and not a remote-desktop wrapper: a native Chromium window,
> real `TabStripModel` tabs, and an agent-facing control surface. No SDK injection,
> no CDP port.

> **Community edition**: source-available for personal/noncommercial use under
> PolyForm Noncommercial 1.0.0; **commercial use requires a commercial license**.
> This is not an OSI open-source project.

## Why AI-native

| Capability | What it means |
|---|---|
| **Agent-first API** | 12 semantic methods (tabs / navigation / evaluate / screenshot / AX / input / IME), exposed 1:1 over `POST /gw` or MCP |
| **Real browser** | Native Chromium window, real tabs, real profile; cookies, localStorage and login state persist |
| **24/7 operation** | Container stays up with `restart: unless-stopped`, health checks, and a profile volume that restores tabs and sessions |
| **Human in the loop** | Humans see and operate the same browser through noVNC; no gating, no arbitration |
| **No local footprint** | Browser, GPU libraries, IME and noVNC live in the cloud; the client only needs network and a browser |
| **No CDP, no injection** | No `--remote-debugging-*`, no listening port, no page SDK; the only surface is a private UDS gateway |
| **Auditable kernel** | A minimal 20-file / 123 KB overlay on stock Chromium |

## Use cases

- **24/7 browser duty**: scheduled checks, price/stock monitoring, long forms, background jobs.
- **Long-lived agent workspace**: tabs, history and login state stay in the cloud; the agent can return anytime.
- **Remote work / demos**: keep business systems off the laptop; run the browser in the cloud and view it through noVNC.
- **Web app testing / dogfooding**: real Chromium, real input (`isTrusted=true`), real screenshots and AX tree.
- **Stable egress**: place the browser on a cloud host with a fixed IP/proxy.

## Architecture

```text
Agent (LLM / app)
  │  HTTP POST /gw {method, params}   or POST /mcp (Streamable HTTP)
  ▼
thin shim (node src/index.mjs)                    :8080
  ├─ spawns chrome (no --remote-debugging-*)
  ├─ GET /healthz (8 layers)
  ├─ POST /gw → gateway client
  └─ POST /mcp → MCP tools (stateless JSON)
  │  UDS /data/sumeru-gateway.sock (token)
  ▼
Chromium (custom kernel, single source of truth)
  ├─ K-Gateway (in browser process; JSON lines over UDS)
  ├─ real TabStripModel tabs (visible/clickable by humans)
  ├─ evaluateTarget → in-process DevToolsAgentHost → Runtime.evaluate
  └─ snapshotAX → AX tree; captureScreenshot → surface capture
  │  X11 :99
  ▼
Xvfb ← x11vnc ← websockify/noVNC                  :6901
  ▲
Human (opens noVNC, watches/clicks)
```

## Quickstart (local or cloud host)

Prerequisites: Docker (Docker Engine on a cloud host; Docker Desktop on
Windows/macOS). Node.js 22+ is only needed for the CLI/tests.

```bash
git clone https://github.com/lingya-ai/sumeru-shim.git
cd sumeru-shim

# 1) kernel: use a local artifact from the maintainers, or an existing build/
npm run setup -- --from ./sumeru-kernel-*.tar.gz
# npm run setup -- --check   # if build/ already exists

# 2) unit tests (no Docker / kernel needed)
npm test

# 3) build the image and start the browser
npm run up

# 4) end-to-end smoke
npm run smoke
```

> The repository does not contain Chromium source or a prebuilt kernel; follow
> [docs/kernel.md](docs/kernel.md) to download the source and build it locally.

Open **http://127.0.0.1:6901/vnc.html** to see the native Chromium window.

```bash
node bin/sumeru.mjs health
node bin/sumeru.mjs tabs
node bin/sumeru.mjs eval active "document.title"
node bin/sumeru.mjs ax active
node bin/sumeru.mjs shot active ./page.png
```

Offline/air-gapped: `npm run setup -- --from ./sumeru-kernel-*.tar.gz`.
With an existing `build/`: `npm run setup -- --check`.

Stop / logs / acceptance:

```bash
npm run logs
npm run down
npm run acceptance      # m-series
npm run acceptance:m09  # close tab with in-flight evaluate
```

## Building the Chromium kernel

Kernel source is not vendored. It is cached per version under the gitignored
`chromium-src/<version>/src`.

### 1. Fetch source

```bash
# Recommended: shallow source, no full history
chromium/scripts/fetch-kernel-source.sh --shallow --proxy http://127.0.0.1:3128

# More history if the build needs git log
chromium/scripts/fetch-kernel-source.sh --shallow --depth 20 --jobs 1

# Skip gclient runhooks; build-kernel.sh can fetch clang/sysroot later
chromium/scripts/fetch-kernel-source.sh --shallow --no-hooks
```

The default is still full history; `--shallow` uses `git clone --depth` plus
`gclient sync --no-history`. Proxies are disabled unless `--proxy` or
`SUMERU_PROXY` is set.

It prints:

```text
SUMERU_SRC=.../chromium-src/<version>/src
```

Below:

```bash
VERSION="$(cat chromium/VERSION)"
SRC="$PWD/chromium-src/$VERSION/src"
```

### 2. Apply the overlay and edit source

`chromium/overlay/current.patch` is the diff against pristine Chromium. For the
first edit:

```bash
git -C "$SRC" apply --check chromium/overlay/current.patch
git -C "$SRC" apply chromium/overlay/current.patch
```

Then edit files under `$SRC` (for example `sumeru/browser/gateway/`,
`chrome/browser/sumeru/`, `content/browser/renderer_host/sumeru_page_capture.cc`).

If the patch is already applied, `build-kernel.sh` skips it; do not apply twice.

### 3. Incremental build

```bash
docker build -f chromium/Dockerfile.kernel -t sumeru-kernel-build chromium
docker run --rm -it \
  -v "$SRC:/src" \
  -e SUMERU_SRC=/src \
  sumeru-kernel-build
```

- First build 4–8 h; incremental 10–30 min.
- Output stays in `$SRC/out/release-linux/`.
- Changing `chromium/args.gn.linux` (for example `is_debug=true`,
  `symbol_level=2`) reruns `gn gen`.
- Quick overlay check: `git -C "$SRC" apply --check chromium/overlay/current.patch`.

### 4. Run the new kernel

```bash
SUMERU_SRC="$SRC" SUMERU_VERSION="$VERSION" \
  SUMERU_COMMIT="$(git -C "$SRC" rev-parse --short HEAD)" \
  bash chromium/scripts/package-kernel.sh dist

rm -rf build && mkdir build
tar -xzf dist/sumeru-kernel-*.tar.gz -C build
npm run up
npm run smoke
```

`npm run up` rebuilds the runtime image with the new `build/`. Shim-only changes
do not need a Chromium rebuild.

### 5. Regenerate the overlay

Export the current source diff back to the patch:

```bash
# Mark only overlay paths as intent-to-add. Do not use git add -A:
# gclient-fetched third-party deps would otherwise leak into the patch.
git -C "$SRC" add -N -- \
  sumeru \
  chrome/browser/sumeru \
  content/browser/renderer_host/sumeru_page_capture.cc \
  content/public/browser/sumeru_page_capture.h
git -C "$SRC" diff --binary > chromium/overlay/current.patch
git -C "$SRC" reset
```

Validate on the current tree:

```bash
git -C "$SRC" apply --reverse --check chromium/overlay/current.patch
```

For troubleshooting and runtime logs, see [docs/troubleshooting.md](docs/troubleshooting.md).

## Deploy to the cloud

`deploy/compose.yaml` is a working single-host setup:

```bash
# on a cloud host
git clone https://github.com/lingya-ai/sumeru-shim.git
cd sumeru-shim
npm run setup -- --from ./sumeru-kernel-*.tar.gz
npm run up
```

Ports are bound to `127.0.0.1` by default (8080/6901). For remote humans:

1. Put **noVNC** behind a VPN / reverse proxy with TLS and authentication; do not
   expose 6901 directly.
2. If **`/gw`** is reachable across machines, set `SUMERU_API_KEY` and send
   `X-Sumeru-Token`.
3. Mount `/data` on persistent storage so tabs, history and sessions survive
   restarts/upgrades.
4. Recommended resources: `--cpus=2 --memory=3g --memory-swap=3g --shm-size=1g`.
5. Use `restart: unless-stopped` plus `/healthz` as the liveness probe.

Any cloud/Kubernetes/Nomad setup works; this repo only requires a Linux container.

## Agent interface

### 12 methods

| Area | Methods |
|---|---|
| Tabs | `createTab` / `listTabs` / `closeTab` / `activateTab` |
| Page | `navigateTarget` / `evaluateTarget` / `captureScreenshot` / `snapshotAX` |
| Input | `dispatchKey` / `dispatchMouse` / `imeCompose` |
| Base | `ping` |

### HTTP

```bash
curl -s http://127.0.0.1:8080/gw \
  -H 'content-type: application/json' \
  -d '{"method":"listTabs","params":{}}'

curl -s http://127.0.0.1:8080/gw \
  -H 'content-type: application/json' \
  -d '{"method":"evaluateTarget","params":{"targetId":"<id>","expression":"document.title"}}'
```

### MCP

Recommended: the shim's **Streamable HTTP** endpoint. The client does not need Node:

```text
POST http://127.0.0.1:8080/mcp
protocol: 2025-06-18
transport: stateless, JSON-only
```

MCP client config:

```json
{
  "mcpServers": {
    "sumeru": {
      "type": "http",
      "url": "http://127.0.0.1:8080/mcp"
    }
  }
}
```

> The current `/mcp` endpoint is **unauthenticated** for first-version validation;
> bind it to `127.0.0.1` or a private network only.

Agent skill (MCP tool usage): [.dsh/skills/sumeru-browser/SKILL.md](.dsh/skills/sumeru-browser/SKILL.md)

### Evaluate semantics

`evaluateTarget` runs one expression in the target page's **main frame, main world**:

- does not await Promises (a Promise returns `{}`; poll for async content);
- main frame only; iframes are not separate targets;
- DOM nodes/functions return `{}` because they are not JSON-serializable;
- no page SDK global, no `Runtime.enable`, no console hooks;
- thrown exceptions → `SUMERU_OPERATION_FAILED`; bad target → `SUMERU_TASK_SPACE_NOT_FOUND`.

## 24/7 operation

| Mechanism | Detail |
|---|---|
| Container restart | chrome exit → shim exit 1 → orchestrator starts a new container; `restart: unless-stopped` |
| Profile persistence | `/data` holds tabs/history/cookies/localStorage; restored on restart |
| Health | `GET /healthz` with 8 layers: x / synth / webui / gateway / kernel / window / vnc / ime |
| Stale lock cleanup | shim clears Chrome `Singleton*` after hostname changes; `SUMERU_CLEAR_PROFILE_LOCK=0` disables |
| Logs | `npm run logs`; kernel `[SUMERU-GW]` lines trace every response |

## Security

`evaluateTarget` is arbitrary JS in the page's main world (cookies/DOM included).
That is the source of agent power and the largest attack surface:

- bind to loopback by default; never expose `/gw` or `/mcp` directly to the public internet;
- for remote access, set `SUMERU_API_KEY` and add network access control;
- noVNC has no password by default; put it behind VPN/reverse proxy with auth + TLS;
- one browser/profile per tenant; do not share a profile between untrusted users;
- see [docs/security.md](docs/security.md).

## Known limits

- **Single window, single profile**; `window.open` / Ctrl+N top-level windows are not
  managed without a WM.
- **The last tab cannot be closed** (`SUMERU_LAST_TAB_PROTECTED`); `SUMERU_KEEP_LAST_TAB=0`
  disables the guard for tests.
- **Single gateway client**; an external client and the shim will evict each other
  (`SUMERU_GW_SHORT_CONN=1` works around it).
- **Persistent cookies commit ~30 s**; a hard kill can lose the last 30 s.
- **No CDP**: Playwright/Puppeteer cannot attach; debug pages with `evaluateTarget`,
  `snapshotAX` and screenshots.
- **No guarantee against every anti-bot check**; the project only guarantees no SDK
  injection, no CDP port and `navigator.webdriver=false`.

## Layout

```text
src/                 thin shim (spawn chrome, /healthz, /gw, /mcp)
bin/                 CLI (sumeru.mjs), container startup scripts
test/                node:test checks
scripts/             setup / smoke / clean / scan-secrets / acceptance
deploy/              compose.yaml + .env.example
chromium/            kernel version, GN args, minimal overlay, kernel artifact Dockerfile
chromium-src/        Chromium source cache (gitignored; one directory per version)
docs/                architecture, development, operations, kernel, troubleshooting, versioning
.github/workflows/   CI and Docker Hub image release
vendor/novnc/        noVNC (MPL-2.0) for offline image builds
.dsh/skills/        agent skills (MCP browser operation)
build/               kernel output (gitignored; fetched by setup)
```

## Docs

- [docs/architecture.md](docs/architecture.md) — architecture and control surface
- [docs/development.md](docs/development.md) — local development/debugging
- [docs/operations.md](docs/operations.md) — deployment, health, upgrade/rollback
- [docs/kernel.md](docs/kernel.md) — kernel/overlay/artifact
- [docs/versioning.md](docs/versioning.md) — versions/image tags/release flow
- [CHANGELOG.md](CHANGELOG.md) — changelog
- [docs/troubleshooting.md](docs/troubleshooting.md) — troubleshooting
- [docs/security.md](docs/security.md) — security model

## License

- **Sumeru original code**: PolyForm Noncommercial 1.0.0 — personal/
  noncommercial use only. Commercial use requires a
  [commercial license](LICENSE-COMMERCIAL.md). This is **source-available**,
  not OSI open source.
- **Chromium**: BSD-3-Clause plus third-party terms. The commercial license
  does not relicense Chromium; upstream notices must be preserved.
- Third-party components: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md);
  trademarks: [TRADEMARK.md](TRADEMARK.md).

> Google Chrome and Chromium are trademarks of Google LLC. This project is
> not affiliated with or endorsed by Google.
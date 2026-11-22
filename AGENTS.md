# AGENTS.md

This file gives coding agents repository-specific context. Read it before making
changes, then read `README.md`, `docs/architecture.md`, and
`docs/development.md` for details.

## Project

Sumeru is an AI-native cloud browser: a native Chromium window running in a
container, a private in-process gateway over a Unix domain socket, a thin Node
shim, and noVNC for human viewing/takeover.

- Node.js >= 22, ES modules (`.mjs`).
- Chromium source is pinned by `chromium/VERSION`.
- The shim exposes `POST /gw` and a stateless `POST /mcp`; it is not a CDP
  server and must never add a CDP listener or page SDK injection.
- Single window, single profile; Chromium remains the only state authority.

## Layout

```text
src/              shim runtime, HTTP routing, gateway client, MCP core
bin/              sumeru CLI
test/             node:test suites
scripts/          setup, smoke, acceptance, CI, secret scan
deploy/           compose.yaml and .env.example
chromium/         VERSION, GN args, minimal overlay, kernel Dockerfile
docs/             architecture, development, kernel, operations, security
chromium-src/     local, gitignored Chromium source cache
build/            local kernel artifact, gitignored
logs/             local script/build logs, gitignored
```

## Commands

```bash
npm test                 # unit tests; no Docker/kernel required
npm run scan-secrets     # secret scan
npm run ci               # tests + syntax + secret scan + compose config
npm run version:check    # version consistency
npm run smoke            # requires a running runtime on :8080
npm run acceptance       # m-series acceptance
```

Use `npm run ci` before committing. Do not weaken or skip tests to make a change
pass. Add or update a focused test for behavior changes.

## Logs

Every log file produced by a local script, build or ad-hoc command goes to the
gitignored `logs/` directory at the repo root. Do not write logs to the repo
root, `build/`, `dist/`, or any other tracked directory:

```bash
mkdir -p logs
docker build -f Dockerfile.runtime -t sumeru-runtime:local . > logs/runtime-build.log 2>&1
docker pull moailaozi/sumeru-shim:2.2.0 2>&1 | tee logs/docker-pull.log
node scripts/clean.mjs --logs    # remove logs/ (and any stray root *.log)
```

- Name the file after the operation (`logs/kernel-build.log`, `logs/smoke.log`,
  `logs/docker-pull.log`); overwrite or truncate it instead of accumulating
  numbered copies such as `kernel-build2.log`, `kernel-build3.log`.
- `/logs/` and `*.log` are gitignored; never commit log files or reference them
  from docs as if they were repo artifacts.
- Container/runtime logs are not files: read them with `npm run logs` or
  `docker logs -f sumeru` (see `docs/operations.md` §4).

## Kernel source and build

Chromium is not vendored. Fetch it per version into the gitignored
`chromium-src/<version>/src`:

```bash
./chromium/scripts/fetch-kernel-source.sh --shallow
# Optional controls: --version, --depth N, --jobs N, --no-hooks, --proxy URL
```

`--shallow` clones the main tree with `--depth` and uses
`gclient sync --no-history` for dependencies. The default is full history.

Build the kernel in Docker:

```bash
docker build -f chromium/Dockerfile.kernel -t sumeru-kernel-build chromium
docker run --rm \
  -v "$PWD/chromium-src/$(cat chromium/VERSION)/src:/src" \
  sumeru-kernel-build
```

Build output remains under `src/out/release-linux`. The minimal product overlay
is `chromium/overlay/current.patch`; GN arguments are in
`chromium/args.gn.linux`. Keep the overlay small and avoid modifying stock
Chromium files unless the product behavior requires it.

If the source tree changes, rebuild and update `build-info.json` with the
Chromium commit and chrome SHA256. Kernel artifacts must include
`LICENSES.chromium.html` (`generate_about_credits = true`).

## Architecture invariants

- Keep the gateway on the private UDS; do not expose it publicly.
- `/gw` is a transparent proxy: preserve gateway result values and error codes.
- `/mcp` is stateless JSON-only Streamable HTTP, protocol `2025-06-18`.
  - `POST` only; notifications return `202` with an empty body.
  - `capture_page` returns an MCP image content block, not base64 text.
  - Credentials are shared with `/gw` (`SUMERU_API_KEY`, comma-free single value);
    with a key set, `/mcp` requires it by default (`SUMERU_MCP_AUTH=auto`).
    Failures are HTTP `401` + `WWW-Authenticate: Bearer` (transport level, not a
    JSON-RPC error). Without a key both surfaces are open — bind the shim to
    loopback/private networks and never expose an unauthenticated path publicly.
    See `docs/auth.md`; credentials live in memory only (never on disk).
- `/healthz` keeps the eight-layer contract; `ready` is not a probe aggregate.
- Preserve the 12 gateway methods and the `isTrusted=true` input path.
- `evaluateTarget` targets the main frame/main world, does not await promises,
  and serializes non-JSON values as `{}`.
- Do not add Playwright/Puppeteer, CDP, page injection, or a general
  file-management subsystem without an explicit product request.

## Style

- Use named exports and small focused modules; keep the dependency surface
  minimal.
- Preserve public response shapes and existing error codes unless the change is
  intentional and documented.
- Comments and docs may be Chinese or English; keep `README.md` and
  `README.en.md` consistent when user-facing behavior changes.
- Do not reformat unrelated files or rewrite generated/vendor files.
- Do not commit `chromium-src/`, `build/`, `dist/`, `logs/`, local profiles, or
  `chromium/scripts/publish-kernel.sh`.

## Security

- Never commit credentials, tokens, private keys, browser profiles, or `.env`
  files.
- Do not print secrets in logs or test output.
- Keep the shim/gateway on loopback or a private network; no default public MCP
  or gateway exposure.
- `/mcp` and `/gw` share one credential (`SUMERU_API_KEY`); set it whenever the
  shim leaves loopback. An unconfigured key means both surfaces are open — that
  is a deployment constraint, not an authorization model (`docs/auth.md`).

## Licensing

- Original code is source-available under PolyForm Noncommercial 1.0.0.
  Commercial use requires a separate written commercial license.
- Chromium and third-party components retain their own licenses; do not remove
  or relicense their notices.
- Contributions require the CLA in `CLA.md`.
- Do not create releases, tags, or publish Docker images unless explicitly
  asked; release checks are in `docs/release-checklist.md`.

## Git

- Use Conventional Commits, one topic per commit.
- Run `npm run ci` (or at minimum `npm test` and `npm run scan-secrets`) before
  committing.
- Do not commit or push unless the user asks.
- Do not create tags or releases; maintainers do that.
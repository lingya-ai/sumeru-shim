# Troubleshooting the Sumeru MCP browser

## First checks

1. `ping` — does the gateway answer?
2. `list_tabs` — are there real tabs and a targetId?
3. `GET /healthz` on the shim — eight layers (`x/synth/webui/gateway/kernel/window/vnc/ime`).
4. Container logs — `[SUMERU-GW]` lines show each response.

If `ping` fails, the problem is the shim/gateway/container, not your tool call.
If `ping` succeeds but a page call fails, the target or page state is the problem.

## Error map

| Symptom | Likely cause | Fix |
|---|---|---|
| `工具失败: [SUMERU_TASK_SPACE_NOT_FOUND] no target: ...` | stale/unknown targetId | `list_tabs`; use current id |
| `工具失败: [SUMERU_LAST_TAB_PROTECTED]` | tried to close the only tab | `navigate_target` instead |
| `工具失败: [SUMERU_SCREENSHOT_FAILED]` | page not painted / capture failed | wait for load, activate tab, retry |
| `工具失败: [SUMERU_OPERATION_FAILED] eval exception` | expression threw | wrap in `try/catch`; check selector |
| `工具失败: [GW_EVAL_ERROR]` | gateway/DevTools-level eval error | simplify expression, check page/context |
| `工具失败: [GATEWAY_TIMEOUT]` | 15 s shim timeout | avoid blocking JS; split long work |
| `工具失败: [SUMERU_OPERATION_FAILED] agent host closed` | tab/agent closed during eval | re-list tabs; do not close with eval in flight |
| `工具失败: [GW_UNKNOWN_METHOD]` | wrong tool/method | use the 12 tools only |
| HTTP 401 / gateway auth failure | API key mismatch | set `SUMERU_API_KEY` and `X-Sumeru-Token` consistently |
| `gateway closed` | shim gateway connection replaced | one client only; don't bypass shim |

## Common semantic mistakes

### “Playwright/CDP cannot connect”

There is **no CDP**. Do not look for `--remote-debugging-port`, a WebSocket
endpoint, or a debugging pipe. Use the MCP tools.

### `evaluate_target` returns `{}` for a Promise

The runtime does not await Promises. Poll a synchronous predicate instead.

### `evaluate_target` returns `{}` for a DOM node/function

Return values must be JSON-serializable. Use `.innerText`, `.getAttribute(...)`,
`.getBoundingClientRect()`, or `JSON.stringify(...)`.

### Expression throws for a missing element

An exception fails the whole call. Use optional chaining/defaults:

```text
document.querySelector('#maybe')?.innerText ?? null
```

### Coordinates are wrong

`dispatch_mouse` x/y are **viewport CSS pixels**, not page coordinates. Scroll
with `scrollIntoView({block:'center'})` and read the rect again.

### Background tab does not update/screenshot as expected

Call `activate_tab` first. Background timers may be throttled; activate for
deterministic work.

### The last tab will not close

By design. Navigate it to `about:blank` or another URL. `SUMERU_KEEP_LAST_TAB=0`
is for disposable test runtimes only.

### Tab count/target changed after navigation

`targetId` stays the same for a tab across navigations, but a closed tab's id is
stale forever. Re-list.

### Human is also using the browser

No gating/arbitration: your click can race a human's. Coordinate through the task
owner; don't close tabs you did not create.

## Health layer hints

| Layer false | Meaning |
|---|---|
| `gateway` | UDS socket missing / browser not started |
| `kernel` | shim cannot maintain gateway connection |
| `window` | browser window not ready |
| `vnc` / `webui` | noVNC sidecar issue (agent tools may still work) |
| `x` | Xvfb missing; chrome cannot render |
| `ime` | `SUMERU_IME=fcitx` but IME missing; non-IME tools still work |

## Recovery sequence

1. `ping`; if down, restart the runtime container and check `/healthz`.
2. `list_tabs`; discard cached ids.
3. `activate_tab` the working tab.
4. Re-read with `snapshot_ax`/`evaluate_target`.
5. Retry the action once; if it still fails, capture `capture_page` + error text
   and hand over with the exact tool call and code.
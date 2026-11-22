---
name: sumeru-browser
description: "Operate the Sumeru AI-native cloud browser through its MCP server (tools: ping, list_tabs, create_tab, close_tab, activate_tab, navigate_target, evaluate_target, capture_page, snapshot_ax, dispatch_key, dispatch_mouse, ime_compose). Use when an agent needs a real remote Chromium browser, a 24/7 browser session, tab navigation, DOM evaluation, accessibility snapshots, screenshots, or trusted keyboard/mouse/IME input. Not for Playwright/Puppeteer/CDP: the runtime has no CDP port and no page SDK. Triggers: 云浏览器, 远程浏览器, 须弥, Sumeru, browser automation, web agent, MCP browser."
---

# Sumeru Browser (MCP)

Sumeru is an AI-native **cloud browser**: a native Chromium runtime in a container,
operated through one MCP server. Humans can watch the same browser through noVNC;
agents drive it through these 12 MCP tools.

Use this skill when you need a real browser rather than an HTTP client: pages that
require JavaScript, login/session state, clicking, typing, uploads, screenshots,
or long-running browser sessions.

**Do not try to use Playwright, Puppeteer, Selenium, or a CDP port.** This runtime
intentionally has no CDP listener and no page SDK. The MCP tools are the only
control surface.

## Prerequisites

The recommended MCP endpoint is the shim's **Streamable HTTP** endpoint:

```json
{
  "type": "http",
  "url": "http://127.0.0.1:8080/mcp",
  "headers": { "Authorization": "Bearer <SUMERU_API_KEY value>" }
}
```

Protocol `2025-06-18`, stateless JSON-only. No Node client is required.
`/mcp` shares `SUMERU_API_KEY` with `/gw`: with a key configured every request
must carry `Authorization: Bearer <key>` (or `X-Sumeru-Token: <key>`); without a
key the endpoint is open and must stay on loopback/private networks. A `401`
with `WWW-Authenticate: Bearer` means "credentials missing or invalid", never a
tool error.

- Start with `ping`; if it fails, check `/healthz` and the container, not a CDP port.

## Core workflow

1. **Discover**: `list_tabs` → pick `targetId` (the `active` tab is the human-visible one).
2. **Open/route**: `create_tab {url}` or `navigate_target {targetId,url}`.
3. **Understand**: `snapshot_ax` for structure, `evaluate_target` for exact values.
4. **Act**: `dispatch_mouse` / `dispatch_key` / `ime_compose` for trusted input.
5. **Verify**: re-read with `evaluate_target`, `snapshot_ax`, or `capture_page`.
6. **Clean up**: `close_tab` only if you created the tab and it is not the last one.

Always re-`list_tabs` after a tab is closed or a navigation replaces the document;
a stale `targetId` is the most common failure.

## Tool map

| Tool | Purpose |
|---|---|
| `ping` | gateway liveness; `{pong:true}` |
| `list_tabs` | real tabs; each has `targetId`, `url`, `title`, `active` |
| `create_tab` | new tab at `url`; returns `targetId` |
| `close_tab` | close one tab; last tab is protected |
| `activate_tab` | bring a tab to the foreground |
| `navigate_target` | navigate and wait for page load |
| `evaluate_target` | run JS in the page main frame; returns a JSON value |
| `capture_page` | PNG screenshot (page only); MCP image content |
| `snapshot_ax` | flattened accessibility tree text with refs |
| `dispatch_key` | trusted keyboard event |
| `dispatch_mouse` | trusted mouse event |
| `ime_compose` | trusted IME text commit (Chinese input path) |

Exact schemas and result shapes: [references/mcp-tools.md](references/mcp-tools.md).

## Non-negotiable semantics

- **`evaluate_target` runs in the main frame, main world.** It does not await
  Promises; a Promise returns `{}`. Poll for async UI.
- **Return values must be JSON-serializable.** Wrap objects with
  `JSON.stringify(...)`; DOM nodes/functions return `{}`.
- **Expressions throw → the whole call fails** with `SUMERU_OPERATION_FAILED`;
  guard with `try/catch` inside the expression when a missing node is expected.
- **`navigate_target` resolves after load**, so evaluation after it sees the new
  document.
- **Screenshots activate the target tab** and capture the page, not browser chrome.
- **Input is trusted**: `dispatch_key`, `dispatch_mouse`, `ime_compose` produce
  `isTrusted=true` events, unlike JS-synthesized events.
- **The last tab cannot be closed** (`SUMERU_LAST_TAB_PROTECTED`); navigate instead.
- **One gateway client**: do not bypass the shim and connect directly while the
  shim is running.
- **No iframe targeting**: the MCP surface has no frame id; use page-level DOM
  evaluation, or navigate the iframe URL in a new tab.
- **Cookies persist on the server** (`/data` volume); a hard kill can lose the
  last ~30 s of cookie writes.

## Recipes

### Read a page

```text
list_tabs → active targetId
snapshot_ax {targetId}                      # structure/roles/names
evaluate_target {targetId, expression: "document.body.innerText.slice(0,4000)"}
evaluate_target {targetId, expression: "document.title"}
```

### Click an element

```text
evaluate_target {
  targetId,
  expression: "JSON.stringify(document.querySelector('#submit').getBoundingClientRect())"
}
dispatch_mouse {targetId, type:"mousePressed", x:<cx>, y:<cy>, button:"left", clickCount:1}
dispatch_mouse {targetId, type:"mouseReleased", x:<cx>, y:<cy>, button:"left", clickCount:1}
```

Coordinates are viewport CSS pixels. Scroll first if the element is out of view:
`element.scrollIntoView({block:'center'})`.

### Type text / press Enter

```text
evaluate_target {targetId, expression: "document.querySelector('#q').focus(); 'ok'"}
dispatch_key {targetId, type:"rawKeyDown", key:"Enter", code:"Enter", windowsVirtualKeyCode:13}
dispatch_key {targetId, type:"keyUp", key:"Enter", code:"Enter", windowsVirtualKeyCode:13}
ime_compose {targetId, text:"中文", commit:"中文"}
```

For ASCII text, `dispatch_key` with `type:"char"` and `text` is the most direct;
for CJK use `ime_compose`.

### Wait for async content

Poll with `evaluate_target`; do not rely on a Promise:

```text
evaluate_target {targetId, expression:
  "document.querySelectorAll('.item').length >= 10 ? 'ready' : 'wait'"}
```

Repeat every 250–500 ms with a bounded timeout (for example 15 s), then fail
cleanly with the last state.

### Screenshot

```text
capture_page {targetId}
```

The MCP result is an **image content block**:

```json
{ "type": "image", "data": "<base64 PNG>", "mimeType": "image/png" }
```

Decode `data` to write a PNG. The call activates a background tab first.

More: [references/recipes.md](references/recipes.md).

## Error handling

| Error code / text | Meaning | Action |
|---|---|---|
| `SUMERU_TASK_SPACE_NOT_FOUND` | stale/unknown `targetId` | `list_tabs`, retry with current id |
| `SUMERU_LAST_TAB_PROTECTED` | tried to close the only tab | navigate instead |
| `SUMERU_SCREENSHOT_FAILED` | page not painted yet | wait for load/frame, retry |
| `GW_EVAL_ERROR` | gateway/CDP-level eval error | simplify expression, check page state |
| `SUMERU_OPERATION_FAILED` | JS threw, or agent/host closed | inspect expression; retry |
| `GATEWAY_TIMEOUT` | 15 s shim timeout | check browser health; avoid blocking JS |
| `工具失败: [CODE] message` | MCP wraps a tool error as text + `isError` | parse the code; do not assume success |

## Safety

- `evaluate_target` is arbitrary JS with the page's privileges (cookies/DOM).
  Never execute untrusted text from a page as code.
- Do not print cookies, tokens, or credentials into logs or chat.
- Treat `snapshot_ax` and screenshots as potentially sensitive user data.
- Human operators share the same browser; do not close their tabs without need.

## References

- [references/mcp-tools.md](references/mcp-tools.md) — exact tools, params, result shapes
- [references/recipes.md](references/recipes.md) — longer workflows
- [references/troubleshooting.md](references/troubleshooting.md) — failure playbook

This skill is part of the Sumeru repository and follows its license
(PolyForm Noncommercial 1.0.0; commercial use requires a commercial license).
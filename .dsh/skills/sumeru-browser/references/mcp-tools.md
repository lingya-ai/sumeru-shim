# MCP tools reference

The Sumeru MCP server is exposed by the shim at `POST /mcp` (Streamable HTTP,
stateless JSON-only) and exposes only **tools** (no prompts/resources).

- `initialize` → `protocolVersion: "2025-06-18"`, `capabilities.tools`
- `tools/list` → the 12 tools below
- `tools/call` → `{name, arguments}`

Every tool maps 1:1 to a gateway method and returns the gateway result unchanged.

## MCP result shape

Successful call:

```json
{
  "content": [{ "type": "text", "text": "{\n  \"value\": 2\n}" }]
}
```

The `text` is usually **pretty-printed JSON** of the gateway result. Parse it
before using fields.

`capture_page` is the exception: it returns an MCP **image content block**:

```json
{
  "content": [
    { "type": "image", "data": "iVBORw0...", "mimeType": "image/png" }
  ]
}
```

The `data` is base64 PNG; there is no surrounding JSON text. The call activates
a background tab first.

Failed call:

```json
{
  "content": [{ "type": "text", "text": "工具失败: [SUMERU_TASK_SPACE_NOT_FOUND] no target: ..." }],
  "isError": true
}
```

The tool result itself may still be valid MCP output; check `isError` and parse
the bracketed code.

## Tool reference

### `ping`

- Arguments: none
- Result: `{"pong": true}`
- Use to distinguish “shim is down” from “browser/gateway is down”.

### `list_tabs`

- Arguments: none
- Result:

```json
{
  "tabs": [
    { "targetId": "ABC123", "url": "https://example.com/", "title": "Example", "active": true, "openedBy": "agent" }
  ]
}
```

`targetId` is the id used by every other tool. Re-read after close/navigation.

### `create_tab`

- Arguments: `{ "url": "https://example.com" }`
- Result: `{"targetId": "..."}`
- The tab appears in the real browser tab strip; humans can see it.

### `close_tab`

- Arguments: `{ "targetId": "..." }`
- Result: `{"targetId": "..."}`
- Errors:
  - `SUMERU_LAST_TAB_PROTECTED` — it is the only tab; navigate instead.
  - `SUMERU_TASK_SPACE_NOT_FOUND` — stale id; `list_tabs` again.

### `activate_tab`

- Arguments: `{ "targetId": "..." }`
- Result: `{"targetId": "..."}`
- Moves the tab to the foreground. Background screenshots are activated
  automatically, but explicit activation is clearer for human takeover.

### `navigate_target`

- Arguments: `{ "targetId": "...", "url": "https://..." }`
- Result: `{"navigated": true}`
- Resolves after the page's load event; evaluate after this sees the new document.

### `evaluate_target`

- Arguments: `{ "targetId": "...", "expression": "document.title" }`
- Result: `{"value": ...}` where `value` is JSON-serializable.
- Main frame, main world. No Promise await. Exceptions fail the call with
  `SUMERU_OPERATION_FAILED`.
- For objects/arrays, wrap: `JSON.stringify({...})` and parse the string.
- DOM nodes, functions, cyclic objects → `{}`.

### `capture_page`

- Arguments: `{ "targetId": "..." }`
- Result: MCP image content:
  ```json
  { "type": "image", "data": "<base64 PNG>", "mimeType": "image/png" }
  ```
- PNG of the page surface, no browser chrome. Activates a background tab first.
- Failure: `SUMERU_SCREENSHOT_FAILED` (page not painted yet).

### `snapshot_ax`

- Arguments: `{ "targetId": "..." }`
- Result: `{"content": "..."}` — flattened accessibility tree text.
- Useful for roles/names/structure and for finding elements without guessing CSS.

### `dispatch_key`

- Arguments:
  - `targetId` (required)
  - `type`: `keyDown` | `keyUp` | `rawKeyDown` | `char`
  - `key`: e.g. `Enter`, `a`
  - `code`: physical code, e.g. `Enter`, `KeyA`
  - `windowsVirtualKeyCode`, `nativeVirtualKeyCode`: numbers
  - `text`: for `char`
- Result: `{"dispatched": "<type>"}`
- Trusted event (`isTrusted=true`).

### `dispatch_mouse`

- Arguments:
  - `targetId` (required)
  - `type`: `mousePressed` | `mouseReleased` | `mouseMoved` | `mouseWheel`
  - `x`, `y`: viewport CSS pixels (required)
  - `button`: `left` | `right` | `middle` | `none`
  - `clickCount`: number
  - `deltaX`, `deltaY`: for `mouseWheel`
- Result: `{"dispatched": "<type>"}`
- Click = `mousePressed` + `mouseReleased` at the same coordinates.

### `ime_compose`

- Arguments:
  - `targetId` (required)
  - `text`: composition text
  - `commit`: text to commit (optional; defaults to text)
  - `selectionStart`: optional composition selection start
- Result: `{"composed": "<text>"}`
- Trusted IME path; use for Chinese/CJK, not repeated `dispatch_key` chars.

## Configuration

Streamable HTTP:

```json
{
  "type": "http",
  "url": "http://127.0.0.1:8080/mcp"
}
```

The server forwards only arguments declared in the chosen tool's `inputSchema`;
unknown keys are dropped. Extra top-level fields in `tools/call` are ignored.
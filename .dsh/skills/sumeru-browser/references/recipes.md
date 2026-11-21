# Recipes

Assumes a configured `sumeru-browser` MCP server. All results are returned as MCP
text content; parse JSON before inspecting fields.

## 1. Check health and discover tabs

```text
ping
list_tabs
```

Pick `active: true` unless the task explicitly targets another tab. Keep the
`targetId`; every subsequent call needs it.

## 2. Open a page

```text
create_tab {"url": "https://example.com"}
# -> {"targetId": "<id>"}

activate_tab {"targetId": "<id>"}
navigate_target {"targetId": "<id>", "url": "https://example.com/login"}
```

`navigate_target` returns after load. Do not sleep before evaluating.

## 3. Read structure and text

```text
snapshot_ax {"targetId": "<id>"}
evaluate_target {"targetId": "<id>", "expression": "document.title"}
evaluate_target {"targetId": "<id>", "expression": "document.body.innerText.slice(0, 4000)"}
```

If `innerText` is huge, slice it. For structured extraction:

```text
evaluate_target {
  "targetId": "<id>",
  "expression": "JSON.stringify([...document.querySelectorAll('a')].slice(0,20).map(a => ({text:a.innerText, href:a.href})))"
}
```

The `value` is a JSON **string**; parse it again.

## 4. Find and click a control

Get a viewport rectangle (and scroll if needed):

```text
evaluate_target {
  "targetId": "<id>",
  "expression": "(() => { const e=document.querySelector('#submit'); if(!e) return 'missing'; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height}); })()"
}
```

Then:

```text
dispatch_mouse {"targetId":"<id>","type":"mousePressed","x":640,"y":360,"button":"left","clickCount":1}
dispatch_mouse {"targetId":"<id>","type":"mouseReleased","x":640,"y":360,"button":"left","clickCount":1}
```

Coordinates are CSS pixels relative to the viewport, not the whole page.

## 5. Fill a form with real input

Focus first:

```text
evaluate_target {
  "targetId": "<id>",
  "expression": "const e=document.querySelector('#q'); e.focus(); e.select(); 'focused'"
}
```

ASCII:

```text
dispatch_key {"targetId":"<id>","type":"char","text":"h","key":"h"}
dispatch_key {"targetId":"<id>","type":"char","text":"i","key":"i"}
```

CJK:

```text
ime_compose {"targetId":"<id>","text":"中文","commit":"中文"}
```

Submit with Enter:

```text
dispatch_key {"targetId":"<id>","type":"rawKeyDown","key":"Enter","code":"Enter","windowsVirtualKeyCode":13}
dispatch_key {"targetId":"<id>","type":"keyUp","key":"Enter","code":"Enter","windowsVirtualKeyCode":13}
```

## 6. Wait for asynchronous UI

`evaluate_target` does not await Promises. Poll a synchronous predicate:

```text
evaluate_target {
  "targetId": "<id>",
  "expression": "document.querySelectorAll('.item').length >= 10 ? 'ready' : 'wait'"
}
```

Repeat every 250–500 ms; stop after a bounded timeout (e.g. 15 s) and report the
last state. For a specific value:

```text
"document.querySelector('.status')?.innerText ?? null"
```

## 7. Screenshot

```text
capture_page {"targetId":"<id>"}
```

The result is an MCP image content block:
`{"type":"image","data":"<base64>","mimeType":"image/png"}`. Decode `data` to a
PNG file in the client. Screenshots are page-only (no tab strip/address bar).

## 8. Multi-tab workflow

```text
list_tabs
create_tab {"url":"https://example.com/a"}
create_tab {"url":"https://example.com/b"}
activate_tab {"targetId":"<b>"}
close_tab {"targetId":"<a>"}
```

Do not close the last tab; navigate it instead. A closed tab's `targetId` is
immediately stale.

## 9. Human takeover / login

The browser is shared with humans through noVNC. If a login needs a human:

1. `activate_tab` the relevant tab;
2. ask the human to complete the login in noVNC;
3. re-read `list_tabs` / `evaluate_target` after they confirm;
4. do not close their tabs or clear cookies.

Cookies and profile persist on the server, so a login survives container restarts
(within the ~30 s cookie flush window).

## 10. Long-running / 7×24 tasks

- Keep one tab for the task; avoid creating a tab per iteration.
- Re-`list_tabs` after errors; do not cache `targetId` forever.
- Poll with `evaluate_target`; avoid long blocking JS (it can hit the 15 s gateway
  timeout).
- Take a screenshot on failure for diagnosis; include the last `snapshot_ax`
  excerpt.
- If the runtime restarts, the profile volume restores tabs; re-discover them.
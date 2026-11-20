# Kernel overlay

`current.patch` is the **minimal diff** against pristine Chromium
`156.0.8078.74`.

## Contents

| Area | Files |
|---|---|
| Gateway | `sumeru/browser/gateway/sumeru_gateway.{cc,h}`, `sumeru_gateway_start.h` |
| Tabs | `sumeru/browser/tabs/tab_ops.{cc,h}`, `tab_registry.{cc,h}`, `chrome/browser/sumeru/tabs/*` |
| Snapshot | `sumeru/browser/snapshot/snapshot_serializer.{cc,h}` |
| Capture | `content/browser/renderer_host/sumeru_page_capture.cc`, `content/public/browser/sumeru_page_capture.h` |
| Wiring | 5 files: content/browser BUILD + main loop, chrome/browser BUILD + main, tab_strip_model |

20 files / ~123 KB. Everything else (page injection, space/ownership, agent
visual layer, Windows toolchain patches, …) is intentionally excluded.

## Regenerate

1. Start from a pristine tag tree.
2. Copy only the active files above from the build tree.
3. Produce a `git`-style patch with `a/`/`b/` prefixes (no mode changes, no
   unrelated hunks).
4. Verify:

```bash
git -C /src apply --check /overlay/current.patch
```

## Build

See `Dockerfile.kernel` and `scripts/build-kernel.sh`.
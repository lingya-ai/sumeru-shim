#!/usr/bin/env node
// M01 pixel assertion: the window really is a native Chromium
// window — a tab strip + address bar above the page, no launcher/grid.
//
// Requires the accept-variant image (`--build-arg INSTALL_CAPTURE_TOOLS=1`,
// provides `xwd`). The XWD dump is read from the container and parsed here.
//
//   node m01-window-pixels.mjs --container sumeru-accept [--port 18800]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const container = argOf("container", "sumeru-accept");
const display = argOf("display", ":99");
const results = [];
const check = (n, ok, d) => {
  results.push({ n, ok, d: String(d ?? "") });
  console.log(n, ok ? "PASS" : "FAIL", d ?? "");
};

const dir = mkdtempSync(join(tmpdir(), "m01-"));
const xwdPath = join(dir, "root.xwd");
execFileSync("docker", [
  "exec", container, "sh", "-c",
  `DISPLAY=${display} xwd -root -silent > /tmp/root.xwd && wc -c < /tmp/root.xwd`,
], { stdio: "pipe" });
execFileSync("docker", ["cp", `${container}:/tmp/root.xwd`, xwdPath], { stdio: "pipe" });
const buf = readFileSync(xwdPath);

// X Window Dump (XWD) v7: 25 big-endian u32 header words, then window name,
// then (for ZPixmap) the raster. header_size (word 0) covers all extra fields.
const be32 = (off) => buf.readUInt32BE(off);
const headerSize = be32(0);
const fileVersion = be32(4);
const pixmapFormat = be32(8);       // 2 = ZPixmap
const width = be32(16);             // pixmap_width  (word 4)
const height = be32(20);            // pixmap_height (word 5)
const bitsPerPixel = be32(44);      // word 11
const bytesPerLine = be32(48);      // word 12

check("M01-xwd-version", fileVersion === 7, `version=${fileVersion}`);
check("M01-zpixmap", pixmapFormat === 2, `format=${pixmapFormat}`);
// --expect-size 1920x1080 (a trailing x24 depth is tolerated)
const expectedSrc = argOf("expect-size", process.env.SUMERU_SCREEN ?? "1280x800");
const expectedMatch = /^(\d+)x(\d+)/.exec(expectedSrc);
if (!expectedMatch) throw new Error(`cannot parse expected size from "${expectedSrc}"`);
const expectedW = Number(expectedMatch[1]);
const expectedH = Number(expectedMatch[2]);
check(
  "M01-window-size",
  width === expectedW && height === expectedH,
  `${width}x${height} (expected ${expectedW}x${expectedH})`,
);
check("M01-bpp", bitsPerPixel >= 24, `bpp=${bitsPerPixel}`);

const bytesPerPixel = Math.ceil(bitsPerPixel / 8);
const pixelAt = (x, y) => {
  const off = headerSize + y * bytesPerLine + x * bytesPerPixel;
  if (off + 3 >= buf.length) return null;
  // Xvfb 24/32bpp true colour: native byte order B,G,R,X.
  return [buf[off + 2], buf[off + 1], buf[off]];
};

const rowColors = (y0, y1) => {
  const set = new Set();
  for (let y = y0; y < y1; y += 2) {
    for (let x = 0; x < width; x += 4) {
      const px = pixelAt(x, y);
      if (px) set.add(px.join(","));
    }
  }
  return set;
};

const topStrip = rowColors(0, 40);        // tab strip + address bar band
const pageArea = rowColors(120, 700);     // page content

check("M01-top-strip-present", topStrip.size >= 3, `distinct colors=${topStrip.size}`);
// A rendered page only has to be non-flat here; content richness is the page's
// business, not this gate's (a page with one heading is ~7 shades of white).
check("M01-page-rendered", pageArea.size >= 3, `distinct colors=${pageArea.size}`);

// A launcher/grid screen would be a near-uniform dark canvas across the whole
// window; the native window has a bright page area under a distinct toolbar.
let bright = 0;
let total = 0;
for (let y = 120; y < 700; y += 6) {
  for (let x = 0; x < width; x += 8) {
    const px = pixelAt(x, y);
    if (!px) continue;
    total++;
    if (px[0] + px[1] + px[2] > 360) bright++;
  }
}
const brightRatio = total ? bright / total : 0;
check("M01-page-not-launcher", brightRatio > 0.3, `bright ratio=${brightRatio.toFixed(2)}`);

// The strip and the page must differ enough to prove a real toolbar exists.
const stripAvg = [...topStrip].length;
const distinctBand = (() => {
  const a = pixelAt(Math.floor(width / 2), 8);
  const b = pixelAt(Math.floor(width / 2), 300);
  return a && b ? a.join(",") !== b.join(",") : false;
})();
check("M01-toolbar-distinct", distinctBand, `stripColors=${stripAvg}`);

writeFileSync(join(dir, "summary.json"), JSON.stringify(results, null, 2));
const pass = results.filter((r) => r.ok).length;
console.log(`\nM01-PIXELS: ${pass}/${results.length}`);
process.exit(pass === results.length ? 0 : 1);

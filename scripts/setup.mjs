#!/usr/bin/env node
/**
 * Kernel artifact setup ().
 *
 * Default: verify build/chrome if present, else explain how to fetch it.
 *   node scripts/setup.mjs
 *   node scripts/setup.mjs --check
 *   node scripts/setup.mjs --fetch
 *   node scripts/setup.mjs --from ./sumeru-kernel-....tar.gz
 *   node scripts/setup.mjs --url https://... --force
 *
 * No npm dependencies: fetch + node:crypto + system tar.
 */
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "build");
const INFO_PATH = join(ROOT, "build-info.json");

function parseArgs(argv) {
  const out = { mode: "auto", from: "", url: "", force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") out.mode = "check";
    else if (arg === "--fetch") out.mode = "fetch";
    else if (arg === "--force") out.force = true;
    else if (arg.startsWith("--from=")) {
      out.from = arg.slice("--from=".length);
      out.mode = "fetch";
    } else if (arg === "--from") {
      out.from = argv[++i] ?? "";
      out.mode = "fetch";
    } else if (arg.startsWith("--url=")) {
      out.url = arg.slice("--url=".length);
      out.mode = "fetch";
    } else if (arg === "--url") {
      out.url = argv[++i] ?? "";
      out.mode = "fetch";
    } else {
      die(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function log(msg) {
  console.error(`[setup] ${msg}`);
}

function die(msg, code = 1) {
  console.error(`[setup] ERROR: ${msg}`);
  process.exit(code);
}

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const rs = createReadStream(path);
    rs.on("error", reject);
    rs.on("data", (chunk) => hash.update(chunk));
    rs.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function readInfo() {
  if (!existsSync(INFO_PATH)) die(`missing ${INFO_PATH}`);
  try {
    return JSON.parse(readFileSync(INFO_PATH, "utf8"));
  } catch (error) {
    die(`invalid build-info.json: ${error.message}`);
  }
}

function requiredFiles(info) {
  return Array.isArray(info.requiredFiles) && info.requiredFiles.length
    ? info.requiredFiles
    : ["chrome"];
}

async function check(info) {
  const missing = requiredFiles(info).filter((name) => !existsSync(join(BUILD, name)));
  if (missing.length) {
    log(`build/ is incomplete; missing: ${missing.join(", ")}`);
    return false;
  }
  const chromePath = join(BUILD, "chrome");
  const actual = await sha256File(chromePath);
  const expected = String(info.chromeSha256 ?? "").toLowerCase();
  if (!expected) {
    log("build-info.json has no chromeSha256; skipping hash check");
    return true;
  }
  if (actual !== expected) {
    log("chrome SHA256 mismatch");
    log(`  expected ${expected}`);
    log(`  actual   ${actual}`);
    return false;
  }
  log(`build/ OK (chrome sha256 ${actual.slice(0, 16)}…)`);
  return true;
}

async function download(url, dest) {
  log(`downloading ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) die(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let seen = 0;
  let lastPct = -1;
  const source = Readable.fromWeb(res.body);
  source.on("data", (chunk) => {
    seen += chunk.length;
    if (total > 0) {
      const pct = Math.floor((seen / total) * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct;
        log(`  ${pct}% (${(seen / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB)`);
      }
    }
  });
  await pipeline(source, createWriteStream(dest));
  log(`downloaded ${(seen / 1048576).toFixed(1)} MB -> ${dest}`);
}

function extract(archive) {
  if (!existsSync(archive)) die(`archive not found: ${archive}`);
  mkdirSync(BUILD, { recursive: true });
  log(`extracting ${archive} -> build/`);
  const tar = process.platform === "win32" ? "tar.exe" : "tar";
  const result = spawnSync(tar, ["-xzf", archive, "-C", BUILD], { stdio: "inherit" });
  if (result.error) die(`tar failed: ${result.error.message}`);
  if (result.status !== 0) die(`tar exited with ${result.status}`);
}

async function verifyArchive(info, archive) {
  const expected = String(info.artifact?.sha256 ?? "").toLowerCase();
  if (!expected) {
    log("build-info.json has no artifact.sha256; skipping archive hash check");
    return;
  }
  const actual = await sha256File(archive);
  if (actual !== expected) {
    die(`artifact SHA256 mismatch\n  expected ${expected}\n  actual   ${actual}`);
  }
  log(`artifact sha256 OK (${actual.slice(0, 16)}…)`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const info = readInfo();

  if (args.mode === "check") {
    process.exit((await check(info)) ? 0 : 1);
  }

  if (args.mode === "fetch") {
    if (args.force && existsSync(BUILD)) {
      log("removing existing build/ (--force)");
      rmSync(BUILD, { recursive: true, force: true });
    }
    let archive = args.from;
    if (!archive) {
      const url = args.url || info.artifact?.url || "";
      if (!url) {
        die("no artifact URL configured. Use --from <path>, or fill artifact.url in build-info.json");
      }
      const name = info.artifact?.name || "sumeru-kernel.tar.gz";
      archive = join(tmpdir(), name);
      await download(url, archive);
    }
    await verifyArchive(info, archive);
    extract(archive);
    process.exit((await check(info)) ? 0 : 1);
  }

  if (existsSync(join(BUILD, "chrome"))) {
    process.exit((await check(info)) ? 0 : 1);
  }
  log("build/chrome is missing.");
  log("Use one of:");
  log("  npm run setup -- --from /path/to/sumeru-kernel-....tar.gz");
  log("  npm run setup -- --fetch            # after artifact.url is set in build-info.json");
  process.exit(1);
}

main().catch((error) => die(error?.stack ?? String(error)));

#!/usr/bin/env node
/**
 * Local cleanup helper ().
 *
 *   node scripts/clean.mjs                 # print usage
 *   node scripts/clean.mjs --logs          # remove logs/ (and stray root *.log)
 *   node scripts/clean.mjs --build         # remove build/
 *   node scripts/clean.mjs --all           # build/ + logs + node_modules + tmp-*
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOGS = join(ROOT, "logs");
const flags = new Set(process.argv.slice(2));

function remove(path) {
  if (!existsSync(path)) return false;
  rmSync(path, { recursive: true, force: true });
  console.log(`removed ${path}`);
  return true;
}

function removeLogs() {
  // Local logs live in logs/ (gitignored, see AGENTS.md).
  remove(LOGS);
  // Legacy: logs used to be written straight into the repo root.
  for (const name of readdirSync(ROOT)) {
    if (name.endsWith(".log") && statSync(join(ROOT, name)).isFile()) {
      remove(join(ROOT, name));
    }
  }
}

if (flags.size === 0) {
  console.log("usage: node scripts/clean.mjs --logs | --build | --all");
  process.exit(0);
}

if (flags.has("--all")) {
  remove(join(ROOT, "build"));
  remove(join(ROOT, "node_modules"));
  removeLogs();
  for (const name of readdirSync(ROOT)) {
    if (name.startsWith("tmp-") && statSync(join(ROOT, name)).isDirectory()) {
      remove(join(ROOT, name));
    }
  }
} else {
  if (flags.has("--build")) remove(join(ROOT, "build"));
  if (flags.has("--logs")) removeLogs();
}

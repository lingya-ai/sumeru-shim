#!/usr/bin/env node
/**
 * Portable CI entry ().
 *
 *   npm run ci
 *
 * Runs:
 *   - unit tests (node --test)
 *   - syntax check for every project .mjs
 *   - secret scan of tracked files
 *   - compose config validation (if docker is available)
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;

function run(label, command, args, opts = {}) {
  console.log(`\n[ci] ${label}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", ...opts });
  if (result.error) {
    console.error(`[ci] ${label}: ${result.error.message}`);
    failed += 1;
  } else if (result.status !== 0) {
    console.error(`[ci] ${label}: exit ${result.status}`);
    failed += 1;
  }
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, out);
    else if (name.endsWith(".mjs")) out.push(path);
  }
  return out;
}

run("unit tests", process.execPath, ["--test", "test/**/*.test.mjs"]);

const mjs = [join(ROOT, "src"), join(ROOT, "bin"), join(ROOT, "scripts"), join(ROOT, "test")]
  .flatMap((dir) => walk(dir));
console.log(`\n[ci] syntax check (${mjs.length} files)`);
for (const file of mjs) {
  const result = spawnSync(process.execPath, ["--check", file], { cwd: ROOT });
  if (result.status !== 0) {
    console.error(`[ci] syntax FAIL: ${file}`);
    failed += 1;
  }
}

run("secret scan", process.execPath, [join(ROOT, "scripts/scan-secrets.mjs")]);

const docker = spawnSync("docker", ["compose", "version"], { cwd: ROOT });
if (docker.status === 0) {
  run("compose config", "docker", ["compose", "-f", "deploy/compose.yaml", "config", "--quiet"]);
} else {
  console.log("\n[ci] docker not available; skipping compose config");
}

console.log(failed === 0 ? "\n[ci] PASS" : `\n[ci] FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);

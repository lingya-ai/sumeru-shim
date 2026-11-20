#!/usr/bin/env node
/**
 * Version consistency check (see docs/versioning.md).
 *
 *   node scripts/version.mjs                 # check package.json/build-info.json
 *   node scripts/version.mjs --version 2.1.0
 *   node scripts/version.mjs --tag v2.1.0
 *
 * Prints shell-friendly lines: VERSION, MAJOR_MINOR, IS_PRERELEASE, IS_STABLE.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const info = JSON.parse(readFileSync(join(ROOT, "build-info.json"), "utf8"));

const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : "";
};
const tag = valueOf("--tag");
const explicit = valueOf("--version");

let version = explicit || (tag ? tag.replace(/^v/, "") : pkg.version);
if (!version) {
  console.error("[version] no version");
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`[version] invalid semver: ${version}`);
  process.exit(1);
}
if (pkg.version !== version) {
  console.error(`[version] package.json is ${pkg.version}, expected ${version}`);
  process.exit(1);
}
if (info.sumeruVersion && info.sumeruVersion !== version) {
  console.error(`[version] build-info.sumeruVersion is ${info.sumeruVersion}, expected ${version}`);
  process.exit(1);
}
if (tag && !tag.startsWith("v")) {
  console.error(`[version] tag must start with v: ${tag}`);
  process.exit(1);
}

const [major, minor] = version.split(".");
const prerelease = version.includes("-");
console.log(`VERSION=${version}`);
console.log(`MAJOR_MINOR=${major}.${minor}`);
console.log(`IS_PRERELEASE=${prerelease}`);
console.log(`IS_STABLE=${!prerelease}`);
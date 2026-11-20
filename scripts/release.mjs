#!/usr/bin/env node
/**
 * Release check/helper ().
 *
 *   node scripts/release.mjs --check
 *   node scripts/release.mjs --notes
 *
 * It never uploads or pushes. It validates the local release inputs and prints
 * the exact commands/fields that still need a hosting decision.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TAG = process.env.RELEASE_TAG ?? "v2.1.0";

function hashFile(path) {
  return new Promise((resolveHash, reject) => {
    const h = createHash("sha256");
    const rs = createReadStream(path);
    rs.on("error", reject);
    rs.on("data", (c) => h.update(c));
    rs.on("end", () => resolveHash(h.digest("hex")));
  });
}

const info = JSON.parse(readFileSync(join(ROOT, "build-info.json"), "utf8"));
const artifact = join(ROOT, "dist", info.artifact?.name ?? "");
const problems = [];

if (!existsSync(artifact)) {
  problems.push(`missing artifact: ${artifact} (run package-kernel.sh and copy to dist/)`);
} else {
  const size = statSync(artifact).size;
  const actual = await hashFile(artifact);
  const expected = String(info.artifact?.sha256 ?? "").toLowerCase();
  if (!expected) problems.push("build-info.json artifact.sha256 is empty");
  else if (actual !== expected) problems.push(`artifact sha mismatch: ${actual} != ${expected}`);
  console.log(`artifact: ${info.artifact.name}`);
  console.log(`  size: ${(size / 1048576).toFixed(1)} MB`);
  console.log(`  sha256: ${actual}`);
}

const tag = spawnSync("git", ["rev-parse", "--verify", `refs/tags/${TAG}`], { cwd: ROOT });
if (tag.status !== 0) problems.push(`git tag ${TAG} missing`);
else console.log(`tag: ${TAG} -> ${tag.stdout.toString().trim()}`);

const status = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
if (status.stdout.trim()) problems.push("working tree is not clean");

if (!info.artifact?.url) {
  console.log("\nartifact.url is empty (hosting pending).");
  console.log("After uploading the artifact, set build-info.json.artifact.url and commit.");
}

console.log("\nremaining release steps:");
console.log(`  1) upload dist/${info.artifact?.name} to GitHub/Gitee Release or object storage`);
console.log("  2) set build-info.json artifact.url");
console.log(`  3) git push origin master --tags   # ${TAG}`);
console.log("  4) docker tag sumeru-runtime:local <registry>/sumeru-runtime:v2.0.0 && docker push ...");
console.log("  5) fresh machine: npm run setup -- --fetch && npm run up && npm run smoke");

if (problems.length) {
  console.error(`\n[release] ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("\n[release] local inputs OK (upload/push still pending)");

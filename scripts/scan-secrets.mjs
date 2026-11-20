#!/usr/bin/env node
/**
 * Scan tracked files for common secret patterns ().
 * Uses `git ls-files` so build/, ignored evidence and local keys are out of scope.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const patterns = [
  { name: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "github-token", re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: "openai-key", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
];

const listed = spawnSync("git", ["ls-files", "-z"], { encoding: "buffer" });
if (listed.status !== 0) {
  console.error("[scan] not a git repository");
  process.exit(2);
}
const files = listed.stdout.toString("utf8").split("\0").filter(Boolean);
const findings = [];

for (const file of files) {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    continue;
  }
  if (size > 2 * 1024 * 1024) continue;
  let text = "";
  try {
    const buf = readFileSync(file);
    if (buf.includes(0)) continue; // binary
    text = buf.toString("utf8");
  } catch {
    continue;
  }
  for (const { name, re } of patterns) {
    const match = re.exec(text);
    if (!match) continue;
    const line = text.slice(0, match.index).split("\n").length;
    findings.push({ file, line, name, sample: match[0].slice(0, 8) + "…" });
  }
}

if (findings.length === 0) {
  console.log(`[scan] ${files.length} tracked files: no secrets found`);
  process.exit(0);
}
for (const f of findings) {
  console.log(`${f.file}:${f.line}  ${f.name}  ${f.sample}`);
}
console.error(`[scan] ${findings.length} finding(s)`);
process.exit(1);

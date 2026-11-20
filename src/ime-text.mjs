/** Join hostctl CLI arguments into the exact text that should be committed. */
export function imeCommitText(parts) {
  if (!Array.isArray(parts)) throw new TypeError("imeCommitText expects an array");
  return parts.filter((value) => value !== undefined).join(" ");
}

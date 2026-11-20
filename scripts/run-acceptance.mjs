#!/usr/bin/env node
/**
 * Run the current m-series acceptance gate against a local runtime.
 *
 *   npm run acceptance
 *   GW_BASE=http://127.0.0.1:18880/gw npm run acceptance
 */
process.env.GW_BASE ??= "http://127.0.0.1:8080/gw";
console.log(`[acceptance] GW_BASE=${process.env.GW_BASE}`);
await import("./acceptance/linux/m-series/m-series-gate.mjs");

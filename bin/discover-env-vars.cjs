#!/usr/bin/env node
/**
 * Emit environment-variable metadata from a baseline. Without arguments, search
 * the local cache for an input. Write JSON to stdout unless an output path is given.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { discoverEnvVars } = require("../lib/discover-env.cjs");

function defaultBaseline() {
  const cacheDir = path.join(process.env.HOME || os.homedir(), ".cache", "claude-mod");
  if (!fs.existsSync(cacheDir)) return null;
  const versions = fs
    .readdirSync(cacheDir)
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
    .sort();
  for (let i = versions.length - 1; i >= 0; i--) {
    const p = path.join(cacheDir, versions[i], "baseline", "deobfuscated.js");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const os = require("os");

function main() {
  const [, , inputArg, outArg] = process.argv;
  const input = inputArg || defaultBaseline();
  if (!input || !fs.existsSync(input)) {
    console.error("Usage: discover-env-vars.cjs [baseline.js] [out.json]");
    console.error("  Scans the latest cached baseline if no path is given.");
    process.exit(1);
  }
  const code = fs.readFileSync(input, "utf8");
  const entries = discoverEnvVars(code);

  const byCategory = {};
  for (const e of entries) byCategory[e.category] = (byCategory[e.category] || 0) + 1;
  const payload = {
    summary: { baseline: input, total: entries.length, by_category: byCategory },
    entries,
  };
  const json = JSON.stringify(payload, null, 2);

  if (outArg) {
    fs.writeFileSync(path.resolve(outArg), json, "utf8");
  } else {
    process.stdout.write(json + "\n");
  }
  console.error(`Discovered ${entries.length} config env vars across ${Object.keys(byCategory).length} categories in ${path.basename(path.dirname(path.dirname(input)))}`);
}

if (require.main === module) {
  main();
}

module.exports = { discoverEnvVars };

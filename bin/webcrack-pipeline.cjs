#!/usr/bin/env node
/** Deobfuscate locally, validate, and preserve webcrack's output verbatim. */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { syntaxCheckModern } = require("../lib/utils.cjs");

// Verified against a freshly downloaded macOS 2.1.181 binary. Global PATH
// installations must match too; otherwise the fallback installs this version.
const WEBCRACK_VERSION = "2.15.1";

function main() {
  const args = process.argv.slice(2);
  let input;
  let outputDir;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output-dir" || args[i] === "-o") {
      outputDir = args[++i];
      if (!outputDir || outputDir.startsWith("-")) throw new Error("--output-dir requires a path");
    } else if (!args[i].startsWith("-") && !input) {
      input = args[i];
    } else {
      throw new Error(`Unknown argument: ${args[i]}`);
    }
  }
  if (!input) throw new Error("Usage: webcrack-pipeline.cjs <cli.js> [--output-dir <dir>]");
  input = path.resolve(input);
  if (!fs.statSync(input).isFile()) throw new Error(`Not a file: ${input}`);
  outputDir = path.resolve(outputDir || path.join(path.dirname(input), "baseline"));
  const output = path.join(outputDir, "deobfuscated.js");

  if (fs.existsSync(output) && fs.statSync(output).mtimeMs > fs.statSync(input).mtimeMs && syntaxCheckModern(output) === null) {
    console.log(`Already deobfuscated: ${output}`);
    console.log(`DEOBFUSCATED:${output}`);
    return;
  }

  fs.mkdirSync(outputDir, { recursive: true });
  let runner = process.env.WEBCRACK_RUNNER;
  if (!runner) {
    try {
      const installed = execFileSync("webcrack", ["--version"], { encoding: "utf8", timeout: 10000 }).trim();
      if (installed === WEBCRACK_VERSION) runner = "webcrack";
    } catch { /* Use the pinned npm fallback when no global executable works. */ }
    runner ||= "npx";
  }
  if (runner === "webcrack") {
    const installed = execFileSync(runner, ["--version"], { encoding: "utf8", timeout: 10000 }).trim();
    if (installed !== WEBCRACK_VERSION) throw new Error(`webcrack ${WEBCRACK_VERSION} required; found ${installed}`);
  }
  const runnerArgs = runner === "webcrack" ? [] : [ ...(runner === "npx" ? ["--yes"] : []), `webcrack@${WEBCRACK_VERSION}` ];
  runnerArgs.push(input, "-o", outputDir, "--force");
  if (!process.env.WEBCRACK_JSX) runnerArgs.push("--no-jsx");
  const env = { ...process.env };
  if (!env.NODE_OPTIONS?.includes("--max-old-space-size")) {
    env.NODE_OPTIONS = `${env.NODE_OPTIONS || ""} --max-old-space-size=12288`.trim();
  }
  console.log(`Deobfuscating with webcrack ${WEBCRACK_VERSION}: ${input}`);
  execFileSync(runner, runnerArgs, { stdio: "inherit", timeout: 3600000, env });

  // RATIONALE: no heuristic repairs — untouched webcrack 2.15.1 output for
  // macOS 2.1.181 passes syntax validation with and without --no-jsx. The old
  // unconditional backtick passes corrupted that valid output. A future
  // failure needs a producer-level reproduction, not caret-driven edits.
  const error = syntaxCheckModern(output);
  if (error !== null) throw new Error(`webcrack output is invalid; left untouched for local diagnosis:\n${error}`);
  console.log(`DEOBFUSCATED:${output}`);
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}

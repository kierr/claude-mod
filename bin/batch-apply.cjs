#!/usr/bin/env node
/**
 * Run the shared engine in a child process to isolate Babel heap usage.
 * Exit 0 on success, 1 on failure, or 2 when no patch applies.
 */

const path = require("path");
const { applyPatches } = require("../lib/engine.cjs");

// Default per-patch timeout in seconds (0 = no limit)
const DEFAULT_TIMEOUT = 60;

function main() {
  const args = process.argv.slice(2);
  let filePath = null;
  let patchNames = [];
  let verbose = false;
  let timeout = DEFAULT_TIMEOUT;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (arg === "--timeout" && i + 1 < args.length) {
      timeout = parseInt(args[++i], 10) || DEFAULT_TIMEOUT;
    } else if (arg.startsWith("--timeout=")) {
      timeout = parseInt(arg.slice("--timeout=".length), 10) || DEFAULT_TIMEOUT;
    } else if (!arg.startsWith("-")) {
      if (!filePath) {
        filePath = path.resolve(arg);
      } else {
        patchNames.push(arg);
      }
    }
  }

  if (!filePath || patchNames.length === 0) {
    console.error("Usage: batch-apply.cjs <deobfuscated.js> <patch1> [patch2] ... [--verbose] [--timeout <sec>]");
    process.exit(1);
  }

  if (!require("fs").existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  const startTime = Date.now();

  const result = applyPatches({
    filePath,
    patchNames,
    verbose,
    timeout,
  });

  const totalMs = Date.now() - startTime;

  // Print per-patch status (replicate original output format)
  for (const [id, detail] of Object.entries(result.patches)) {
    if (detail.skip === "already_applied") {
      if (verbose) console.log(`  ◌ ${id}  already applied`);
    } else if (detail.skip === "not_applicable") {
      if (verbose) console.log(`  ◌ ${id}  not applicable`);
    } else if (detail.status === "error") {
      const ms = detail.elapsedMs != null ? ` (${(detail.elapsedMs / 1000).toFixed(1)}s)` : "";
      console.error(`  ✗ ${id}  codemod failed${ms}: ${detail.error.message}`);
    } else if (detail.status === "verification_failed") {
      const ms = detail.elapsedMs != null ? ` (${(detail.elapsedMs / 1000).toFixed(1)}s)` : "";
      console.error(`  ✗ ${id}  verification failed${ms}`);
    } else if (detail.status === "timeout") {
      console.error(`  ⏱ ${id}  TIMEOUT after ${(detail.elapsedMs / 1000).toFixed(1)}s (skipped)`);
    } else if (detail.status === "applied") {
      const count = detail.matches || 0;
      const ms = detail.elapsedMs != null ? ` (${(detail.elapsedMs / 1000).toFixed(1)}s)` : "";
      console.log(`  ✓ ${id}  (${count} matches)${ms}`);
    }
  }

  // Summary line with total time
  const totalSec = (totalMs / 1000).toFixed(1);
  if (result.applied > 0 || result.failed > 0 || result.skipped > 0) {
    const parts = [`applied: ${result.applied}`, `failed: ${result.failed}`, `skipped: ${result.skipped}`];
    if (!verbose) console.log(`  ── ${parts.join(", ")} ── ${totalSec}s total`);
  }

  // Exit codes: 0 = success, 1 = failure, 2 = no-op
  const totalActive = result.applied + result.failed;
  if (totalActive === 0) {
    process.exit(2);
  }
  process.exit(result.failed > 0 ? 1 : 0);
}

if (require.main === module) {
  main();
}

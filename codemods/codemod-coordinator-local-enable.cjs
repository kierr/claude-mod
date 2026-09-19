#!/usr/bin/env node
// Bypass only the local-interactive coordinator restriction.
// Setting remote-session identity instead would also change authentication behavior.

const fs = require("fs");
const path = require("path");

const MOD_ID = "coordinator_local_enable";

/**
 * Wrap the guard so the mod returns `false` (do-not-block) when enabled.
 * Parenthesized so it drops cleanly into the `if (...)` test position.
 */
function wrapFalse(match) {
  return `(typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}") ? false : ${match})`;
}

const MOD_GUARD_RE = new RegExp(
  `__isModEnabled__\\s*\\(\\s*["']${MOD_ID}["']\\s*\\)`
);
const TERNARY_ELSE_RE = /\?\s*(?:true|false)\s*:\s*/;

/**
 * Idempotency: skip a match that already sits inside a previously-wrapped ternary.
 * The wrapped form places `__isModEnabled__("coordinator_local_enable") ? false :`
 * immediately before the guard on the same line, so a bounded same-line lookback
 * detects prior wrapping and prevents double-wrapping on re-runs.
 */
function isInsideModTernary(code, matchIndex) {
  const lineStart = code.lastIndexOf("\n", matchIndex - 1) + 1;
  const windowStart = Math.max(lineStart, matchIndex - 400);
  const window = code.substring(windowStart, matchIndex);
  return MOD_GUARD_RE.test(window) && TERNARY_ELSE_RE.test(window);
}

/**
 * The coordinator rx() second guard: fn() && !fn() && !fn(process.env.CLAUDE_CODE_REMOTE).
 * Matches Gx() && !ya() && !rt(process.env.CLAUDE_CODE_REMOTE) with any minified names.
 * Also matches code-split variant: fn() && !fn() && !fn(a.CLAUDE_CODE_REMOTE)
 * where `a` is an imported module with env-like properties.
 */
const GUARD_RE =
  /[\w$]+\(\)\s*&&\s*![\w$]+\(\)\s*&&\s*![\w$]+\(\s*(?:process\.env|\w+)\.CLAUDE_CODE_REMOTE\s*\)/g;

function transform(code) {
  let changed = 0;

  code = code.replace(GUARD_RE, (m, offset) => {
    if (isInsideModTernary(code, offset)) return m;
    changed += 1;
    return wrapFalse(m);
  });

  return { code, changed };
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-coordinator-local-enable.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const { code: output, changed: changedCount } = transform(code);

  if (changedCount === 0) {
    // Idempotency: already wrapped — safe skip
    if (MOD_GUARD_RE.test(code)) {
      console.error("Coordinator local-enable guard already wrapped; skipping.");
    } else {
      throw new Error("No matching coordinator-mode guard found; bundle may have drifted.");
    }
  } else {
    console.error(`Wrapped ${changedCount} coordinator-mode guard(s) with __isModEnabled__ ternary.`);
  }

  if (outputFile) {
    fs.writeFileSync(path.resolve(outputFile), output, "utf8");
  } else {
    process.stdout.write(output);
  }
}

module.exports = { transform };

if (require.main === module) {
  main();
}

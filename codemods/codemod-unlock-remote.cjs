#!/usr/bin/env node
// Local feature-gate overrides do not replace remote-session authentication.
// Leave OAuth, access-token, and separate bridge-control checks unchanged.

const fs = require("fs");
const path = require("path");

const MOD_ID = "unlock_remote";

/**
 * Wrap an expression so the mod returns `true` when enabled, falls through otherwise.
 */
function wrapTrue(match) {
  return `(typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}") ? true : ${match})`;
}

/**
 * Wrap an expression so the mod returns `false` when enabled (for isHidden / negative checks).
 */
function wrapFalse(match) {
  return `(typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}") ? false : ${match})`;
}

/**
 * Idempotency check: skip matches that are already inside a mod ternary.
 * Without this, Pass 3 would re-match substrings inside Pass 2b's output
 * (e.g., !_Y("allow_remote_sessions") inside the else-branch of a ternary),
 * producing nested ternaries with broken semantics.
 *
 * Checks the window before the match (bounded by newlines to avoid cross-line
 * false positives from adjacent wrapped expressions) for both:
 *   1. __isModEnabled__("unlock_remote") — the mod guard
 *   2. "? true : " or "? false : " — the ternary else-branch marker
 * If both are present, the match is inside a previously-wrapped ternary.
 */
const MOD_GUARD_RE = new RegExp(
  `__isModEnabled__\\s*\\(\\s*["']${MOD_ID}["']\\s*\\)`
);
const TERNARY_ELSE_RE = /\?\s*(?:true|false)\s*:\s*/;
const MOD_TERNARY_LOOKBACK = Math.max(wrapTrue("").length, wrapFalse("").length);

function isInsideModTernary(code, matchIndex) {
  // Bound the lookback to the current line to avoid false positives from
  // adjacent wrapped expressions on previous lines.
  const lineStart = code.lastIndexOf("\n", matchIndex - 1) + 1;
  const windowStart = Math.max(lineStart, matchIndex - MOD_TERNARY_LOOKBACK);
  const window = code.substring(windowStart, matchIndex);
  return MOD_GUARD_RE.test(window) && TERNARY_ELSE_RE.test(window);
}

/**
 * Regex-based transform with sequential passes ordered most-specific to least-specific
 * to prevent double-wrapping.
 */
function transform(code) {
  let changed = 0;

  // All passes use idempotency guards to prevent double-wrapping when the
  // codemod is run on already-patched code. Without this, Pass 3's broad
  // pattern would re-match substrings inside Pass 2b's ternary else-branch.

  // Pass 1: CCR compound — tengu_surreal_dali GrowthBook flag + allow_remote_sessions policy
  // Matches: S8("tengu_surreal_dali", false) && _Y("allow_remote_sessions")
  // 2 sites: RemoteTrigger isEnabled, Schedule isEnabled
  code = code.replace(
    /[\w$]+\("tengu_surreal_dali",\s*false\)\s*&&\s*[\w$]+\("allow_remote_sessions"\)/g,
    (m, offset) => {
      if (isInsideModTernary(code, offset)) return m;
      changed += 1;
      return wrapTrue(m);
    }
  );

  // Pass 2a: Teleport/Remote-env isEnabled — g7() && _Y("allow_remote_sessions")
  // 2 sites: Teleport isEnabled, Remote-env isEnabled
  // Requires preceding "isEnabled" context to avoid false-positives on unrelated
  // zero-arg function calls ANDed with policy checks.
  code = code.replace(
    /isEnabled[^;]*[\w$]+\(\)\s*&&\s*[\w$]+\("allow_remote_sessions"\)/g,
    (m, offset) => {
      if (isInsideModTernary(code, offset)) return m;
      // Extract just the expression part (after isEnabled context)
      const exprMatch = m.match(/([\w$]+\(\)\s*&&\s*[\w$]+\("allow_remote_sessions"\))/);
      if (!exprMatch) return m;
      changed += 1;
      return m.replace(exprMatch[1], wrapTrue(exprMatch[1]));
    }
  );

  // Pass 2b: Teleport/Remote-env isHidden — !g7() || !_Y("allow_remote_sessions")
  // 2 sites: Teleport isHidden, Remote-env isHidden
  // Requires preceding "isHidden" context to avoid false-positives on unrelated
  // negated compound expressions with policy checks.
  code = code.replace(
    /isHidden[^;]*(![\w$]+\(\)\s*\|\|\s*![\w$]+\("allow_remote_sessions"\))/g,
    (m, captured, offset) => {
      if (isInsideModTernary(code, offset)) return m;
      changed += 1;
      return m.replace(captured, wrapFalse(captured));
    }
  );

  // Pass 3: Standalone policy blocks — !_Y("allow_remote_sessions")
  // 4 sites: CCR init, Teleport resume, session resume, --remote CLI flag
  // Excludes Quick Web Setup context by skipping matches whose compound
  // context contains "allow_quick_web_setup" (checked via lookahead/lookbehind).
  code = code.replace(
    /![\w$]+\("allow_remote_sessions"\)/g,
    (m, offset) => {
      if (isInsideModTernary(code, offset)) return m;
      // Skip Quick Web Setup context: if "allow_quick_web_setup" appears within
      // the same compound expression (200-char window), this is QWS, not CCR/Teleport.
      const ctxStart = Math.max(0, offset - 200);
      const ctxEnd = Math.min(code.length, offset + m.length + 200);
      const context = code.substring(ctxStart, ctxEnd);
      if (context.includes("allow_quick_web_setup")) return m;
      changed += 1;
      return wrapFalse(m);
    }
  );

  return { code, changed };
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-unlock-remote.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const { code: output, changed: changedCount } = transform(code);

  if (changedCount === 0) {
    throw new Error("No matching gate expressions found; nothing changed.");
  }
  console.error(`Wrapped ${changedCount} gate expression(s) with __isModEnabled__ ternary.`);

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

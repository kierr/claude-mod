#!/usr/bin/env node
// Apply after unlock_workflows: model capability and workflow availability are independent gates.

const fs = require("fs");
const path = require("path");

/**
 * Patch VcH() — the xhigh model capability check.
 *
 * Original shape:
 *   function VcH(H) {
 *     let _ = Hr(H, "xhigh_effort");
 *     if (_ !== undefined) { return _; }
 *     let q = A7(H);
 *     if (q.includes("claude-3-") || ... || q === "claude-haiku-4-5") { return false; }
 *     if (q === "claude-opus-4-8" || q === "claude-opus-4-7") { return true; }
 *     return eS(eJ(H));
 *   }
 *
 * We inject a guard at the top of the function body that returns true when the mod is enabled.
 */
function patchXhighCapabilityCheck(code) {
  // Match the xhigh_effort capability check function.
  // Monolithic: function NAME(H) { let _ = HR(H, "xhigh_effort");
  // Code-split:  function NAME(e) { if (y7t(e)) { return false; } let n = dce(e, "xhigh_effort");
  //
  // Try strict pattern first (no intervening code), then flexible
  // (allows guarded returns before the xhigh_effort check).
  // The flexible pattern must NOT cross into a nested function — limit
  // to at most 200 chars between opening brace and the let statement.

  const strictPattern = /function\s+([\w$]+)\s*\(\s*([\w$]+)\s*\)\s*\{\s*let\s+([\w$]+)\s*=\s*([\w$]+)\s*\(\s*\2\s*,\s*["']xhigh_effort["']\s*\)\s*;/;
  const flexPattern = /function\s+([\w$]+)\s*\(\s*([\w$]+)\s*\)\s*\{[\s\S]{1,200}?let\s+([\w$]+)\s*=\s*([\w$]+)\s*\(\s*\2\s*,\s*["']xhigh_effort["']\s*\)\s*;/;

  let match = code.match(strictPattern);
  if (!match) {
    match = code.match(flexPattern);
  }

  if (!match) {
    return { code, changed: 0 };
  }

  const funcName = match[1];
  const param = match[2];
  const funcStart = match.index;

  // Find the opening brace of the function body
  const bodyStart = code.indexOf("{", funcStart);

  // Verify this is the right function by checking for claude model references nearby
  const contextWindow = code.substring(funcStart, Math.min(code.length, funcStart + 800));
  const hasModelRefs = contextWindow.includes("claude-opus-4-8") ||
    contextWindow.includes("claude-opus-4-7") ||
    contextWindow.includes("claude-mythos");
  const hasHaikuRef = contextWindow.includes("claude-haiku-4-5");
  if (!hasModelRefs && !hasHaikuRef) {
    return { code, changed: 0 };
  }

  const guard =
    'if (typeof __isModEnabled__ === "function" && __isModEnabled__("unlock_ultracode")) {' +
    '  return true;' +
    '}';

  code = code.substring(0, bodyStart + 1) + guard + code.substring(bodyStart + 1);
  return { code, changed: 1 };
}

/**
 * Also patch the companion function that appears right before VcH — it checks
 * for "max_effort" capability and has the same model list pattern. This is the
 * function used by `vx()` to determine if ultracode shows at all.
 * Shape: function NAME(H) { let _ = Hr(H, "max_effort"); ... model list ... }
 */
function patchMaxEffortCheck(code) {
  // Idempotency: if already patched, skip
  if (code.includes('__isModEnabled__("unlock_ultracode")')) {
    const guardCount = (code.match(/__isModEnabled__\("unlock_ultracode"\)/g) || []).length;
    if (guardCount >= 2) {
      return { code, changed: 0 };
    }
  }

  // Find the max_effort function — try strict first, then flexible.
  const strictPattern = /function\s+([\w$]+)\s*\(\s*([\w$]+)\s*\)\s*\{\s*let\s+([\w$]+)\s*=\s*([\w$]+)\s*\(\s*\2\s*,\s*["']max_effort["']\s*\)\s*;/;
  const flexPattern = /function\s+([\w$]+)\s*\(\s*([\w$]+)\s*\)\s*\{[\s\S]{1,200}?let\s+([\w$]+)\s*=\s*([\w$]+)\s*\(\s*\2\s*,\s*["']max_effort["']\s*\)\s*;/;

  let match = code.match(strictPattern);
  if (!match) {
    match = code.match(flexPattern);
  }

  if (!match) {
    return { code, changed: 0 };
  }

  const funcStart = match.index;

  // Verify by checking for claude model references
  const contextWindow = code.substring(funcStart, Math.min(code.length, funcStart + 800));
  const hasModelRefs = contextWindow.includes("claude-opus-4-8") ||
    contextWindow.includes("claude-opus-4-7") ||
    contextWindow.includes("claude-mythos");
  const hasSonnetRef = contextWindow.includes("claude-sonnet-4-6") || contextWindow.includes("claude-sonnet-4-5");
  if (!hasModelRefs && !hasSonnetRef) {
    return { code, changed: 0 };
  }

  const bodyStart = code.indexOf("{", funcStart);
  const guard =
    'if (typeof __isModEnabled__ === "function" && __isModEnabled__("unlock_ultracode")) {' +
    '  return true;' +
    '}';

  code = code.substring(0, bodyStart + 1) + guard + code.substring(bodyStart + 1);
  return { code, changed: 1 };
}

function transform(code) {
  let totalChanged = 0;

  // Idempotency check — both guards must be present
  const guardCount = (code.match(/__isModEnabled__\("unlock_ultracode"\)/g) || []).length;
  if (guardCount >= 2) {
    return { code, changed: 0 };
  }

  const r1 = patchXhighCapabilityCheck(code);
  code = r1.code;
  totalChanged += r1.changed;

  const r2 = patchMaxEffortCheck(code);
  code = r2.code;
  totalChanged += r2.changed;

  // Partial application: in code-split, xhigh and max may be in different chunks.
  // Return changed:0 (not an error) when nothing matched — other chunks may differ.
  return { code, changed: totalChanged };
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-unlock-ultracode.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const { code: output, changed } = transform(code);
  console.error(`Patched ${changed} ultracode model capability checks.`);

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

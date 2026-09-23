#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { findMatchingBrace } = require("../lib/utils.cjs");

/**
 * Patch q67() — the allow_workflows policy gate.
 * Original: return V7("allow_workflows");
 * Patched:  return typeof __isModEnabled__ === "function" && __isModEnabled__("unlock_workflows") ? true : V7("allow_workflows");
 */
function patchAllowWorkflowsGate(code) {
  // Match: function NAME() { return V7("allow_workflows"); }
  const pattern = /function\s+([\w$]+)\s*\(\)\s*\{\s*return\s+([\w$]+)\(\s*["']allow_workflows["']\s*\)\s*;\s*\}/;
  const match = code.match(pattern);

  if (!match) {
    return { code, changed: 0 };
  }

  const funcName = match[1];
  const v7Name = match[2];

  const replacement =
    `function ${funcName}() {` +
    `  return typeof __isModEnabled__ === "function" && __isModEnabled__("unlock_workflows") ? true : ${v7Name}("allow_workflows");` +
    `}`;

  code = code.replace(match[0], () => replacement);
  return { code, changed: 1 };
}

/**
 * Add a guarded availability override before the resolver checks feature flags and plan.
 */
function patchWorkflowAvailability(code) {
  // Strategy: find function containing "tengu_workflows_enabled" that returns
  // { available: ..., defaultOn: ... } — the availability resolver.
  // Works with both process.env.CLAUDE_CODE_WORKFLOWS (monolithic) and
  // cached-env.CLAUDE_CODE_WORKFLOWS (code-split) patterns.

  // Pattern A (monolithic): function NAME() { if (NAME2(process.env.CLAUDE_CODE_WORKFLOWS)) {
  const funcPatternA = /function\s+([\w$]+)\s*\(\)\s*\{\s*if\s*\(\s*([\w$]+)\s*\(\s*process\.env\.CLAUDE_CODE_WORKFLOWS\s*\)\s*\)\s*\{\s*let\s+([\w$]+)\s*=\s*([\w$]+)\s*\(\s*["']tengu_workflows_enabled["']\s*,\s*true\s*\)/;
  // Pattern B (code-split): function NAME() { if (NAME.CLAUDE_CODE_WORKFLOWS === true) {
  const funcPatternB = /function\s+([\w$]+)\s*\(\)\s*\{[\s\S]*?CLAUDE_CODE_WORKFLOWS[^}]*?tengu_workflows_enabled[\s\S]*?available\s*:/;

  let match = code.match(funcPatternA);
  let matchType = "A";
  if (!match) {
    // Try pattern B: find a function that contains both CLAUDE_CODE_WORKFLOWS and
    // tengu_workflows_enabled and returns { available: ... }
    // We need a different strategy — search for the function boundary manually
    match = code.match(funcPatternB);
    matchType = "B";
  }

  if (!match) {
    return { code, changed: 0 };
  }

  if (matchType === "A") {
    // Original monolithic pattern — brace-count to find function body
    const funcStart = match.index;
    const openBracePos = code.indexOf("{", funcStart);
    if (openBracePos === -1) return { code, changed: 0 };
    const closeBracePos = findMatchingBrace(code, openBracePos, "{", "}");
    if (closeBracePos === -1) return { code, changed: 0 };

    const guard =
      'if (typeof __isModEnabled__ === "function" && __isModEnabled__("unlock_workflows")) {' +
      '  return { available: true, defaultOn: true };' +
      '}';

    const insertPos = openBracePos + 1;
    code = code.substring(0, insertPos) + guard + code.substring(insertPos);
    return { code, changed: 1 };
  }

  // Pattern B (code-split): find the function that is the availability resolver.
  // It contains CLAUDE_CODE_WORKFLOWS and returns { available: ..., defaultOn: ... }.
  // Find each function definition and check if it matches.
  const funcDeclPattern = /function\s+([\w$]+)\s*\(\)\s*\{/g;
  let funcMatch;
  while ((funcMatch = funcDeclPattern.exec(code)) !== null) {
    const funcName = funcMatch[1];
    const openBracePos = funcMatch.index + funcMatch[0].length - 1;
    const closeBracePos = findMatchingBrace(code, openBracePos, "{", "}");
    if (closeBracePos === -1) continue;

    const funcBody = code.substring(funcMatch.index, closeBracePos + 1);
    if (funcBody.includes("CLAUDE_CODE_WORKFLOWS") &&
        funcBody.includes("tengu_workflows_enabled") &&
        funcBody.includes("available:") &&
        funcBody.includes("defaultOn:")) {
      const guard =
        'if (typeof __isModEnabled__ === "function" && __isModEnabled__("unlock_workflows")) {' +
        '  return { available: true, defaultOn: true };' +
        '}';

      const insertPos = openBracePos + 1;
      code = code.substring(0, insertPos) + guard + code.substring(insertPos);
      return { code, changed: 1 };
    }
  }

  return { code, changed: 0 };
}

function transform(code) {
  let totalChanged = 0;

  // Idempotency check
  if (code.includes('__isModEnabled__("unlock_workflows")')) {
    return { code, changed: 0 };
  }

  const r1 = patchAllowWorkflowsGate(code);
  code = r1.code;
  totalChanged += r1.changed;

  const r2 = patchWorkflowAvailability(code);
  code = r2.code;
  totalChanged += r2.changed;

  // Partial application: in code-split binaries, gate and resolver may be in
  // different chunks. Each chunk applies independently, so one may match while
  // the other doesn't. Return changed:0 (not an error) when nothing matched
  // in this chunk — other chunks may have different content.
  return { code, changed: totalChanged };
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-unlock-workflows.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const { code: output, changed } = transform(code);
  console.error(`Patched ${changed} workflow gating sites.`);

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

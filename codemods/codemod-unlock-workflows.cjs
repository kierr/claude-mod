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
  // Match the FX5 function by finding the unique "tengu_workflows_enabled" + "defaultOn: OK() !== "pro"" pattern
  // Strategy: find function containing both "tengu_workflows_enabled" and the pro plan check
  const funcPattern = /function\s+([\w$]+)\s*\(\)\s*\{\s*if\s*\(\s*([\w$]+)\s*\(\s*process\.env\.CLAUDE_CODE_WORKFLOWS\s*\)\s*\)\s*\{\s*let\s+([\w$]+)\s*=\s*([\w$]+)\s*\(\s*["']tengu_workflows_enabled["']\s*,\s*true\s*\)/;
  const match = code.match(funcPattern);

  if (!match) {
    return { code, changed: 0 };
  }

  const funcName = match[1];
  const funcStart = match.index;

  // Find the function body by brace counting (string-aware)
  const openBracePos = code.indexOf("{", funcStart);
  if (openBracePos === -1) {
    return { code, changed: 0 };
  }
  const closeBracePos = findMatchingBrace(code, openBracePos, "{", "}");
  if (closeBracePos === -1) {
    return { code, changed: 0 };
  }
  const funcBodyStart = openBracePos;
  const funcBodyEnd = closeBracePos + 1;

  // Verify this is the right function by checking for the pro plan check
  const funcBody = code.substring(funcStart, funcBodyEnd);
  if (!funcBody.includes("tengu_workflows_enabled") || !funcBody.includes('"pro"')) {
    return { code, changed: 0 };
  }

  // Insert the mod guard right after the opening brace of the function body
  const guard =
    'if (typeof __isModEnabled__ === "function" && __isModEnabled__("unlock_workflows")) {' +
    '  return { available: true, defaultOn: true };' +
    '}';

  const insertPos = funcBodyStart + 1;
  code = code.substring(0, insertPos) + guard + code.substring(insertPos);

  return { code, changed: 1 };
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

  if (r1.changed === 0) {
    throw new Error("unlock_workflows: could not find allow_workflows gate function");
  }

  const r2 = patchWorkflowAvailability(code);
  code = r2.code;
  totalChanged += r2.changed;

  if (r2.changed === 0) {
    throw new Error("unlock_workflows: could not find FX5() workflow availability resolver");
  }

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

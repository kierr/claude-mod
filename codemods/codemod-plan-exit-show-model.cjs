#!/usr/bin/env node
// Call the model hook unconditionally to preserve React hook order; guard only the displayed suffix.

const fs = require("fs");
const path = require("path");

const MOD_ID = "display_model_name";
const MODEL_VAR = "__planModelDisplay__";
const TARGET_TITLES = ["Ready to code?", "Exit plan mode?"];

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find the model display hook function: the function that accesses both
 * .mainLoopModel and .mainLoopModelForSession via store accessor arrow functions.
 *
 * Pattern: function NAME() { let X = CALL(Y => Y.mainLoopModel); let Z = CALL(Y => Y.mainLoopModelForSession); }
 */
function findModelHook(code) {
  // Find .mainLoopModelForSession (more specific) first
  const sessionIdx = code.indexOf(".mainLoopModelForSession");
  if (sessionIdx === -1) return null;

  // Find the enclosing function
  let funcBraceStart = -1;
  let depth = 0;
  for (let i = sessionIdx; i >= 0; i--) {
    if (code[i] === '}') depth++;
    if (code[i] === '{') { if (depth === 0) { funcBraceStart = i; break; } depth--; }
  }
  if (funcBraceStart === -1) return null;

  let funcBraceEnd = -1;
  depth = 1;
  for (let i = funcBraceStart + 1; i < code.length; i++) {
    if (code[i] === '{') depth++;
    if (code[i] === '}') { depth--; if (depth === 0) { funcBraceEnd = i; break; } }
  }
  if (funcBraceEnd === -1) return null;

  const funcBlock = code.substring(funcBraceStart, funcBraceEnd + 1);

  // Verify it also contains .mainLoopModel
  if (!funcBlock.includes(".mainLoopModel")) return null;

  // Extract the function name
  const before = code.substring(Math.max(0, funcBraceStart - 200), funcBraceStart);
  const fnMatch = before.match(/function\s+([\w$]+)\s*\(\s*\)\s*$/);
  if (!fnMatch) return null;

  return fnMatch[1];
}

/**
 * Transform: discover model hook, find title props, inject hook call,
 * and replace string literals with mod-guarded concatenation.
 */
function transform(code) {
  if (typeof code !== "string") return { code: "", changed: 0 };

  // Idempotency: already patched
  if (code.includes(MODEL_VAR)) {
    return { code, changed: 0 };
  }

  // Step 1: Discover the model display hook identifier
  const hookName = findModelHook(code);
  if (!hookName) {
    // Graceful skip: the hook pattern may have drifted or been modified
    // by an earlier sub-codemod in the display_model_name chain
    return { code, changed: 0 };
  }

  const modGuard = `typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}")`;

  let count = 0;

  // Step 2: Find and modify title props
  for (const title of TARGET_TITLES) {
    const escapedTitle = escapeRegex(title);

    // Pattern: title: "Ready to code?" or title: 'Ready to code?'
    const titlePattern = new RegExp(`(title:\\s*)"${escapedTitle}"`, "g");

    code = code.replace(titlePattern, (match, prefix) => {
      // Find the enclosing function to inject the hook call
      // We'll do this in a separate pass (see below)
      count++;
      const replacement = `${prefix}"${title}" + (${modGuard} ? " (" + ${MODEL_VAR} + ")" : "")`;
      return replacement;
    });
  }

  if (count === 0) return { code, changed: 0 };

  // Step 3: Inject the hook call into each function containing a patched title
  // Collect all injection points first, then apply in reverse order
  const patchedPattern2 = new RegExp(escapeRegex(MODEL_VAR), "g");
  const injectionPoints = [];

  while ((patchedMatch = patchedPattern2.exec(code)) !== null) {
    // Walk up from this position to find the function-level opening brace
    let funcBraceStart = -1;
    let scanPos = patchedMatch.index;
    while (scanPos > 0) {
      let innerBrace = -1;
      let depth = 0;
      for (let i = scanPos; i >= 0; i--) {
        if (code[i] === '}') depth++;
        if (code[i] === '{') { if (depth === 0) { innerBrace = i; break; } depth--; }
      }
      if (innerBrace === -1) break;

      // Check if this brace belongs to a function
      const before = code.substring(Math.max(0, innerBrace - 200), innerBrace);
      if (/function\s+[\w$]*\s*\([^)]*\)\s*$/.test(before) || /=>\s*$/.test(before)) {
        funcBraceStart = innerBrace;
        break;
      }
      // Not a function brace — move past it and keep looking outward
      scanPos = innerBrace - 1;
    }
    if (funcBraceStart === -1) continue;
    if (!injectionPoints.some(p => p === funcBraceStart)) {
      injectionPoints.push(funcBraceStart);
    }
  }

  // Apply in reverse order to maintain offsets
  injectionPoints.sort((a, b) => b - a);
  for (const pos of injectionPoints) {
    const hookDecl = `\nlet ${MODEL_VAR} = ${hookName}();`;
    code = code.substring(0, pos + 1) + hookDecl + code.substring(pos + 1);
  }

  return { code, changed: count, hookName };
}

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-plan-exit-show-model.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  if (!fs.existsSync(inputPath)) {
    console.error(`Error: Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const code = fs.readFileSync(inputPath, "utf8");

  let result;
  try {
    result = transform(code);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  if (result.changed === 0) {
    console.error("No matching plan exit title props found; nothing changed.");
  } else {
    console.error(`Replaced ${result.changed} plan exit title(s), using model hook "${result.hookName}".`);
  }

  if (outputFile) {
    fs.writeFileSync(path.resolve(outputFile), result.code, "utf8");
  } else {
    process.stdout.write(result.code);
  }
}

module.exports = { transform };

if (require.main === module) {
  main();
}

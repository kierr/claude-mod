#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const MOD_ID = "display_model_name";

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find the display-model-name function and wrap the model display logic.
 *
 * The function has this structure:
 *   function FN(PARAM) {
 *     let ARR = [];
 *     if (PARAM.model) {                    // ← wrap with __isModEnabled__
 *       let A = GETTER();                   // session model getter
 *       let B = CONVERTER(PARAM.model);     // ← make conditional fallback
 *       if (B !== A) { ARR.push(...); }     // ← wrap with __isModEnabled__
 *     }
 *     if (ARR.length === 0) { return null; }
 *   }
 *
 * Three transformations:
 * 1. Outer if: PARAM.model → (PARAM.model || __isModEnabled__(...))
 * 2. Converter call: CONVERTER(PARAM.model) → (PARAM.model ? CONVERTER(PARAM.model) : A)
 * 3. Inner if: B !== A → (__isModEnabled__(...) || B !== A)
 */
function transform(code) {
  if (typeof code !== "string") return { code: "", changed: 0 };

  // Idempotency: if already patched (our mod-guard pattern is present)
  if (code.includes(`__isModEnabled__("${MOD_ID}")`) &&
      /PARAM\.model\s*\|\|/.test(code) === false &&
      code.includes("display_model_name")) {
    // More precise check: if both the outer OR and inner OR patterns are present
    if (/\.model\s*\|\|\s*\(typeof\s+__isModEnabled__/.test(code)) {
      return { code, changed: 0 };
    }
  }

  const modGuard = `typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}")`;

  // Step 1: Find the function containing the pattern
  // Anchor: a function with let ARR = []; if (PARAM.model) { ... }
  // where the if-body has .push( and .length === 0 and return null

  // Find: if (PARAM.model && ...) or if (PARAM.model)
  // followed by: .length === 0 ... return null
  const ifModelPattern = /if\s*\(\s*([\w$]+)\.model\s*(?:&&|\)\s*\{)/g;

  let match;
  let found = null;

  while ((match = ifModelPattern.exec(code)) !== null) {
    const paramName = match[1];
    const ifStart = match.index;

    // Find the enclosing function
    let funcBraceStart = -1;
    let depth = 0;
    for (let i = ifStart; i >= 0; i--) {
      if (code[i] === '}') depth++;
      if (code[i] === '{') { if (depth === 0) { funcBraceStart = i; break; } depth--; }
    }
    if (funcBraceStart === -1) continue;

    // Find matching closing brace
    let funcBraceEnd = -1;
    depth = 1;
    for (let i = funcBraceStart + 1; i < code.length; i++) {
      if (code[i] === '{') depth++;
      if (code[i] === '}') { depth--; if (depth === 0) { funcBraceEnd = i; break; } }
    }
    if (funcBraceEnd === -1) continue;

    const funcBlock = code.substring(funcBraceStart, funcBraceEnd + 1);

    // Verify: contains .length === 0 and return null
    if (!funcBlock.includes(".length === 0")) continue;
    if (!funcBlock.includes("return null")) continue;

    // Verify: contains .push( after the if (param.model)
    const ifBody = code.substring(ifStart, ifStart + 500);
    if (!ifBody.includes(".push(")) continue;

    // Verify: contains !== comparison before .push( — the inner condition
    // must be a !== check, not === (wrong inner structure)
    if (!/[\w$]+\s*!==\s*[\w$]+/.test(funcBlock)) continue;

    found = { paramName, ifStart, funcBraceStart, funcBraceEnd };
    break;
  }

  if (!found) return { code, changed: 0 };

  const { paramName, ifStart: ifIdx } = found;

  // Step 2: Apply the three transformations

  // Transformation 1: Wrap outer if condition
  // if (PARAM.model) → if (PARAM.model || (typeof __isModEnabled__ === "function" && __isModEnabled__(...)))
  // Also handle: if (PARAM.model && ...) → if ((PARAM.model || __isModEnabled__(...)) && ...)
  const outerCondPattern = new RegExp(`if\\s*\\(\\s*${escapeRegex(paramName)}\\.model(\\s*&&|\\s*\\))`, "g");
  const outerMatch = outerCondPattern.exec(code);
  if (!outerMatch) return { code, changed: 0 };

  if (outerMatch[1].trim() === "&&") {
    // if (PARAM.model && ...) → if ((PARAM.model || __isModEnabled__) && ...)
    code = code.substring(0, outerMatch.index) +
      `if ((${paramName}.model || (${modGuard})) &&` +
      code.substring(outerMatch.index + outerMatch[0].length);
  } else {
    // if (PARAM.model) → if (PARAM.model || __isModEnabled__)
    code = code.substring(0, outerMatch.index) +
      `if (${paramName}.model || (${modGuard}))` +
      code.substring(outerMatch.index + outerMatch[0].length);
  }

  // Transformation 2: Find and modify the converter call
  // let B = CONVERTER(PARAM.model) → let B = (PARAM.model ? CONVERTER(PARAM.model) : A)
  // First find: let VAR = CALL(PARAM.model)
  const converterPattern = new RegExp(
    `let\\s+([\\w$]+)\\s*=\\s*([\\w$]+)\\(\\s*${escapeRegex(paramName)}\\.model\\s*\\)`,
    "g"
  );
  const converterMatch = converterPattern.exec(code);
  if (converterMatch) {
    const convertedVar = converterMatch[1];
    const converterFn = converterMatch[2];

    // Find the session model variable: let A = GETTER()
    // Look just before the converter declaration
    const beforeConverter = code.substring(Math.max(0, converterMatch.index - 200), converterMatch.index);
    const sessionVarMatch = beforeConverter.match(/let\s+([\w$]+)\s*=\s*([\w$]+)\(\s*\)\s*;?\s*$/);

    if (sessionVarMatch) {
      const sessionVar = sessionVarMatch[1];

      // Replace: let B = CONVERTER(PARAM.model) → let B = (PARAM.model ? CONVERTER(PARAM.model) : A)
      const oldDecl = converterMatch[0];
      const newDecl = `let ${convertedVar} = (${paramName}.model ? ${converterFn}(${paramName}.model) : ${sessionVar})`;
      code = code.replace(oldDecl, newDecl);
    }
  }

  // Transformation 3: Wrap inner if condition
  // if (B !== A) → if ((__isModEnabled__(...) || B !== A))
  const innerCondPattern = /if\s*\(\s*([\w$]+)\s*!==\s*([\w$]+)\s*\)\s*\{\s*[\w$]+\.push\(/g;
  const innerMatch = innerCondPattern.exec(code);
  if (innerMatch) {
    const oldCond = innerMatch[0];
    const newCond = oldCond.replace(
      /if\s*\(\s*([\w$]+)\s*!==\s*([\w$]+)\)/,
      `if ((${modGuard}) || $1 !== $2)`
    );
    code = code.replace(oldCond, newCond);
  }

  return { code, changed: 1 };
}

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-agent-model-always-show.cjs <input.js> [output.js]");
    console.error("If output.js is omitted, writes to stdout.");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  if (!fs.existsSync(inputPath)) {
    console.error(`Error: Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const code = fs.readFileSync(inputPath, "utf8");

  const { code: output, changed } = transform(code);

  if (changed === 0) {
    console.error("No matching agent model display function found; nothing changed.");
  } else {
    console.error("Wrapped 1 display-model-name function with __isModEnabled__ guard.");
  }

  if (outputFile) {
    const outputPath = path.resolve(outputFile);
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(outputPath, output, "utf8");
  } else {
    process.stdout.write(output);
  }
}

module.exports = { transform };

if (require.main === module) {
  main();
}

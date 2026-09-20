#!/usr/bin/env node

const MOD_ID = "add_multi_custom_models";

const fs = require("fs");
const path = require("path");
const { findMatchingBrace } = require("./scan-helpers.cjs");

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Two injection sites:
 *
 * 1. Picker: after the if-block that pushes a single custom model,
 *    insert a for-loop that pushes models 1–20.
 *    Anchor: "ANTHROPIC_CUSTOM_MODEL_OPTION" (env var name)
 *
 * 2. Validator: after the if-block that validates a single model,
 *    insert a for-loop that validates models 1–20.
 *    Anchor: same env var name
 */
function transform(code) {
  if (typeof code !== "string") return { code: "", changed: 0 };

  // Idempotency: if our for-loop is already present, skip
  if (code.includes("ANTHROPIC_CUSTOM_MODEL_OPTION_") && /for\s*\(\s*let\s+_i\s*=\s*1/.test(code)) {
    return { code, changed: 0 };
  }

  let count = 0;

  const modGuard = `typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}")`;

  // --- Picker transform ---
  // Monolithic: let VAR = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION;
  //   if (VAR && !ARR.some(CB => CB.value === VAR)) { ARR.push({ value: VAR, label: VAR, description: "Custom model (" + VAR + ")" }); }
  // Code-split: let VAR = a.ANTHROPIC_CUSTOM_MODEL_OPTION;
  //   if (VAR && !ARR.some(CB => CB.value === VAR)) { ARR.push({ value: VAR, label: a.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME ?? ... ?? VAR, ... }); }
  // The env accessor is either `process.env` or a module namespace like `a`
  const envAccessor = /(?:process\.env|[\w$]+)\.ANTHROPIC_CUSTOM_MODEL_OPTION/;
  const pickerPattern = new RegExp(
    `let\\s+([\\w$]+)\\s*=\\s*(${envAccessor.source})\\s*;\\s*if\\s*\\(\\s*([\\w$]+)\\s*&&\\s*!([\\w$]+)\\.some\\s*\\(\\s*([\\w$]+)\\s*=>\\s*([\\w$]+)\\.value\\s*===\\s*([\\w$]+)\\s*\\)\\s*\\)\\s*\\{`, 'g'
  );

  let pickerMatch;
  while ((pickerMatch = pickerPattern.exec(code)) !== null) {
    const envVar = pickerMatch[1];   // the let variable
    const envNs = pickerMatch[2];     // process.env or a
    const condVar = pickerMatch[3];   // should match envVar
    const pickerArr = pickerMatch[4]; // the array being checked

    // Verify the if-block body has the right push structure
    // Find the end of this if-block
    const ifStart = pickerMatch.index + pickerMatch[0].lastIndexOf("if");
    const braceStart = code.indexOf("{", ifStart);
    if (braceStart === -1) continue;

  // Find matching closing brace (string/comment-aware)
  const braceEnd = findMatchingBrace(code, braceStart);
  if (braceEnd === -1) continue;

    const ifBody = code.substring(braceStart + 1, braceEnd);

    // Verify the body contains: ARR.push({ value: ..., label: ..., description: ... })
    if (!ifBody.includes(`${pickerArr}.push`)) continue;
    if (!ifBody.includes("label:") || !ifBody.includes("description:")) continue;

    // Determine the env accessor for the for-loop injection.
    // Monolithic: process.env[KEY] — code-split: a[KEY]
    const isProcessEnv = envNs === "process.env";
    const envRead = isProcessEnv
      ? "process.env[_envKey]"
      : envNs.split(".")[0] + "[_envKey]"; // a[_envKey] for code-split
    const envReadName = isProcessEnv
      ? "process.env[_envKey + \"_NAME\"]"
      : envNs.split(".")[0] + "[_envKey + \"_NAME\"]";
    const envReadDesc = isProcessEnv
      ? "process.env[_envKey + \"_DESCRIPTION\"]"
      : envNs.split(".")[0] + "[_envKey + \"_DESCRIPTION\"]";

    // Build the picker for-loop
    const pickerLoop = `if (${modGuard}) { for (let _i = 1; _i <= 20; _i++) { let _envKey = "ANTHROPIC_CUSTOM_MODEL_OPTION_" + _i; let _modelId = ${envRead}; if (_modelId && !${pickerArr}.some(_A => _A.value === _modelId)) { ${pickerArr}.push({ value: _modelId, label: ${envReadName} ?? _modelId, description: ${envReadDesc} ?? "Custom model (" + _modelId + ")" }); } } }`;

    // Insert after the closing brace of the if-block
    code = code.substring(0, braceEnd + 1) + "\n" + pickerLoop + code.substring(braceEnd + 1);
    count++;

    // Reset regex since we mutated the string
    pickerPattern.lastIndex = 0;
    break; // Only process the first picker match
  }

  // --- Validator transform ---
  // Monolithic: if (VAR === process.env.ANTHROPIC_CUSTOM_MODEL_OPTION) { return { valid: true }; }
  // Code-split: let VAR = a.ANTHROPIC_CUSTOM_MODEL_OPTION; if (VAR !== undefined && FN(VAR) === e) { return true; }
  const validatorPattern = /if\s*\(\s*([\w$]+)\s*===\s*(?:process\.env|[\w$]+)\.ANTHROPIC_CUSTOM_MODEL_OPTION\s*\)\s*\{\s*return\s*\{\s*valid\s*:\s*true\s*\}\s*;\s*\}/g;

  let validatorMatch;
  while ((validatorMatch = validatorPattern.exec(code)) !== null) {
    const modelVar = validatorMatch[1];

    // Detect env accessor from context
    const validatorContext = code.slice(Math.max(0, validatorMatch.index - 500), validatorMatch.index);
    const codeSplitAccessor = validatorContext.match(/([\w$]+)\.ANTHROPIC_CUSTOM_MODEL_OPTION/);
    const isProcessEnv = !codeSplitAccessor || codeSplitAccessor[1] === 'process';
    const envRead = isProcessEnv ? 'process.env[_envKey]' : (codeSplitAccessor[1] + '[_envKey]');

    // Build the validator for-loop
    const validatorLoop = `if (${modGuard}) { for (let _i = 1; _i <= 20; _i++) { let _envKey = "ANTHROPIC_CUSTOM_MODEL_OPTION_" + _i; if (${modelVar} === ${envRead}) { return { valid: true }; } } }`;

    // Insert after the closing brace of the if-block
    const braceEnd = validatorMatch.index + validatorMatch[0].length - 1;
    // Find the closing brace
    const ifBody = validatorMatch[0];
    const closingBrace = ifBody.lastIndexOf("}");

    code = code.substring(0, validatorMatch.index + closingBrace + 1) + "\n" + validatorLoop + code.substring(validatorMatch.index + closingBrace + 1);
    count++;

    // Reset regex since we mutated the string
    validatorPattern.lastIndex = 0;
    break; // Only process the first validator match
  }

  if (count === 0) return { code, changed: 0 };

  return { code, changed: count };
}

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-add-multi-custom-models.cjs <input.js> [output.js]");
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
    console.error("No matching custom model option patterns found; nothing changed.");
  } else {
    console.error(`Patched ${changed} custom model option location(s).`);
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

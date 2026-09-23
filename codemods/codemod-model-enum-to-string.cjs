#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const MOD_ID = "unlock_agent_models";

/**
 * Check if an enum array string contains at least sonnet, opus, and haiku.
 */
function enumArrayHasTargetModels(arrayStr) {
  const values = arrayStr.match(/"([^"]+)"/g);
  if (!values) return false;
  const stripped = values.map(v => v.replace(/"/g, ""));
  const required = ["sonnet", "opus", "haiku"];
  return required.every(r => stripped.includes(r));
}

/**
 * Main transform: regex-based replacement.
 *
 * Matches patterns like:
 *   model: <ident>.enum(["sonnet", "opus", "haiku"])
 *   "model": <ident>.enum([ ... ])
 *
 * The enum array can span multiple lines and have flexible whitespace.
 * Only matches when the property name is "model" (or "model").
 */
function transform(code) {
  // Pattern breakdown:
  // 1. (^|[{,]\s*)              — key boundary: start-of-line or object literal context
  // 2. (model|"model")\s*:\s*   — property name "model" followed by colon
  // 3. (\w+)\.enum\(            — identifier.enum( (captures the identifier)
  // 4. (\[[\s\S]*?\])           — array literal (handles multiline)
  // 5. \)                       — closing paren of enum()
  // 6. (?=\s*\.optional\(\))    — lookahead anchors to Zod schema chain
  // The key boundary prevents matching "submodel:"; the lookahead prevents matching other model enums.
  let changed = 0;

  const result = code.replace(
    /(^|[{,]\s*)(model|"model")\s*:\s*([\w$]+)\.enum\((\[[\s\S]*?\])\)(?=\s*\.optional\(\))/g,
    (match, prefix, propName, ident, arrayStr) => {
      if (!enumArrayHasTargetModels(arrayStr)) return match;

      changed += 1;
      // Wrap in ternary, preserving the original enum as fallback
      // Use parens to ensure chaining (.optional().describe()) works
      return `${prefix}${propName}: (typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}") ? ${ident}.string() : ${ident}.enum(${arrayStr}))`;
    }
  );

  return { code: result, changed };
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-model-enum-to-string.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const { code: output, changed: changedCount } = transform(code);

  if (changedCount === 0) {
    console.error("No matching model enum found; nothing changed.");
  } else {
    console.error(`Wrapped ${changedCount} model enum call(s) with __isModEnabled__ ternary.`);
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

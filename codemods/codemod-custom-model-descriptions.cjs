#!/usr/bin/env node
// Read the model list from mod configuration, not a synchronous network request during schema construction.

const fs = require("fs");
const path = require("path");

const MOD_ID = "unlock_agent_models";

// Quote-tolerant, text-tolerant, same-line-bounded anchor. Group 1 = the quote
// char, group 2 = the full original text (preserved verbatim).
const PATTERN = /\.describe\((["'\x60])(Optional model override for this agent[^\n]*?)\1\)/;

function transform(code) {
  if (!PATTERN.test(code)) {
    return { code, changed: 0 };
  }

  // Config-driven prefix: reads the "models" string (comma-separated) from
  // mods.json via __getModConfig__. Wrapped in try/catch so a helper failure
  // degrades to "" (original text) rather than throwing at schema-build.
  const dynamicPrefix =
    `(typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}") ` +
    `? (() => { try { var __m = (typeof __getModConfig__ === "function" ? __getModConfig__("${MOD_ID}", "models", "") : ""); return __m ? ("Available models: " + __m + ". ") : ""; } catch(__e) { return ""; } })() ` +
    `: "") + `;

  let changed = 0;
  const result = code.replace(PATTERN, (match, quote, text) => {
    changed += 1;
    return `.describe(\n      ${dynamicPrefix}${quote}${text}${quote})`;
  });

  return { code: result, changed };
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-custom-model-descriptions.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const { code: output, changed: changedCount } = transform(code);

  if (changedCount === 0) {
    console.error("No matching .describe(Optional model override...) found; nothing changed.");
  } else {
    console.error(`Injected config-driven model list into Agent tool .describe() (${changedCount} site).`);
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

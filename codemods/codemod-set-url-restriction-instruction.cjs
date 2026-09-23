#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const MOD_ID = "set_url_restriction_instruction";

const URL_RESTRICTION_TEXT = "IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming. You may use URLs provided by the user in their messages or local files.";

const GUARD_EXPR = 'typeof __isModEnabled__==="function"&&__isModEnabled__("set_url_restriction_instruction")';
const ENABLED_EXPR = '(process.env.CLAUDE_URL_RESTRICTION_INSTRUCTION||"")';

/**
 * Replace the URL restriction text with a mod-guarded conditional.
 * @param {string} code - Source code to transform
 * @returns {{ code: string, changed: number }}
 */
function transform(code) {
  const idx = code.indexOf(URL_RESTRICTION_TEXT);
  if (idx === -1) {
    return { code, changed: 0 };
  }

  // Guard against multiple matches — would produce ambiguous output
  const secondIdx = code.indexOf(URL_RESTRICTION_TEXT, idx + 1);
  if (secondIdx !== -1) {
    throw new Error("Expected exactly 1 occurrence of URL restriction text, found at least 2");
  }

  // Escape the original text for embedding in a double-quoted string literal.
  const escapedText = URL_RESTRICTION_TEXT.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const disabledExpr = '"' + escapedText + '"';
  // ${__getModConfig__("set_url_restriction_instruction","instruction") ?? "<original>"}
  // Disabled -> undefined ?? original -> original; enabled+set -> value; enabled+"" -> "" (CLEAR).
  const replacement = '${__getModConfig__("set_url_restriction_instruction","instruction") ?? ' + disabledExpr + '}';

  const result = code.substring(0, idx) + replacement + code.substring(idx + URL_RESTRICTION_TEXT.length);

  return { code: result, changed: 1 };
}

/** CLI wrapper */

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-set-url-restriction-instruction.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const { code: output, changed } = transform(code);

  if (changed === 0) {
    throw new Error("No matching URL restriction instruction string found; nothing changed.");
  } else {
    console.error(`Wrapped ${changed} URL restriction instruction with __isModEnabled__ guard.`);
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

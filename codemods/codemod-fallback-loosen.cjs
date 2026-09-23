#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { findMatchingBrace } = require("../lib/utils.cjs");

const MOD_ID = "fix_request_resilience";
const ANCHOR = "process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS";
const MARKER = '__getModConfig__("fix_request_resilience", "min_status"';

const HAS_MOD =
  'typeof __isModEnabled__ === "function" && __isModEnabled__("' + MOD_ID + '")' +
  ' && typeof __getModConfig__ === "function"';

function transform(code) {
  if (code.includes(MARKER)) {
    return { code, changed: 0 };
  }

  const anchorIdx = code.indexOf(ANCHOR);
  if (anchorIdx < 0) return { code, changed: 0 };

  // Walk back from the anchor to the `(` that opens the model-scope operand.
  let i = anchorIdx;
  while (i > 0 && (code[i - 1] === " " || code[i - 1] === "\t")) i--;
  if (code[i - 1] !== "(") return { code, changed: 0 };
  // Walk further back to the enclosing `if (` whose condition contains this operand.
  const ifIdx = code.lastIndexOf("if (", i - 1);
  if (ifIdx < 0) return { code, changed: 0 };
  const condOpen = ifIdx + 3; // index of the `(` after "if"
  const condClose = findMatchingBrace(code, condOpen, "(", ")");
  if (condClose < 0 || condClose <= anchorIdx) return { code, changed: 0 };

  const condition = code.slice(condOpen + 1, condClose);

  // Split on the top-level `&&` (paren depth 0 within the condition).
  let depth = 0;
  let splitIdx = -1;
  for (let j = 0; j < condition.length; j++) {
    const c = condition[j];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && c === "&" && condition[j + 1] === "&") { splitIdx = j; break; }
  }
  if (splitIdx < 0) return { code, changed: 0 };

  const errorCheck = condition.slice(0, splitIdx).trim();
  const modelScope = condition.slice(splitIdx + 2).trim(); // includes its own parens

  // ERRORCHECK is `FN(VAR)` — capture the error variable for the status check.
  const ecMatch = /^([\w$]+)\(([\w$]+)\)$/.exec(errorCheck);
  if (!ecMatch) return { code, changed: 0 };
  const errorCheckFn = ecMatch[1];
  const errorVar = ecMatch[2];

  // Build the wrapped operands.
  const minStatusOperand =
    "(" + HAS_MOD + " && __getModConfig__(\"" + MOD_ID + "\", \"min_status\", 500)" +
    " ? (" + errorVar + " && typeof " + errorVar + ".status === \"number\" && " + errorVar + ".status >= __getModConfig__(\"" + MOD_ID + "\", \"min_status\", 500))" +
    " : " + errorCheckFn + "(" + errorVar + "))";
  const allModelsOperand =
    "(" + HAS_MOD + " && __getModConfig__(\"" + MOD_ID + "\", \"all_models\", true) !== false" +
    " ? true : " + modelScope + ")";

  const newCondition = "((" + minStatusOperand + ") && (" + allModelsOperand + "))";

  // Threshold: find `COUNTER++; ... if (COUNTER >= THRESHOLD)` shortly after the condition close.
  const tailWindow = code.slice(condClose + 1, condClose + 1 + 220);
  const thrMatch = /([\w$]+)\+\+;\s*\r?\n\s*if\s*\(\s*\1\s*>=\s*([\w$]+)\s*\)/.exec(tailWindow);
  if (!thrMatch) return { code, changed: 0 };
  const counter = thrMatch[1];
  const threshold = thrMatch[2];
  const ifRelStart = thrMatch.index + thrMatch[0].lastIndexOf("if");
  const thrAbsStart = condClose + 1 + ifRelStart;
  const thrAbsEnd = thrAbsStart + tailWindow.slice(ifRelStart).indexOf(")") + 1;
  const thrReplacement =
    "if (" + counter + " >= (" + HAS_MOD + " && __getModConfig__(\"" + MOD_ID + "\", \"threshold\", 1) || " + threshold + "))";

  // Apply edits in descending offset order so earlier offsets stay valid.
  let out = code;
  out = out.slice(0, thrAbsStart) + thrReplacement + out.slice(thrAbsEnd);
  out = out.slice(0, condOpen + 1) + newCondition + out.slice(condClose);

  return { code: out, changed: out !== code ? 1 : 0 };
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-fallback-loosen.cjs <input.js> [output.js]");
    process.exit(1);
  }
  const code = fs.readFileSync(path.resolve(inputFile), "utf8");
  const { code: output, changed } = transform(code);
  if (changed === 0) {
    console.error("No fallback condition block found; nothing changed.");
  } else {
    console.error("Wrapped fallback condition with __getModConfig__ guards (structural match).");
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

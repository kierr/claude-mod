#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const MOD_ID = "display_model_name";

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Inject model badge into the teammate row component.
 *
 * Strategy: find createElement calls with { teammate, pastTenseVerb, displayTime, activityText }
 * props (the daO subcomponent). Insert a model badge element after it:
 *
 *   typeof __isModEnabled__ === "function" && __isModEnabled__("display_model_name")
 *     ? (H.model && CE.createElement(T, { dimColor: true }, " · ", H.model))
 *     : undefined
 *
 * Discovers: teammate alias, createElement var, Text component var from context.
 */
function transform(code) {
  if (typeof code !== "string") return { code: "", changed: 0 };

  // Idempotency: skip if already patched
  // Idempotency: skip if already patched
  if (code.includes(`__isModEnabled__("${MOD_ID}")`) && code.includes('.model &&')) {
    return { code, changed: 0 };
  }

  // Find the teammate function by its destructured param set:
  // { teammate: H, isLast: _, isSelected: q, isForegrounded: K, allIdle: O, showPreview: T }
  // All six must be present in the destructuring.
  const funcPattern = /function\s+([\w$]+)\s*\(\s*\{[\s\S]*?teammate\s*:[\s]*([\w$]+)[\s\S]*?\}\s*\)\s*\{/g;

  let funcMatch;
  let teammateAlias = null;

  while ((funcMatch = funcPattern.exec(code)) !== null) {
    const funcBody = funcMatch[0];
    const alias = funcMatch[2];
    // Verify all six required props are present
    const requiredProps = ["isLast", "isSelected", "isForegrounded", "allIdle", "showPreview"];
    if (requiredProps.every(p => funcBody.includes(p))) {
      teammateAlias = alias;
      break;
    }
  }

  if (!teammateAlias) return { code, changed: 0 };

  // Find createElement function name
  const cePattern = /([\w$]+)\.createElement\s*\(/g;
  let createElementVar = null;
  let ceMatch;
  while ((ceMatch = cePattern.exec(code)) !== null) {
    createElementVar = ceMatch[1];
    break;
  }
  if (!createElementVar) return { code, changed: 0 };

  // Find the Text component name (used with dimColor)
  // Pattern: createElement(TEXTCOMP, { dimColor: true }, ...)
  const textCompPattern = new RegExp(
    `${escapeRegex(createElementVar)}\\.createElement\\s*\\(\\s*([\\w$]+)\\s*,\\s*\\{\\s*dimColor\\s*:\\s*true`,
    "g"
  );
  let textCompVar = null;
  let tcMatch;
  while ((tcMatch = textCompPattern.exec(code)) !== null) {
    textCompVar = tcMatch[1];
    break;
  }
  if (!textCompVar) return { code, changed: 0 };

  // Find the daO createElement call with { teammate, pastTenseVerb, displayTime, activityText }
  const daoPattern = new RegExp(
    `${escapeRegex(createElementVar)}\\.createElement\\s*\\(\\s*[\\w$]+\\s*,\\s*\\{[^}]*teammate[^}]*pastTenseVerb[^}]*displayTime[^}]*activityText[^}]*\\}`,
    "g"
  );

  let daoMatch;
  while ((daoMatch = daoPattern.exec(code)) !== null) {
    // Find the end of this createElement call (matching closing paren)
    const callStart = daoMatch.index;
    let depth = 0;
    let callEnd = -1;
    for (let i = callStart; i < code.length; i++) {
      if (code[i] === '(') depth++;
      if (code[i] === ')') { depth--; if (depth === 0) { callEnd = i; break; } }
    }
    if (callEnd === -1) continue;

    // Build the model badge element
    const modGuard = `typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}")`;
    const modelBadge = `${modGuard} ? (${teammateAlias}.model && ${createElementVar}.createElement(${textCompVar}, { dimColor: true }, " · ", ${teammateAlias}.model)) : undefined`;

    // Insert after the daO call's closing paren + comma (or just closing paren)
    const afterCall = code.substring(callEnd, callEnd + 10);
    if (afterCall.startsWith(",") || afterCall.match(/^\s*,/)) {
      // Already has a comma — insert before it
      code = code.substring(0, callEnd) + `, ${modelBadge}` + code.substring(callEnd);
    } else {
      code = code.substring(0, callEnd + 1) + `, ${modelBadge}` + code.substring(callEnd + 1);
    }

    return { code: code, changed: 1 };
  }

  return { code, changed: 0 };
}

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-teammate-list-show-model.cjs <input.js> [output.js]");
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
    console.error("No matching patterns found; nothing changed.");
  } else {
    console.error(`Injected model badge into ${changed} teammate row component(s).`);
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

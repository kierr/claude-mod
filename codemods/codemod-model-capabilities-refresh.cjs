#!/usr/bin/env node
// Enable the existing capabilities fetcher without bypassing unrelated traffic controls.

const fs = require("fs");
const path = require("path");
const { skipStringOrComment, findMatchingBrace, findMatchingParen } = require("./scan-helpers.cjs");

const MOD_ID = "model_capabilities_refresh";

/**
 * Find the async function containing `.models.list(` — the model capabilities populator.
 * Then rewrite each leading `if (GUARD) { return; }` statement by appending a
 * negated mod-guard conjunction: `GUARD && !(typeof __isModEnabled__ === "function" && __isModEnabled__("model_capabilities_refresh"))`.
 *
 * Anchors on the stable `.models.list(` call to locate the populator function.
 * Discovers minified function names and guard call names from context.
 */
function transform(code) {
  // Idempotency: already patched
  if (code.includes(`__isModEnabled__("${MOD_ID}")`)) {
    return { code, changed: 0 };
  }

  const modGuard = `typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}")`;

  // Step 1: Find the async function containing .models.list(
  // We locate it by finding `.models.list(` and then scanning backward for the
  // nearest `async function` keyword.
  const modelsListIdx = code.indexOf(".models.list(");
  if (modelsListIdx === -1) return { code, changed: 0 };

  // Scan backward for "async function"
  let fnStart = -1;
  let searchFrom = modelsListIdx;
  while (searchFrom > 0) {
    const idx = code.lastIndexOf("async function", searchFrom);
    if (idx === -1) break;
    // Verify this function actually contains .models.list(
    const fnBody = code.substring(idx, modelsListIdx + 200);
    if (fnBody.includes(".models.list(")) {
      fnStart = idx;
      break;
    }
    searchFrom = idx - 1;
  }

  if (fnStart === -1) return { code, changed: 0 };

  // Step 2: Find the opening brace of the function body
  const bodyBrace = code.indexOf("{", fnStart);
  if (bodyBrace === -1) return { code, changed: 0 };

  // Step 3: Walk through the leading if-guard statements, rewriting each one.
  // Pattern: if (CALL()) { return; } or if (!CALL()) { return; } or if (CALL()) return;
  // Where CALL is a 0-argument identifier call.
  let pos = bodyBrace + 1;
  let count = 0;

  // Skip whitespace
  const skipWs = (p) => { while (p < code.length && /\s/.test(code[p])) p++; return p; };

  while (pos < code.length) {
    pos = skipWs(pos);
    // Check for if-statement
    if (!code.startsWith("if", pos)) break;
    const ifStart = pos;
    pos += 2;
    pos = skipWs(pos);
    if (code[pos] !== "(") break;
    const parenEnd = findMatchingParen(code, pos);
    if (parenEnd === -1) break;
    const testStart = pos + 1;
    const testEnd = parenEnd;
    const testExpr = code.substring(testStart, testEnd).trim();
    pos = parenEnd + 1;

    // Verify this is a 0-arg call guard: IDENT() or !IDENT()
    const guardMatch = testExpr.match(/^(!?)([\w$]+)\(\)$/) ||
                       testExpr.match(/^(!?)([\w$]+)\(\s*\)$/);
    if (!guardMatch) break;

    // Find the consequent — either { return; } or return;
    pos = skipWs(pos);
    let consequentEnd;
    let isBareReturn = false;

    if (code.startsWith("return", pos)) {
      // bare return;
      const semiIdx = code.indexOf(";", pos);
      if (semiIdx === -1) break;
      // Verify it's a bare return (no argument)
      const retExpr = code.substring(pos, semiIdx).trim();
      if (retExpr !== "return") break;
      consequentEnd = semiIdx + 1;
      isBareReturn = true;
    } else if (code[pos] === "{") {
      // Block consequent — find matching brace (string/comment-aware)
      const braceEnd = findMatchingBrace(code, pos);
      if (braceEnd === -1) break;
      const block = code.substring(pos + 1, braceEnd).trim();
      if (block !== "return;") break;
      consequentEnd = braceEnd + 1;
    } else {
      break;
    }

    // Rewrite: append && !(modGuard) to the test
    const negatedModGuard = `!(${modGuard})`;
    const newTest = `${testExpr} && ${negatedModGuard}`;
    const newIf = `if (${newTest}) ${code.substring(code.indexOf(")", testEnd) + 1, consequentEnd).trimStart ? "" : ""}`;

    // Simpler approach: just replace the test expression within the if-statement
    const ifStmt = code.substring(ifStart, consequentEnd);
    const newIfStmt = ifStmt.replace(`(${testExpr})`, `(${newTest})`);

    code = code.substring(0, ifStart) + newIfStmt + code.substring(consequentEnd);
    count++;

    // Move pos past the rewritten statement
    pos = ifStart + newIfStmt.length;
  }

  if (count === 0) return { code, changed: 0 };

  return { code, changed: count };
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-model-capabilities-refresh.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const { code: output, changed } = transform(code);

  if (changed === 0) {
    console.error("No matching patterns found; nothing changed.");
  } else {
    console.error(`Model capabilities refresh: ${changed} guard(s) mod-guarded`);
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

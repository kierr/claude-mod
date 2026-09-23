#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const TARGET_STRING = "API Usage Billing";
const MOD_ID = "display_endpoint_label";

/**
 * Find the pattern: CALL1() ? CALL2() : "API Usage Billing"
 * Where CALL1 and CALL2 are zero-arg function calls.
 * Replace the alternate "API Usage Billing" with:
 *   (typeof __isModEnabled__ === "function" && __isModEnabled__("display_endpoint_label") && process.env.ANTHROPIC_BASE_URL)
 *     ? (() => { try { return new URL(process.env.ANTHROPIC_BASE_URL).host } catch(e) { return "API" } })()
 *     : "API Usage Billing"
 *
 * Anchors on the stable string "API Usage Billing".
 */
function transform(code) {
  // Idempotency: already patched (mod-guarded form)
  if (code.includes(`__isModEnabled__("${MOD_ID}")`) && code.includes("ANTHROPIC_BASE_URL") && code.includes("new URL")) {
    return { code, changed: 0 };
  }

  // Also check for pre-mod-guard already-transformed form
  if (code.includes("ANTHROPIC_BASE_URL") && code.includes("new URL(process.env.ANTHROPIC_BASE_URL).host")) {
    return { code, changed: 0 };
  }

  const modGuard = `typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}")`;

  // Pattern: CALL1() ? CALL2() : "API Usage Billing"
  // Zero-arg calls: identifier followed by ()
  const pattern = /([\w$]+)\(\)\s*\?\s*([\w$]+)\(\)\s*:\s*"API Usage Billing"/g;

  const matches = [...code.matchAll(pattern)];

  // Must match exactly one (fail-closed)
  if (matches.length === 0) {
    throw new Error(
      `Expected exactly 1 ConditionalExpression match (test=zero-arg call, consequent=zero-arg call, alternate="${TARGET_STRING}"), found 0.`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Expected exactly 1 ConditionalExpression match (test=zero-arg call, consequent=zero-arg call, alternate="${TARGET_STRING}"), found ${matches.length}.`
    );
  }

  const match = matches[0];
  const call1 = match[1];
  const call2 = match[2];

  const replacement = `${call1}() ? ${call2}() : (${modGuard} && process.env.ANTHROPIC_BASE_URL) ? (() => { try { return new URL(process.env.ANTHROPIC_BASE_URL).host } catch(e) { return "API" } })() : "${TARGET_STRING}"`;

  code = code.substring(0, match.index) + replacement + code.substring(match.index + match[0].length);

  return { code, changed: 1 };
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-display-endpoint-label.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const { code: output, changed } = transform(code);
  console.error(`Replaced ${changed} billing display alternate(s) with URL hostname extractor.`);

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

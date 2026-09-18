#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const MOD_ID = "set_cyber_risk_instruction";
const SECURITY_INSTRUCTION_PREFIX = "IMPORTANT: Assist with authorized security testing";

/**
 * Find `var IDENT = "IMPORTANT: Assist with authorized security testing...";`
 * and replace the initializer with a __getModConfig__ ?? original fallback.
 *
 * Anchors on the stable security-instruction prefix string.
 * The var name and the full string content are discovered, not hardcoded.
 */
function transform(code) {
  // Idempotency: already transformed — no var with a raw security string remains.
  if (code.includes('__getModConfig__("set_cyber_risk_instruction"')) {
    return { code, changed: 0 };
  }

  // Match: var <ident> = "IMPORTANT: Assist with authorized security testing...";
  // Only var (not let/const), only string literals starting with the prefix.
  const pattern = new RegExp(
    `var\\s+([\\w$]+)\\s*=\\s*"(${SECURITY_INSTRUCTION_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"]*)"\\s*;`
  );

  const match = code.match(pattern);
  if (!match) {
    throw new Error("No matching security instruction string found; nothing changed.");
  }

  const fullMatch = match[0];
  const originalString = match[2];

  const replacement = `var ${match[1]} = __getModConfig__("${MOD_ID}", "instruction") ?? "${originalString}";`;

  code = code.replace(fullMatch, replacement);
  return { code, changed: 1 };
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-set-cyber-risk-instruction.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const { code: output, changed } = transform(code);
  if (changed === 0) {
    throw new Error("No matching security instruction string found; nothing changed.");
  }
  console.error(`Wrapped ${changed} security instruction variable(s) with __getModConfig__ guard.`);

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

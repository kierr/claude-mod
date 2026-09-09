#!/usr/bin/env node

"use strict";

const MOD_ID = "unlock_auto_mode";

function transform(code) {
  // Idempotency: already patched
  if (code.includes("__AMMB__")) {
    return { code, changed: 0 };
  }

  // Strategy: find the function by looking for the unique sequence:
  //   1. "claude-opus-4-0" in a negative if check
  //   2. "claude-opus-4-7" in a positive if check in the same function
  //   3. "claude-sonnet-4-6" also in the positive check
  // Then find the enclosing function boundaries.
  //
  // The key insight: claude-opus-4-0 in a NEGATIVE check (return false)
  // and claude-opus-4-7 in a POSITIVE check (return true) in the same
  // function is unique to the auto mode model gate.

  // Find the pair: "claude-opus-4-0" in a line with "return false"
  // followed by "claude-opus-4-7" in a line with "return true"
  // within 500 chars of each other
  // Matches: "claude-opus-4-0" in negative check → "claude-opus-4-7" in positive check →
  // "claude-sonnet-4-6" also in positive check → return true; → } → fallback return $h(YD(H));
  // The gaps between model names can be large (OR chains with many alternatives).
  const pairPattern = /"claude-opus-4-0"[\s\S]{0,800}"claude-opus-4-7"[\s\S]{0,400}"claude-sonnet-4-6"[\s\S]{0,400}return\s+true;\s*\}\s*return\s+[\w$]+\([\w$]+\([\w$]+\)\);\s*\}/;

  const pairMatch = code.match(pairPattern);
  if (!pairMatch) {
    return { code, changed: 0 };
  }

  // Now find the enclosing function by scanning backwards
  const matchEnd = pairMatch.index + pairMatch[0].length;
  let fnStart = -1;
  let param = null;

  for (let i = pairMatch.index; i >= Math.max(0, pairMatch.index - 500); i--) {
    const chunk = code.substring(i, i + 60);
    const fnMatch = chunk.match(/^function\s+([\w$]+)\(([\w$]+)\)\s*\{/);
    if (fnMatch) {
      fnStart = i;
      param = fnMatch[2];
      break;
    }
  }

  if (fnStart === -1) {
    return { code, changed: 0 };
  }

  const fnNameMatch = code.substring(fnStart, fnStart + 30).match(/function\s+([\w$]+)/);
  // fnNameMatch can't fail: fnStart was set by the scan-backward loop which
  // already matched the same "function <name>" pattern at this position.
  const fnName = fnNameMatch[1];

  // Find the opening brace of the function to extract the original body
  const openBrace = code.indexOf("{", fnStart);
  // Find the matching close brace by scanning from matchEnd backwards
  // (matchEnd is past the last `}` of the pair pattern)
  let closeBrace = matchEnd - 1;
  while (closeBrace > fnStart && code[closeBrace] !== "}") closeBrace--;

  const originalBody = code.substring(openBrace + 1, closeBrace).trim();

  const replacement =
    `function ${fnName}(${param}) {\n` +
    `    if(typeof __isModEnabled__==="function"&&__isModEnabled__("unlock_auto_mode"))return true; /* __AMMB__ */\n` +
    `    ${originalBody.split("\n").map(line => line.trim()).filter(Boolean).join("\n    ")}\n` +
    `  }`;
  const result = code.substring(0, fnStart) + replacement + code.substring(matchEnd);

  return { code: result, changed: result !== code ? 1 : 0 };
}

module.exports = { transform };

if (require.main === module) {
  const fs = require("fs");
  const inputPath = process.argv[2];
  const outputPath = process.argv[3] || inputPath;
  const code = fs.readFileSync(inputPath, "utf8");
  const { code: output, changed } = transform(code);
  fs.writeFileSync(outputPath, output);
  console.error(`${MOD_ID}: ${changed} patches applied`);
  process.exit(changed > 0 ? 0 : 2);
}

#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const MOD_ID = "fix_request_resilience";

/**
 * Pattern C: zw3 retryability gate's 429 return block in KM6 retry wrapper.
 * Matches: if (H.status === 429) { return !Lq() || faH(); }
 * Returns the regex match. Inserts mod guard before conditional return.
 */
function matchPatternC(code) {
  const PATTERN =
    /if\s*\(\s*([\w$]+)\.status\s*===\s*429\s*\)\s*\{\s*return\s+![\w$]+\(\)\s*\|\|\s*[\w$]+\(\);\s*\}/;
  return PATTERN.exec(code);
}

/**
 * Pattern B: SDK shouldRetry with simple status checks
 * Anchored on x-should-retry header + 429/500/return-false tail.
 * Variable name captured in $1.
 */
function matchPatternB(code) {
  const PATTERN =
    /if\s*\(\s*([\w$]+)\.status\s*===\s*429\s*\)\s*\{\s*return\s+true;\s*\}\s*if\s*\(\s*\1\.status\s*>=\s*500\s*\)\s*\{\s*return\s+true;\s*\}\s*return\s+false;/;

  const match = PATTERN.exec(code);
  if (!match) return null;

  // Verify this is the SDK shouldRetry by checking for x-should-retry nearby
  const nearby = code.slice(Math.max(0, match.index - 600), match.index);
  if (!nearby.includes("x-should-retry")) return null;

  return { match, varName: match[1], endIndex: match.index + match[0].length };
}

function transform(code) {
  let output = code;
  let changed = 0;

  // Pattern C2 (always-on un-nerf): the x-should-retry:"true" tier gate.
  //   if (_ === "true" && (!Lq() || OsH())) { return true; }
  // The (!Lq() || OsH()) conjunct is the subscriber-tier restriction
  // (non-subscriber OR enterprise only). Neutralize it so the branch fires
  // regardless of tier when the mod is enabled:
  //   if (_ === "true" && (MODGUARD || (!Lq() || OsH()))) { return true; }
  // Scoped to a window after each x-should-retry header read so the global
  // `=== "true" && (...)` shape can't match unrelated code.
  const C2_GUARD =
    'typeof __isModEnabled__ === "function" && __isModEnabled__("' + MOD_ID + '")' +
    ' && typeof __getModConfig__ === "function" && __getModConfig__("' + MOD_ID + '", "enabled", true)';
  const C2_READ = /([\w$]+\s*=\s*[\w$]+\.headers\??\.get\("x-should-retry"\);)/g;
  const C2_GATE = /===\s*"true"\s*&&\s*\(\s*!([\w$]+)\(\)\s*\|\|\s*([\w$]+)\(\)\s*\)/;
  {
    const edits = [];
    let m;
    C2_READ.lastIndex = 0;
    while ((m = C2_READ.exec(code)) !== null) {
      const winStart = m.index;
      const window = code.slice(winStart, winStart + 500);
      const g = C2_GATE.exec(window);
      if (!g) continue;
      const absStart = winStart + g.index;
      const absEnd = absStart + g[0].length;
      const replacement = '=== "true" && (' + C2_GUARD + ' || (!' + g[1] + '() || ' + g[2] + '()))';
      edits.push({ absStart, absEnd, replacement });
    }
    if (edits.length > 0) {
      // Apply in reverse offset order so earlier offsets stay valid.
      let out = code;
      for (let i = edits.length - 1; i >= 0; i--) {
        const e = edits[i];
        out = out.slice(0, e.absStart) + e.replacement + out.slice(e.absEnd);
      }
      output = out;
      changed += edits.length;
    }
  }

  // Try Pattern C first (zw3 retryability gate's 429 return block)
  let match = matchPatternC(output);
  if (match) {
    const fullText = match[0];
    const returnRegex = /return\s+![\w$]+\(\)\s*\|\|\s*[\w$]+\(\);/;
    const returnText = fullText.match(returnRegex)[0];
    const guardC =
      `if (typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}") && typeof __getModConfig__ === "function" && __getModConfig__("${MOD_ID}", "enabled", true)) {\n` +
      `        return true;\n` +
      `      }\n      `;
    const newBlock = fullText.replace(returnRegex, guardC + returnText);
    output = output.replace(fullText, () => newBlock);
    changed = 1;
  }

  // Try Pattern B (SDK shouldRetry)
  const resultB = matchPatternB(output);
  if (resultB) {
    const { match: matchB } = resultB;
    const guardB =
      `if (typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}") && typeof __getModConfig__ === "function" && __getModConfig__("${MOD_ID}", "enabled", true)) {\n` +
      `      return true;\n` +
      `    }\n    `;
    const newTail = matchB[0].replace(
      /return\s+false;/,
      `${guardB}return false;`
    );
    output = output.replace(matchB[0], () => newTail);
    changed++;
  }

  return { code: output, changed };
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-retry-all-errors.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const { code: output, changed: changedCount } = transform(code);

  if (changedCount === 0) {
    console.error("No matching retryability gate found; nothing changed.");
  } else {
    console.error(`Applied fix_request_resilience guard (%d transform(s)).`, changedCount);
  }

  if (outputFile) {
    fs.writeFileSync(path.resolve(outputFile), output, "utf8");
  } else {
    process.stdout.write(output);
  }
}

if (require.main === module) {
  main();
}

module.exports = { transform };

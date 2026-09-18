#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const TITLE_REPLACEMENTS = {
  "Plan Mode": "Plan",
  "Accept edits": "Accept",
  "Bypass Permissions": "Bypass",
  "Don't Ask": "DontAsk",
  "Auto mode": "Auto",
};

const MOD_ID = "display_short_mode_labels";

/**
 * Two passes:
 * 1. Shorten mode title strings: replace `title: "Plan Mode"` with
 *    `title: __isModEnabled__(...) ? "Plan" : "Plan Mode"`
 * 2. Guard " on" string in createElement calls: replace `" on"` with
 *    `__isModEnabled__(...) ? "" : " on"` and null the chord-hint arg.
 */
function transform(code) {
  // Idempotency: already patched
  if (code.includes(`__isModEnabled__("${MOD_ID}")`)) {
    return { code, changed: 0 };
  }

  const modGuard = `typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}")`;
  let count = 0;

  // Pass 1: Shorten mode titles
  for (const [original, shortened] of Object.entries(TITLE_REPLACEMENTS)) {
    // Match: title: "Plan Mode" (in object literal)
    const pattern = new RegExp(`(title:\\s*)"${original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g");
    const replacement = `$1${modGuard} ? "${shortened}" : "${original}"`;
    const newCode = code.replace(pattern, replacement);
    if (newCode !== code) {
      // Count how many replacements were made
      const origMatches = code.match(pattern);
      count += origMatches ? origMatches.length : 0;
      code = newCode;
    }
  }

  // Pass 2: Guard " on" in createElement calls
  // Pattern: createElement(... , " on", <chord-hint-arg>)
  // The " on" appears as a string literal argument to createElement.
  // We need to find it and replace with a ternary.
  const onPattern = /createElement\s*\([^)]*\)\s*[^;]*" on"/g;
  // More targeted: find " on" that appears after .toLowerCase() in a createElement context
  const targetedPattern = /(\.toLowerCase\(\)\s*,\s*)" on"(\s*,\s*([\w$]+))/g;

  let match;
  while ((match = targetedPattern.exec(code)) !== null) {
    const before = match[1];      // .toLowerCase(), 
    const afterAndArg = match[2]; // , chordArg
    const chordArg = match[3];    // the chord-hint variable

    const origSegment = match[0];
    const newSegment = `${before}${modGuard} ? "" : " on"${afterAndArg.replace(chordArg, `${modGuard} ? null : ${chordArg}`)}`;

    code = code.substring(0, match.index) + newSegment + code.substring(match.index + origSegment.length);
    count += 2; // " on" replacement + chord hint nulling
    // Reset regex since we mutated the string
    targetedPattern.lastIndex = 0;
  }

  // Also handle " on" in simpler createElement patterns without .toLowerCase()
  // but still inside createElement() calls
  const simpleOnPattern = /(createElement\s*\([^)]*,\s*)" on"(\s*,\s*[\w$]+)/g;
  while ((match = simpleOnPattern.exec(code)) !== null) {
    // Skip if already handled by the targeted pattern (has __isModEnabled__)
    if (code.substring(match.index - 50, match.index).includes("__isModEnabled__")) continue;

    const before = match[1];
    const afterAndArg = match[2];
    const chordArg = afterAndArg.match(/,\s*([\w$]+)/)?.[1];

    const origSegment = match[0];
    let newSegment = `${before}${modGuard} ? "" : " on"${afterAndArg}`;
    if (chordArg) {
      newSegment = `${before}${modGuard} ? "" : " on"${afterAndArg.replace(chordArg, `${modGuard} ? null : ${chordArg}`)}`;
      count += 2;
    } else {
      count += 1;
    }

    code = code.substring(0, match.index) + newSegment + code.substring(match.index + origSegment.length);
    simpleOnPattern.lastIndex = 0;
  }

  if (count === 0) return { code, changed: 0 };

  return { code, changed: count };
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-display-short-mode-labels.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const { code: output, changed } = transform(code);
  console.error(`Shortened ${changed} mode label(s).`);

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

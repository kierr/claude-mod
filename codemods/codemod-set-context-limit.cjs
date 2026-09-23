#!/usr/bin/env node
// Set context window limits: override the 200000 default with mod config values,
// and replace bare > 200000 comparisons in the context-window guard function.
"use strict";

const fs = require("fs");
const path = require("path");

const MOD_ID = "set_context_limit";

function transform(code) {
  // Idempotency: if all three config calls exist, skip
  const cfgPattern = `__getModConfig__("${MOD_ID}"`;
  const cfgCount = (code.match(new RegExp(cfgPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
  if (cfgCount >= 3) {
    return { code, changed: 0 };
  }

  const cfgCall = (key) => `__getModConfig__("${MOD_ID}", "${key}") ?? 200000`;
  let count = 0;

  // Detect code-split by the CLAUDE_CODE_DISABLE_1M_CONTEXT property-access pattern
  const isCodeSplit = code.includes("a.CLAUDE_CODE_DISABLE_1M_CONTEXT") ||
    (code.includes("a.ANTHROPIC_API_KEY") && !code.includes("process.env.ANTHROPIC_API_KEY"));

  // Find each `var X = 200000;` and scope to its containing brace block
  const var200kPattern = /var\s+([\w$]+)\s*=\s*200000\s*;/g;
  const candidates = [];
  let m;
  while ((m = var200kPattern.exec(code)) !== null) {
    candidates.push({ name: m[1], index: m.index, matchStr: m[0] });
  }

  // Phase 1: Classify all candidates BEFORE any replacements
  // (replacements change the neighbor window, breaking classification of
  // co-located candidates like fxe/Lj in the same 500-char block).
  const classifications = new Map(); // candidate name → cfgKey

  // For code-split disambiguation: track which 200000 is first vs second
  // in a block that has [200000, 32000, 128000] as neighbors
  const codeSplitBlockOrder = new Map(); // blockKey → array of candidate indices (in source order)

  for (let ci = 0; ci < candidates.length; ci++) {
    const cand = candidates[ci];
    const pos = cand.index;

    // Find the containing brace block (or top-level scope)
    let braceStart = -1;
    let depth = 0;
    for (let i = pos; i >= 0; i--) {
      if (code[i] === '}') depth++;
      if (code[i] === '{') {
        if (depth === 0) { braceStart = i; break; }
        depth--;
      }
    }

    let block;
    if (braceStart === -1) {
      // Top-level scope: use a window
      const blockStart = Math.max(0, pos - 250);
      const blockEnd = Math.min(code.length, pos + 250);
      block = code.substring(blockStart, blockEnd);
    } else {
      let braceEnd = -1;
      depth = 1;
      for (let i = braceStart + 1; i < code.length; i++) {
        if (code[i] === '{') depth++;
        if (code[i] === '}') { depth--; if (depth === 0) { braceEnd = i; break; } }
      }
      if (braceEnd === -1) continue;
      block = code.substring(braceStart, braceEnd + 1);
    }

    // Find neighboring numeric var declarations within this block
    const neighborPattern = /var\s+([\w$]+)\s*=\s*(\d+)\s*;/g;
    const neighbors = [];
    let nm;
    while ((nm = neighborPattern.exec(block)) !== null) {
      if (nm[1] !== cand.name) {
        neighbors.push(parseInt(nm[2], 10));
      }
    }

    // Classify by cluster
    let cfgKey = null;
    if (isCodeSplit) {
      const neighborSet = new Set(neighbors);
      if (neighborSet.has(32000) && neighborSet.has(128000) && neighborSet.has(200000)) {
        // Two 200000s in same block — disambiguate by source order
        const blockKey = braceStart;
        if (!codeSplitBlockOrder.has(blockKey)) {
          codeSplitBlockOrder.set(blockKey, []);
        }
        codeSplitBlockOrder.get(blockKey).push(ci);
      } else if (neighborSet.has(32000) && neighborSet.has(128000)) {
        cfgKey = "context_limit"; // standalone 200000 with 32000/128000 neighbors
      }
    } else {
      // Monolithic
      if ([20000, 32000].every(v => neighbors.includes(v))) {
        cfgKey = "context_limit";
      } else if ([400000, 50].every(v => neighbors.includes(v))) {
        cfgKey = "tool_batch_limit";
      } else if ([250000, 3].every(v => neighbors.includes(v))) {
        cfgKey = "memory_chunk_limit";
      }
    }

    if (cfgKey) {
      classifications.set(ci, cfgKey);
    }
  }

  // Resolve code-split disambiguation: first 200000 in source order = context_limit,
  // second = tool_batch_limit
  for (const [, indices] of codeSplitBlockOrder) {
    // indices are already in source order (forward iteration)
    if (indices.length >= 1) {
      classifications.set(indices[0], "context_limit");
    }
    if (indices.length >= 2) {
      classifications.set(indices[1], "tool_batch_limit");
    }
  }

  // Phase 2: Apply replacements in reverse order (to maintain string offsets)
  for (let ci = candidates.length - 1; ci >= 0; ci--) {
    const cand = candidates[ci];
    const cfgKey = classifications.get(ci);
    if (!cfgKey) continue;

    const newDecl = `var ${cand.name} = ${cfgCall(cfgKey)};`;
    code = code.substring(0, cand.index) + newDecl + code.substring(cand.index + cand.matchStr.length);
    count++;
  }

  // Code-split: patch memory_chunk_limit (var X = 32000 near patched context vars and 128000)
  if (isCodeSplit && count > 0) {
    const memChunkPattern = /var\s+([\w$]+)\s*=\s*32000\s*;/g;
    let mcMatch;
    while ((mcMatch = memChunkPattern.exec(code)) !== null) {
      const mcPos = mcMatch.index;
      // Check if this 32000 is near a 128000 and a patched context var
      const nearby = code.substring(Math.max(0, mcPos - 200), mcPos + 200);
      if (nearby.includes("128000") && nearby.includes("context_limit")) {
        const newDecl = `var ${mcMatch[1]} = __getModConfig__("${MOD_ID}", "memory_chunk_limit") ?? 32000;`;
        code = code.substring(0, mcMatch.index) + newDecl + code.substring(mcMatch.index + mcMatch[0].length);
        count++;
        break; // Only patch the first matching one
      }
    }
  }

  // Now find the context-window variable name (the one with context_limit config)
  const ctxVarMatch = code.match(/var\s+([\w$]+)\s*=\s*__getModConfig__\("set_context_limit",\s*"context_limit"\)/);
  if (ctxVarMatch) {
    const ctxVar = ctxVarMatch[1];

    // Find: > 200000 in a function containing .findLast and "assistant"
    // Strategy: find the function, then replace > 200000 inside it
    const findLastPattern = /\.findLast\s*\(/g;
    let flMatch;
    while ((flMatch = findLastPattern.exec(code)) !== null) {
      // Check if "assistant" appears nearby (within 500 chars)
      const nearby = code.substring(flMatch.index, flMatch.index + 500);
      if (!nearby.includes('"assistant"')) continue;

      // Find the containing function block
      let funcBraceStart = -1;
      let depth = 0;
      for (let i = flMatch.index; i >= 0; i--) {
        if (code[i] === '}') depth++;
        if (code[i] === '{') {
          if (depth === 0) { funcBraceStart = i; break; }
          depth--;
        }
      }
      if (funcBraceStart === -1) continue;

      let funcBraceEnd = -1;
      depth = 1;
      for (let i = funcBraceStart + 1; i < code.length; i++) {
        if (code[i] === '{') depth++;
        if (code[i] === '}') { depth--; if (depth === 0) { funcBraceEnd = i; break; } }
      }
      if (funcBraceEnd === -1) continue;

      const funcBlock = code.substring(funcBraceStart, funcBraceEnd + 1);

      // Replace > 200000 in this function block
      const compPattern = />\s*200000/g;
      const newFuncBlock = funcBlock.replace(compPattern, `> ${ctxVar}`);
      if (newFuncBlock !== funcBlock) {
        code = code.substring(0, funcBraceStart) + newFuncBlock + code.substring(funcBraceEnd + 1);
        count++;
      }
      break; // Only handle the first matching function
    }
  }

  if (count === 0) return { code, changed: 0 };

  return { code, changed: count };
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-set-context-limit.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);

  if (!fs.existsSync(inputPath)) {
    console.error(`Error: Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const code = fs.readFileSync(inputPath, "utf8");

  const { code: output, changed } = transform(code);
  console.error(`Patched ${changed} context limit site(s).`);

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

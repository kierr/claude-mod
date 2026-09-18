#!/usr/bin/env node
// Match each numeric limit by its surrounding operation; identical constants serve independent purposes.

const fs = require("fs");
const path = require("path");

const MOD_ID = "set_context_limit";

/**
 * Find three clusters of `var X = 200000;` by their neighboring var declarations
 * (within the same brace-delimited block), and replace each with
 * __getModConfig__("set_context_limit", key) ?? 200000.
 *
 * Also finds a hardcoded > 200000 comparison in a function containing .findLast
 * and "assistant", replacing 200000 with the context-window variable reference.
 *
 * Clusters (identified by neighboring numeric constants in same block scope):
 * - context_limit: 200000 with neighbors [20000, 32000]
 * - tool_batch_limit: 200000 with neighbors [400000, 50]
 * - memory_chunk_limit: 200000 with neighbors [250000, 3]
 */
function transform(code) {
  // Idempotency: if all three config calls exist, skip
  const cfgPattern = `__getModConfig__("${MOD_ID}"`;
  const cfgCount = (code.match(new RegExp(cfgPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
  if (cfgCount >= 3) {
    return { code, changed: 0 };
  }

  const cfgCall = (key) => `__getModConfig__("${MOD_ID}", "${key}") ?? 200000`;
  let count = 0;

  // Find each `var X = 200000;` and scope to its containing brace block
  const var200kPattern = /var\s+([\w$]+)\s*=\s*200000\s*;/g;

  const candidates = [];
  let m;
  while ((m = var200kPattern.exec(code)) !== null) {
    candidates.push({ name: m[1], index: m.index, matchStr: m[0] });
  }

  // Process in reverse order to maintain earlier offsets
  for (let ci = candidates.length - 1; ci >= 0; ci--) {
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
    let blockStart, blockEnd;
    if (braceStart === -1) {
      // Top-level scope: no enclosing braces — use the whole file
      block = code;
      blockStart = 0;
      blockEnd = code.length;
    } else {
      let braceEnd = -1;
      depth = 1;
      for (let i = braceStart + 1; i < code.length; i++) {
        if (code[i] === '{') depth++;
        if (code[i] === '}') { depth--; if (depth === 0) { braceEnd = i; break; } }
      }
      if (braceEnd === -1) continue;
      block = code.substring(braceStart, braceEnd + 1);
      blockStart = braceStart;
      blockEnd = braceEnd + 1;
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
    if ([20000, 32000].every(v => neighbors.includes(v))) {
      cfgKey = "context_limit";
    } else if ([400000, 50].every(v => neighbors.includes(v))) {
      cfgKey = "tool_batch_limit";
    } else if ([250000, 3].every(v => neighbors.includes(v))) {
      cfgKey = "memory_chunk_limit";
    }

    if (cfgKey) {
      const newDecl = `var ${cand.name} = ${cfgCall(cfgKey)};`;
      code = code.substring(0, cand.index) + newDecl + code.substring(cand.index + cand.matchStr.length);
      count++;
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

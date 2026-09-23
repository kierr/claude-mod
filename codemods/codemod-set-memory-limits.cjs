#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const MOD_ID = "set_memory_limits";

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 7 transforms for memory configuration:
 * 1. max_lines: `var X = 200;` used in template `first ${X} lines`
 * 2. max_bytes: `var X = 4096;` used in template `...${X} byte limit`
 * 3. max_files: `var X = 200;` used in .slice(0, X) with mtimeMs context
 * 4. max_files_structured: `var X = 500;` used in .slice(0, COND ? X : Y) with mtimeMs
 * 5. max_recall: .slice(0, 5) with .has( context
 * 6. selector_model: model: CALL() in "memories relevant to" context
 * 7. selector_max_tokens: max_tokens: 256 in "memories relevant to" context
 */
function transform(code) {
  // Guard: code must be a string (old Babel callers may pass (ast, code))
  if (typeof code !== "string") {
    return { code: "", changed: 0 };
  }

  // Idempotency
  if (code.includes('__getModConfig__("set_memory_limits"')) {
    return { code, changed: 0 };
  }

  const cfg = (key, def) => `__getModConfig__("${MOD_ID}", "${key}") ?? ${def}`;
  let count = 0;

  // Transform 1 & 2: Line and byte limits
  // Find template: `first ${X} lines (or ${Y} byte limit)`
  const lineBytePattern = /`first \$\{([\w$]+)\} lines \(or \$\{([\w$]+)\} byte limit\)`/g;
  const lbMatch = lineBytePattern.exec(code);
  if (lbMatch) {
    const lineVar = lbMatch[1];
    const byteVar = lbMatch[2];

    // Replace var lineVar = 200;
    const lineDecl = new RegExp(`(var\\s+${escapeRegex(lineVar)}\\s*=\\s*)200(\\s*;)`, "g");
    const newCode = code.replace(lineDecl, `$1${cfg("max_lines", "200")}$2`);
    if (newCode !== code) { code = newCode; count++; }

    // Replace var byteVar = 4096;
    const byteDecl = new RegExp(`(var\\s+${escapeRegex(byteVar)}\\s*=\\s*)4096(\\s*;)`, "g");
    const newCode2 = code.replace(byteDecl, `$1${cfg("max_bytes", "4096")}$2`);
    if (newCode2 !== code) { code = newCode2; count++; }
  }

  // Transform 3 & 4: File scan limits
  // Find .slice(0, ... with mtimeMs context
  const sliceWithMtime = code.indexOf("mtimeMs");
  if (sliceWithMtime !== -1) {
    // Look for .slice(0, COND ? VAR : VAR) within ~500 chars of mtimeMs
    const window = code.substring(Math.max(0, sliceWithMtime - 500), sliceWithMtime + 500);

    // Pattern B: structuredMode ? IJY : UAY (ternary in .slice)
    const ternaryPattern = /\.slice\(0,\s*([\w$]+)\s*\?\s*([\w$]+)\s*:\s*([\w$]+)\s*\)/g;
    let tm;
    while ((tm = ternaryPattern.exec(window)) !== null) {
      const trueVar = tm[2];
      const falseVar = tm[3];

      // Find declarations: trueVar = 500, falseVar = 200
      const trueDecl = new RegExp(`(var\\s+${escapeRegex(trueVar)}\\s*=\\s*)500(\\s*;)`, "g");
      const newCode3 = code.replace(trueDecl, `$1${cfg("max_files_structured", "500")}$2`);
      if (newCode3 !== code) { code = newCode3; count++; }

      const falseDecl = new RegExp(`(var\\s+${falseVar}\\s*=\\s*)200(\\s*;)`, "g");
      const newCode4 = code.replace(falseDecl, `$1${cfg("max_files", "200")}$2`);
      if (newCode4 !== code) { code = newCode4; count++; }
    }
  }

  // Transform 5: Recall limit (.slice(0, 5) with .has( context)
  const hasIdx = code.indexOf(".has(");
  if (hasIdx !== -1) {
    // Search for .slice(0, 5) near .has(
    const recallWindow = code.substring(Math.max(0, hasIdx - 300), hasIdx + 300);
    const recallSliceMatch = recallWindow.match(/\.slice\(0,\s*5\s*\)/);
    if (recallSliceMatch) {
      // Find the absolute position in the full code
      const absPos = code.indexOf(".slice(0, 5)", Math.max(0, hasIdx - 300));
      if (absPos !== -1) {
        code = code.substring(0, absPos) + `.slice(0, ${cfg("max_recall", "5")})` + code.substring(absPos + ".slice(0, 5)".length);
        count++;
      }
    }
  }

  // Transform 4: "up to 5" prompt string
  const upToIdx = code.indexOf("up to 5");
  if (upToIdx !== -1) {
    code = code.substring(0, upToIdx) +
      `up to \${${cfg("max_recall", '"5"')}} ` +
      code.substring(upToIdx + 8);  // "up to 5" is 8 chars; add trailing space
    count++;
  }

  // Transforms 6 & 7: Selector model and max_tokens
  // Both are in a function containing "memories relevant to"
  const memRelevantIdx = code.indexOf("memories relevant to");
  if (memRelevantIdx !== -1) {
    // Find the containing function block
    let funcBraceStart = -1;
    let depth = 0;
    for (let i = memRelevantIdx; i >= 0; i--) {
      if (code[i] === '}') depth++;
      if (code[i] === '{') { if (depth === 0) { funcBraceStart = i; break; } depth--; }
    }
    if (funcBraceStart !== -1) {
      let funcBraceEnd = -1;
      depth = 1;
      for (let i = funcBraceStart + 1; i < code.length; i++) {
        if (code[i] === '{') depth++;
        if (code[i] === '}') { depth--; if (depth === 0) { funcBraceEnd = i; break; } }
      }
      if (funcBraceEnd !== -1) {
        const funcBlock = code.substring(funcBraceStart, funcBraceEnd + 1);

        // Transform 6: model: CALL() → model: __getModConfig__(...) ?? CALL()
        const modelPattern = /model:\s*([\w$]+)\(\)/g;
        let modelMatch;
        let newFuncBlock = funcBlock;
        while ((modelMatch = modelPattern.exec(funcBlock)) !== null) {
          const callExpr = `${modelMatch[1]}()`;
          newFuncBlock = newFuncBlock.replace(
            `model: ${callExpr}`,
            `model: ${cfg("selector_model", callExpr)}`
          );
        }
        if (newFuncBlock !== funcBlock) {
          code = code.substring(0, funcBraceStart) + newFuncBlock + code.substring(funcBraceEnd + 1);
          count++;
        }

        // Transform 7: max_tokens: 256 → max_tokens: __getModConfig__(...) ?? 256
        // Re-derive the block boundaries since code may have shifted
        let fbs2 = -1; depth = 0;
        for (let i = memRelevantIdx; i >= 0; i--) {
          if (code[i] === '}') depth++;
          if (code[i] === '{') { if (depth === 0) { fbs2 = i; break; } depth--; }
        }
        if (fbs2 !== -1) {
          let fbe2 = -1; depth = 1;
          for (let i = fbs2 + 1; i < code.length; i++) {
            if (code[i] === '{') depth++;
            if (code[i] === '}') { depth--; if (depth === 0) { fbe2 = i; break; } }
          }
          if (fbe2 !== -1) {
            const block2 = code.substring(fbs2, fbe2 + 1);
            const maxTokensReplaced = block2.replace(
              /max_tokens:\s*256\b/,
              `max_tokens: ${cfg("selector_max_tokens", "256")}`
            );
            if (maxTokensReplaced !== block2) {
              code = code.substring(0, fbs2) + maxTokensReplaced + code.substring(fbe2 + 1);
              count++;
            }
          }
        }
      }
    }
  }

  if (count === 0) return { code, changed: 0 };

  return { code, changed: count };
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-set-memory-limits.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const { code: output, changed } = transform(code);

  if (changed === 0) {
    console.error("No matching memory limit patterns found; nothing changed.");
  } else {
    console.error(`Applied ${changed} memory configuration change(s).`);
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

#!/usr/bin/env node
// Retain the upstream limits when the mod is disabled; configured overrides and cached capabilities apply only when enabled.

const fs = require("fs");
const path = require("path");

const MOD_ID = "set_model_limits";

const HELPER_CODE = `
var __modelCaps_cache__ = null;
var __modelCaps_cache_time__ = 0;
function __modelCaps__(model) {
  var fs = __REQUIRE_FN__("fs");
  var path = __REQUIRE_FN__("path");
  var os = __REQUIRE_FN__("os");
  var now = Date.now();
  if (!__modelCaps_cache__ || (now - __modelCaps_cache_time__) >= 2000) {
    try {
      var p = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "cache", "model-capabilities.json");
      var raw = JSON.parse(fs.readFileSync(p, "utf8"));
      var list = (raw && raw.models) || [];
      var map = {};
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (!m || !m.id) continue;
        var ctx = m.max_input_tokens || m.context_window || (m.limit && m.limit.input);
        var out = m.max_tokens || m.max_output || (m.limit && m.limit.output);
        if (!ctx && !out) continue;
        map[m.id] = { context: ctx || null, output: out || null };
      }
      __modelCaps_cache__ = map;
    } catch (e) {
      __modelCaps_cache__ = {};
    }
    __modelCaps_cache_time__ = now;
  }
  if (!model) return null;
  var entry = __modelCaps_cache__[model];
  if (entry === undefined) {
    for (var k in __modelCaps_cache__) {
      if (model.indexOf(k) >= 0) { entry = __modelCaps_cache__[k]; break; }
    }
  }
  return entry || null;
}
`;

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find the containing brace block for a position in code.
 * Returns { start, end } or null if no enclosing braces.
 */
function findEnclosingBlock(code, pos) {
  let braceStart = -1;
  let depth = 0;
  for (let i = pos; i >= 0; i--) {
    if (code[i] === '}') depth++;
    if (code[i] === '{') { if (depth === 0) { braceStart = i; break; } depth--; }
  }
  if (braceStart === -1) return null;

  depth = 1;
  let braceEnd = -1;
  for (let i = braceStart + 1; i < code.length; i++) {
    if (code[i] === '{') depth++;
    if (code[i] === '}') { depth--; if (depth === 0) { braceEnd = i; break; } }
  }
  if (braceEnd === -1) return null;

  return { start: braceStart, end: braceEnd };
}

/**
 * Four transforms:
 *
 * T1: Inject __modelCaps__ helper alongside __modsLoad__ in the CJS wrapper.
 *
 * T2: CXH output override — function returning { default: X, upperLimit: Y }
 *     that reads .max_tokens. Insert override before the return.
 *
 * T3: w37 context override — function with multiple `return 1000000` and a
 *     regex test on the first param. Insert override at top of function body.
 *
 * T4: Effective output override — function returning `.effective` from a call
 *     with "CLAUDE_CODE_MAX_OUTPUT_TOKENS". Insert override at top.
 */
function transform(code) {
  if (typeof code !== "string") return { code: "", changed: 0 };

  // Idempotency: check for our marker comments
  if (code.includes("model_limits_out") && code.includes("model_limits_ctx")) {
    return { code, changed: 0 };
  }

  let count = 0;
  const edits = []; // { index, type: "insert_before"|"insert_after"|"replace", text }

  // --- T1: Inject __modelCaps__ helper ---
  if (!code.includes("function __modelCaps__(")) {
    // Find the CJS wrapper and the require function name
    const wrapperPattern = /\(function\s*\(\s*exports\s*,\s*([\w$]+)\s*,\s*module\s*,\s*__filename\s*,\s*__dirname\s*\)\s*\{/g;
    const wrapperMatch = wrapperPattern.exec(code);
    if (wrapperMatch) {
      const requireFnName = wrapperMatch[1];
      const resolvedHelper = HELPER_CODE.replace(/__REQUIRE_FN__/g, requireFnName);

      // Find insertion point: after __modsLoad__/__isModEnabled__/__getModConfig__
      const wrapperBodyStart = code.indexOf("{", wrapperMatch.index) + 1;
      const wrapperBody = code.substring(wrapperBodyStart);

      // Find the last helper function declaration
      let insertOffset = 0;
      const helperNames = ["__modsLoad__", "__isModEnabled__", "__getModConfig__"];
      for (const hName of helperNames) {
        const hIdx = wrapperBody.indexOf(`function ${hName}`);
        if (hIdx !== -1) {
          // Find the end of this function
          const funcBodyStart = wrapperBody.indexOf("{", hIdx);
          if (funcBodyStart !== -1) {
            let depth = 1;
            for (let i = funcBodyStart + 1; i < wrapperBody.length; i++) {
              if (wrapperBody[i] === '{') depth++;
              if (wrapperBody[i] === '}') { depth--; if (depth === 0) { insertOffset = Math.max(insertOffset, i + 1); break; } }
            }
          }
        }
      }

      edits.push({
        index: wrapperBodyStart + insertOffset,
        type: "insert_after",
        text: "\n" + resolvedHelper + "\n"
      });
      count++;
    }
  }

  // --- T2: CXH output override ---
  // Find function that: (a) reads .max_tokens, (b) returns { default: X, upperLimit: Y }
  // Pattern: return { default: IDENT, upperLimit: IDENT };
  // preceded by .max_tokens access
  const maxTokensIdx = code.indexOf(".max_tokens");
  if (maxTokensIdx !== -1) {
    const block = findEnclosingBlock(code, maxTokensIdx);
    if (block) {
      const funcCode = code.substring(block.start, block.end + 1);

      // Find return { default: X, upperLimit: Y }
      const returnPattern = /return\s*\{\s*default\s*:\s*([\w$]+)\s*,\s*upperLimit\s*:\s*([\w$]+)\s*\}/;
      const retMatch = funcCode.match(returnPattern);

      if (retMatch) {
        // Find the function's parameter name (first param)
        const fnHeaderEnd = code.indexOf("{", block.start);
        const fnHeader = code.substring(Math.max(0, block.start - 100), fnHeaderEnd);
        const paramMatch = fnHeader.match(/\(\s*([\w$]+)\s*\)\s*$/);
        const paramName = paramMatch ? paramMatch[1] : "H";

        const guard = `typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}") && typeof __modelCaps__ === "function"`;
        const override = `/* model_limits_out */ if (${guard}) { var __mcOut = __modelCaps__(${paramName}); if (__mcOut && __mcOut.output) return __mcOut.output; } `;

        // Insert before the return statement
        const returnAbsIdx = code.indexOf(retMatch[0], block.start);
        if (returnAbsIdx !== -1) {
          edits.push({ index: returnAbsIdx, type: "insert_before", text: override });
          count++;
        }
      }
    }
  }

  // --- T3: w37 context override ---
  // Function containing multiple `return 1000000` statements.
  const return100kPattern = /return\s+1000000\s*;/g;
  const return100kMatches = [...code.matchAll(return100kPattern)];

  // Strategy: find each `return 1000000`, then find its containing function body
  // (not the innermost if-block). Group by function, patch the one with >=2.
  {
    const funcReturns = new Map(); // funcBodyStart → { block, count, paramName }

    for (const m of return100kMatches) {
      // Walk up through nested blocks to find the function-level block
      let pos = m.index;
      let funcBlock = null;
      let depth = 0;

      // Scan backward to find the function keyword, then its opening brace
      let scanPos = pos;
      while (scanPos > 0) {
        // Find the nearest opening brace that's a function body
        let braceStart = -1;
        let d = 0;
        for (let i = scanPos; i >= 0; i--) {
          if (code[i] === '}') d++;
          if (code[i] === '{') { if (d === 0) { braceStart = i; break; } d--; }
        }
        if (braceStart === -1) break;

        // Check if this brace belongs to a function
        const before = code.substring(Math.max(0, braceStart - 200), braceStart);
        if (/function\s*[\w$]*\s*\([^)]*\)\s*$/.test(before) ||
            /=>\s*$/.test(before)) {
          // This is a function body brace
          funcBlock = braceStart;
          break;
        }
        // Move past this block and keep searching outward
        scanPos = braceStart - 1;
      }

      if (funcBlock === null) continue;

      if (!funcReturns.has(funcBlock)) {
        // Find the matching closing brace
        let braceEnd = -1;
        let d = 1;
        for (let i = funcBlock + 1; i < code.length; i++) {
          if (code[i] === '{') d++;
          if (code[i] === '}') { d--; if (d === 0) { braceEnd = i; break; } }
        }

        // Get param name: look at the text just before this brace
        // which should be the function header
        const fnHeader = code.substring(Math.max(0, funcBlock - 200), funcBlock);
        const paramMatch = fnHeader.match(/\(\s*([\w$]+)\s*[),]/);
        // Use the LAST match to handle nested functions (the innermost one wins)
        const allParamMatches = [...fnHeader.matchAll(/\(\s*([\w$]+)\s*[),]/g)];
        const paramName = allParamMatches.length > 0 ? allParamMatches[allParamMatches.length - 1][1] : "H";

        funcReturns.set(funcBlock, { blockStart: funcBlock, blockEnd: braceEnd, count: 0, paramName });
      }
      funcReturns.get(funcBlock).count++;
    }

    for (const [, info] of funcReturns) {
      if (info.count < 2) continue;
      if (info.blockEnd === -1) continue;

      const funcCode = code.substring(info.blockStart, info.blockEnd + 1);
      if (funcCode.includes("model_limits_ctx")) continue;
      if (funcCode.includes("upperLimit")) continue; // Skip CXH function

      const guard = `typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}") && typeof __modelCaps__ === "function"`;
      const override = `\n  /* model_limits_ctx */ if (${guard}) { var __mcCtx = __modelCaps__(${info.paramName}); if (__mcCtx && __mcCtx.context) return __mcCtx.context; } \n`;

      // Insert at the beginning of the function body (after opening brace)
      edits.push({ index: info.blockStart + 1, type: "insert_after", text: override });
      count++;
      break; // Only patch the first matching function
    }
  }

  // --- T4: Effective output override ---
  // Function that returns CALL(..., "CLAUDE_CODE_MAX_OUTPUT_TOKENS", ...).effective
  const effPattern = /return\s+([\w$]+)\(\s*"CLAUDE_CODE_MAX_OUTPUT_TOKENS"[^)]*\)\s*\.effective\s*;/g;
  let effMatch;
  while ((effMatch = effPattern.exec(code)) !== null) {
    const block = findEnclosingBlock(code, effMatch.index);
    if (!block) continue;

    const funcCode = code.substring(block.start, block.end + 1);
    if (funcCode.includes("model_limits_out_eff")) continue;

    // Find the function's parameter name
    const fnHeaderEnd = code.indexOf("{", block.start);
    const fnHeader = code.substring(Math.max(0, block.start - 100), fnHeaderEnd);
    const paramMatch = fnHeader.match(/\(\s*([\w$]+)\s*\)/);
    const paramName = paramMatch ? paramMatch[1] : "H";

    const guard = `typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}") && typeof __modelCaps__ === "function"`;
    const override = `/* model_limits_out_eff */ if (${guard}) { var __mcEff = __modelCaps__(${paramName}); if (__mcEff && __mcEff.output) return __mcEff.output; } `;

    // Insert at the beginning of the function body
    edits.push({ index: block.start + 1, type: "insert_after", text: "\n  " + override + "\n" });
    count++;
    break; // Only patch the first matching function
  }

  // Apply edits in reverse order (descending index) to maintain offsets
  edits.sort((a, b) => b.index - a.index);

  for (const edit of edits) {
    if (edit.type === "insert_before") {
      code = code.substring(0, edit.index) + edit.text + code.substring(edit.index);
    } else if (edit.type === "insert_after") {
      code = code.substring(0, edit.index) + edit.text + code.substring(edit.index);
    }
  }

  if (count === 0) return { code, changed: 0 };

  return { code, changed: count };
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-set-model-limits.cjs <input.js> [output.js]");
    process.exit(1);
  }
  const inputCode = fs.readFileSync(path.resolve(inputFile), "utf8");
  const { code: output, changed } = transform(inputCode);
  console.error(`set_model_limits: ${changed} change(s).`);
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

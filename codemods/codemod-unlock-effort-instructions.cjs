#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const MOD_ID = "unlock_effort_instructions";

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Code-split compatible version: the ultrathink detector function and its
 * call site are in the same chunk, but effort support check may be elsewhere.
 *
 * Strategy:
 * 1. Find the ultrathink detector function (contains type: "ultrathink_effort")
 * 2. Inject a mod guard that returns extended_thinking instructions when enabled
 * 3. Modify the call site to pass model + effort params
 *
 * If effort support check / effort getter / settings getter aren't in the same
 * chunk, we skip those discoveries and use inline runtime detection instead.
 */
function transform(code) {
  if (typeof code !== "string") return { code: "", changed: 0 };

  // Idempotency
  if (code.includes("_patchResults") && code.includes("_patchEffort")) {
    return { code, changed: 0 };
  }

  // --- Discovery ---

  // Ultrathink detector: function whose return contains type: "ultrathink_effort"
  const ultraIdx = code.indexOf('type: "ultrathink_effort"');
  if (ultraIdx === -1) {
    return { code, changed: 0 };
  }

  // Find the containing function
  let ultraFn = null;
  let ultraParam = null;
  {
    let searchFrom = ultraIdx;
    while (searchFrom > 0) {
      const fnIdx = code.lastIndexOf("function ", searchFrom);
      if (fnIdx === -1) break;

      const fnHeader = code.substring(fnIdx, fnIdx + 200);
      const fnMatch = fnHeader.match(/^function\s+([\w$]+)\s*\(([^)]*)\)\s*\{/);
      if (fnMatch) {
        const fnBodyStart = fnIdx + fnMatch[0].length;
        const searchEnd = Math.min(code.length, fnBodyStart + 5000);
        const fnBody = code.substring(fnIdx, searchEnd);
        if (fnBody.includes('type: "ultrathink_effort"')) {
          ultraFn = fnMatch[1];
          ultraParam = fnMatch[2].trim();
          break;
        }
      }
      searchFrom = fnIdx - 1;
    }
  }

  if (!ultraFn) {
    return { code, changed: 0 };
  }

  // Effort getter: function that accesses .effortLevel
  let effortGetterFn = null;
  let effortGetterParams = 0;
  const effortLevelIdx = code.indexOf(".effortLevel");
  if (effortLevelIdx !== -1) {
    let searchFrom = effortLevelIdx;
    while (searchFrom > 0) {
      const fnIdx = code.lastIndexOf("function ", searchFrom);
      if (fnIdx === -1) break;

      const fnHeader = code.substring(fnIdx, fnIdx + 200);
      const fnMatch = fnHeader.match(/^function\s+([\w$]+)\s*\(([^)]*)\)\s*\{/);
      if (fnMatch) {
        const searchEnd = Math.min(code.length, fnIdx + 5000);
        const fnBody = code.substring(fnIdx, searchEnd);
        if (fnBody.includes(".effortLevel")) {
          effortGetterFn = fnMatch[1];
          effortGetterParams = fnMatch[2].trim() ? fnMatch[2].split(",").length : 0;
          break;
        }
      }
      searchFrom = fnIdx - 1;
    }
  }

  // Effort support check: function containing "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT"
  // This may be in a different chunk — optional discovery.
  let effortSupportFn = null;
  {
    let searchFrom = 0;
    while (true) {
      const idx = code.indexOf("CLAUDE_CODE_ALWAYS_ENABLE_EFFORT", searchFrom);
      if (idx === -1) break;
      searchFrom = idx + 1;

      const lineStart = code.lastIndexOf('\n', idx) + 1;
      const linePrefix = code.substring(lineStart, idx).trim();
      if (linePrefix.length === 0 || /^[A-Z_]+$/.test(linePrefix)) continue;

      let fnSearchFrom = idx;
      while (fnSearchFrom > 0) {
        const fnIdx = code.lastIndexOf("function ", fnSearchFrom);
        if (fnIdx === -1) break;

        const fnHeader = code.substring(fnIdx, fnIdx + 200);
        const fnMatch = fnHeader.match(/^function\s+([\w$]+)\s*\(([^)]*)\)\s*\{/);
        if (fnMatch) {
          const searchEnd = Math.min(code.length, fnIdx + 2000);
          const fnBody = code.substring(fnIdx, searchEnd);
          if (fnBody.includes("CLAUDE_CODE_ALWAYS_ENABLE_EFFORT")) {
            effortSupportFn = fnMatch[1];
            break;
          }
        }
        fnSearchFrom = fnIdx - 1;
      }
      if (effortSupportFn) break;
    }
  }

  // Settings getter: found from canonical call site — optional
  let settingsGetterFn = null;
  if (effortGetterParams > 0 && effortGetterFn) {
    const settingsPattern = /settings:\s*([\w$]+)\(\)/g;
    let sm;
    while ((sm = settingsPattern.exec(code)) !== null) {
      const nearby = code.substring(Math.max(0, sm.index - 300), sm.index + 100);
      if (nearby.includes("cli:") || nearby.includes(effortGetterFn)) {
        settingsGetterFn = sm[1];
        break;
      }
    }
  }

  console.error(`Discovered: ultra=${ultraFn}, effortGetter=${effortGetterFn || "n/a"} (${effortGetterParams} params), effortSupport=${effortSupportFn || "n/a"}, settingsGetter=${settingsGetterFn || "n/a"}`);

  // --- Transform 1: Modify ultrathink detector function ---

  const modGuard = `typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}")`;

  // Build effort getter call
  let effortGetterCall;
  if (effortGetterFn && effortGetterParams === 0) {
    effortGetterCall = `${effortGetterFn}()`;
  } else if (effortGetterFn && effortGetterParams > 0 && settingsGetterFn) {
    effortGetterCall = `${effortGetterFn}({ cli: {}, env: process.env, settings: ${settingsGetterFn}() })`;
  } else {
    // Can't discover effort getter — use runtime detection
    effortGetterCall = `undefined`;
  }

  // Build effort support check
  let effortSupportCheck;
  if (effortSupportFn) {
    effortSupportCheck = `${effortSupportFn}(model)`;
  } else {
    // No effort support fn in this chunk — when mod is enabled, always include
    effortSupportCheck = `true`;
  }

  // Replace function signature
  const oldSig = `function ${ultraFn}(${ultraParam}) {`;
  const newSig = `function ${ultraFn}(${ultraParam}, model, effort) {`;
  if (!code.includes(oldSig)) {
    return { code, changed: 0 };
  }
  code = code.replace(oldSig, newSig);

  // Find the return statement containing type: "ultrathink_effort"
  const returnPattern = /return\s*\[\s*\{\s*type:\s*"ultrathink_effort"[\s\S]*?\}\s*\]\s*;/;
  const returnMatch = returnPattern.exec(code);
  if (!returnMatch) {
    return { code, changed: 0 };
  }

  const arrayContent = returnMatch[0].replace(/^return\s*/, "").replace(/;\s*$/, "");

  const newBody = `var _patchResults = [];
  var _patchEffort = effort !== undefined ? effort : ${effortGetterCall};
  if (${modGuard}) {
    _patchResults.push({ type: "extended_thinking", level: _patchEffort, model: model });
    if (${effortSupportCheck}) {
      _patchResults.push(...${arrayContent});
    }
  }
  _patchResults.push(...${arrayContent});
  return _patchResults;`;

  code = code.substring(0, returnMatch.index) + newBody + code.substring(returnMatch.index + returnMatch[0].length);

  // --- Transform 2: Modify call site ---

  // Find the context variable near the ultrathink_effort Ya() call site
  // In code-split, the call is like: Ya("ultrathink_effort", () => Promise.resolve(OUo(e)))
  // We need to add model + effort args to the OUo call.

  // Strategy: find the Ya("ultrathink_effort" call and extract the arg to OUo
  const yaPattern = new RegExp(`Ya\\("ultrathink_effort",\\s*\\(\\)\\s*=>\\s*Promise\\.resolve\\(${escapeRegex(ultraFn)}\\(([^)]+)\\)\\)`);
  const yaMatch = yaPattern.exec(code);

  if (yaMatch) {
    // Replace Ya("ultrathink_effort", () => Promise.resolve(OUo(e)))
    // with   Ya("ultrathink_effort", () => Promise.resolve(OUo(e, n.options.mainLoopModel, n.getAppState()?.effortValue)))
    const yaArg = yaMatch[1];
    // Try to find the context variable (n in the example above) from the surrounding code
    // Look for .options.mainLoopModel in the same function scope
    const scopeStart = Math.max(0, yaMatch.index - 2000);
    const scopeEnd = Math.min(code.length, yaMatch.index + 500);
    const scope = code.substring(scopeStart, scopeEnd);

    const mainLoopModelPattern = /([\w$]+)\.options\.mainLoopModel/;
    const mlmMatch = scope.match(mainLoopModelPattern);
    let ctxVar = mlmMatch ? mlmMatch[1] : null;

    // If no mainLoopModel in scope, try the broader chunk
    if (!ctxVar) {
      // Try to find any .options.mainLoopModel reference
      const broaderPattern = /([\w$]+)\.options\.mainLoopModel/g;
      let bm;
      while ((bm = broaderPattern.exec(code)) !== null) {
        const nearby = code.substring(Math.max(0, bm.index - 500), bm.index + 500);
        if (nearby.includes(ultraFn)) {
          ctxVar = bm[1];
          break;
        }
      }
    }

    if (ctxVar) {
      const oldYa = yaMatch[0];
      const newYa = `Ya("ultrathink_effort", () => Promise.resolve(${ultraFn}(${yaArg}, ${ctxVar}.options.mainLoopModel, ${ctxVar}.getAppState?.()?.effortValue)))`;
      code = code.replace(oldYa, newYa);
      console.error(`Modified call site with ctx=${ctxVar}`);
    } else {
      // Fallback: just pass model=undefined, effort=undefined — the mod guard
      // still works for the extended_thinking injection
      const oldYa = yaMatch[0];
      const newYa = `Ya("ultrathink_effort", () => Promise.resolve(${ultraFn}(${yaArg}, undefined, undefined)))`;
      code = code.replace(oldYa, newYa);
      console.error(`Modified call site without mainLoopModel context`);
    }
  } else {
    // Try the monolithic pattern: look for ultraFn(param) elsewhere
    const callPattern = new RegExp(`${escapeRegex(ultraFn)}\\s*\\(([\\w$]+)\\)`, "g");
    let callReplaced = false;

    // Find .options.mainLoopModel context
    const ctxPattern = /([\w$]+)\.options\.mainLoopModel/g;
    let ctxVar = null;
    let m;
    while ((m = ctxPattern.exec(code)) !== null) {
      const nearby = code.substring(Math.max(0, m.index - 500), m.index + 500);
      if (nearby.includes(ultraFn)) {
        ctxVar = m[1];
        break;
      }
    }

    code = code.replace(callPattern, (match, arg) => {
      if (callReplaced) return match;
      callReplaced = true;
      if (ctxVar) {
        return `${ultraFn}(${arg}, ${ctxVar}.options.mainLoopModel, ${ctxVar}.getAppState?.()?.effortValue)`;
      }
      return `${ultraFn}(${arg}, undefined, undefined)`;
    });

    if (!callReplaced) {
      console.error(`unlock_effort_instructions: no call site found for ${ultraFn}`);
    }
  }

  return { code, changed: 2 };
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-unlock-effort-instructions.cjs <input.js> [output.js]");
    console.error("If output.js is omitted, writes to stdout.");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  if (!fs.existsSync(inputPath)) {
    console.error(`Error: Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const code = fs.readFileSync(inputPath, "utf8");

  let result;
  try {
    result = transform(code);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  console.error(`Patched ${result.changed} location(s) (function body + call site).`);

  if (outputFile) {
    const outputPath = path.resolve(outputFile);
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(outputPath, result.code, "utf8");
  } else {
    process.stdout.write(result.code);
  }
}

module.exports = { transform };

if (require.main === module) {
  main();
}

#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const MOD_ID = "unlock_effort_instructions";

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Discover and transform the effort/ultrathink system:
 *
 * 1. Discover minified names:
 *    - Ultrathink detector: returns [{ type: "ultrathink_effort", ... }]
 *    - Effort getter: accesses .effortLevel
 *    - Effort support: contains "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT"
 *    - Settings getter: found from canonical call site { settings: GETTER() }
 *
 * 2. Modify the ultrathink detector: add model+effort params, insert override logic.
 * 3. Transform the call site: add mainLoopModel + effortValue arguments.
 */
function transform(code) {
  if (typeof code !== "string") return { code: "", changed: 0 };

  // Fail-closed: if already patched, throw
  if (code.includes("_patchResults") && code.includes("_patchEffort")) {
    throw new Error("Already patched — re-application would produce duplicate code.");
  }

  // --- Discovery ---

  // Ultrathink detector: function whose return contains type: "ultrathink_effort"
  // Key: look for `type: "ultrathink_effort"` preceded by a function declaration
  // We find the function by scanning backward from the string to the nearest function header
  const ultraIdx = code.indexOf('type: "ultrathink_effort"');
  if (ultraIdx === -1) {
    throw new Error("Could not find ultrathink detector function (contains 'ultrathink_effort')");
  }

  // Find the containing function
  let ultraFn = null;
  let ultraParam = null;
  {
    // Find the nearest function keyword before this position
    let searchFrom = ultraIdx;
    while (searchFrom > 0) {
      const fnIdx = code.lastIndexOf("function ", searchFrom);
      if (fnIdx === -1) break;

      // Parse: function NAME(PARAMS) {
      const fnHeader = code.substring(fnIdx, fnIdx + 200);
      const fnMatch = fnHeader.match(/^function\s+([\w$]+)\s*\(([^)]*)\)\s*\{/);
      if (fnMatch) {
        // Verify this function actually contains the ultrathink_effort return
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
    throw new Error("Could not find ultrathink detector function (contains 'ultrathink_effort')");
  }

  // Effort getter: function that accesses .effortLevel
  const effortLevelIdx = code.indexOf(".effortLevel");
  if (effortLevelIdx === -1) {
    throw new Error("Could not find effort level getter function (returns call on 'effortLevel')");
  }

  let effortGetterFn = null;
  let effortGetterParams = 0;
  {
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

  if (!effortGetterFn) {
    throw new Error("Could not find effort level getter function (returns call on 'effortLevel')");
  }

  // Effort support check: function containing "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT"
  // There may be multiple occurrences — the first is typically a constants declaration
  // like CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: () => Gjc. We need the one inside a function
  // that uses it in a conditional (rt(process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT)).
  let effortSupportFn = null;
  {
    let searchFrom = 0;
    while (true) {
      const idx = code.indexOf("CLAUDE_CODE_ALWAYS_ENABLE_EFFORT", searchFrom);
      if (idx === -1) break;
      searchFrom = idx + 1;

      // Skip occurrences that are part of a constants/object declaration
      // (e.g. "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: () => Gjc,")
      const lineStart = code.lastIndexOf('\n', idx) + 1;
      const linePrefix = code.substring(lineStart, idx).trim();
      // If the line starts with the env var name itself, it's likely a declaration
      if (linePrefix.length === 0 || /^[A-Z_]+$/.test(linePrefix)) continue;

      // This occurrence is inside code — find the containing function
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

  if (!effortSupportFn) {
    throw new Error("Could not find effort support check function ('CLAUDE_CODE_ALWAYS_ENABLE_EFFORT')");
  }

  // Settings getter: found from canonical call site
  let settingsGetterFn = null;
  if (effortGetterParams > 0) {
    // Look for { settings: GETTER() } near a call to effortGetterFn or near "cli:"
    const settingsPattern = /settings:\s*([\w$]+)\(\)/g;
    let sm;
    while ((sm = settingsPattern.exec(code)) !== null) {
      const nearby = code.substring(Math.max(0, sm.index - 300), sm.index + 100);
      if (nearby.includes("cli:") || nearby.includes(effortGetterFn)) {
        settingsGetterFn = sm[1];
        break;
      }
    }

    if (!settingsGetterFn) {
      throw new Error(
        `Effort getter ${effortGetterFn} takes a state argument (${effortGetterParams} params) but ` +
        `no canonical call site ({..., settings: <getter>()}) was found to derive the settings getter. ` +
        `Refusing to emit a bare call that would crash at runtime.`
      );
    }
  }

  console.error(`Discovered: ultra=${ultraFn}, effortGetter=${effortGetterFn} (${effortGetterParams} params), effortSupport=${effortSupportFn}, settingsGetter=${settingsGetterFn || "n/a"}`);

  // --- Transform 1: Modify ultrathink detector function ---

  let effortGetterCall;
  if (effortGetterParams === 0) {
    effortGetterCall = `${effortGetterFn}()`;
  } else {
    effortGetterCall = `${effortGetterFn}({ cli: {}, env: process.env, settings: ${settingsGetterFn}() })`;
  }

  const modGuard = `typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}")`;

  // Replace function signature
  const oldSig = `function ${ultraFn}(${ultraParam}) {`;
  const newSig = `function ${ultraFn}(${ultraParam}, model, effort) {`;
  if (!code.includes(oldSig)) {
    throw new Error(`Could not find function declaration for ${ultraFn}`);
  }
  code = code.replace(oldSig, newSig);

  // Find the return statement containing type: "ultrathink_effort"
  const returnPattern = /return\s*\[\s*\{\s*type:\s*"ultrathink_effort"[\s\S]*?\}\s*\]\s*;/;
  const returnMatch = returnPattern.exec(code);
  if (!returnMatch) {
    throw new Error("Could not find the return statement in the ultrathink detector");
  }

  const arrayContent = returnMatch[0].replace(/^return\s*/, "").replace(/;\s*$/, "");

  const newBody = `var _patchResults = [];
  var _patchEffort = effort !== undefined ? effort : ${effortGetterCall};
  if (${modGuard}) {
    _patchResults.push({ type: "extended_thinking", level: _patchEffort, model: model });
    if (${effortSupportFn}(model)) {
      _patchResults.push(...${arrayContent});
    }
  }
  _patchResults.push(...${arrayContent});
  return _patchResults;`;

  code = code.substring(0, returnMatch.index) + newBody + code.substring(returnMatch.index + returnMatch[0].length);

  // --- Transform 2: Modify call site ---

  // Find the context variable with .options.mainLoopModel
  // The call site is in the same function as the mainLoopModel access.
  // Find each occurrence of .options.mainLoopModel and check if the enclosing
  // function block also contains a call to ultraFn.
  const ctxPattern = /([\w$]+)\.options\.mainLoopModel/g;
  let ctxVar = null;
  let m;
  while ((m = ctxPattern.exec(code)) !== null) {
    // Find the containing function block
    let funcBraceStart = -1;
    let depth = 0;
    for (let i = m.index; i >= 0; i--) {
      if (code[i] === '}') depth++;
      if (code[i] === '{') { if (depth === 0) { funcBraceStart = i; break; } depth--; }
    }
    if (funcBraceStart === -1) continue;

    // Walk outward: the mainLoopModel might be inside a nested function,
    // so we need to check each enclosing function level
    let checkPos = funcBraceStart;
    while (checkPos >= 0) {
      // Find the function-level block containing this brace
      let fnBraceStart = -1;
      depth = 0;
      for (let i = checkPos; i >= 0; i--) {
        if (code[i] === '}') depth++;
        if (code[i] === '{') { if (depth === 0) { fnBraceStart = i; break; } depth--; }
      }
      if (fnBraceStart === -1) break;

      // Check if this is a function body (has function/=> before the brace)
      const before = code.substring(Math.max(0, fnBraceStart - 200), fnBraceStart);
      if (/function\s*[\w$]*\s*\([^)]*\)\s*$/.test(before) || /=>\s*$/.test(before)) {
        // Find the matching closing brace
        let fnBraceEnd = -1;
        depth = 1;
        for (let i = fnBraceStart + 1; i < code.length; i++) {
          if (code[i] === '{') depth++;
          if (code[i] === '}') { depth--; if (depth === 0) { fnBraceEnd = i; break; } }
        }
        if (fnBraceEnd !== -1) {
          const fnBlock = code.substring(fnBraceStart, fnBraceEnd + 1);
          if (fnBlock.includes(ultraFn + "(") || fnBlock.includes(ultraFn + " (")) {
            ctxVar = m[1];
            break;
          }
        }
        break; // Don't keep walking up — we found the function level
      }
      // Not a function brace — walk outward
      checkPos = fnBraceStart - 1;
    }
    if (ctxVar) break;
  }

  if (!ctxVar) {
    throw new Error("Could not find X.options.mainLoopModel reference in call site scope");
  }

  // Replace the call: ultraFn(param) → ultraFn(param, ctxVar.options.mainLoopModel, ctxVar.getAppState().effortValue)
  const callPattern = new RegExp(`${escapeRegex(ultraFn)}\\s*\\(([\\w$]+)\\)`, "g");
  let callReplaced = false;
  code = code.replace(callPattern, (match, arg) => {
    if (callReplaced) return match;
    callReplaced = true;
    return `${ultraFn}(${arg}, ${ctxVar}.options.mainLoopModel, ${ctxVar}.getAppState().effortValue)`;
  });

  if (!callReplaced) {
    throw new Error(`Expected exactly one call site for ${ultraFn}, found none.`);
  }

  console.error(`Discovered mainLoopModel context object: ${ctxVar}`);

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

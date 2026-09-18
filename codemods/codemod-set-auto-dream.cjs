#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const MOD_ID = "set_auto_dream";

/**
 * Two patches:
 *
 * Patch 1 (gate bypass): Find function with `if (!CALL()) { return false; }` AND
 * `.autoDreamEnabled` access. Insert early return at the top:
 *   if (typeof __isModEnabled__ === "function" && __isModEnabled__("set_auto_dream")) return true;
 *
 * Patch 2 (threshold override): Find function containing "tengu_onyx_plover" that
 * returns { minHours: ..., minSessions: ... }. Insert before the return:
 *   if (__isModEnabled__) {
 *     let envH = process.env.CLAUDE_AUTO_DREAM_MIN_HOURS;
 *     let envS = process.env.CLAUDE_AUTO_DREAM_MIN_SESSIONS;
 *     return { minHours: <IIFE>, minSessions: <IIFE> };
 *   }
 *
 * Anchors: "autoDreamEnabled" (gate), "tengu_onyx_plover" (threshold),
 * "minHours" + "minSessions" (threshold return).
 */
function transform(code) {
  if (typeof code !== "string") return { code: "", changed: 0 };

  // Idempotency: if already patched, skip
  if (code.includes('__isModEnabled__("set_auto_dream")')) {
    return { code, changed: 0 };
  }

  let count = 0;

  // --- Patch 1: Gate bypass ---
  // Find: function BODY containing `if (!CALL()) { return false; }` AND `.autoDreamEnabled`
  // Strategy: find `.autoDreamEnabled`, then find its containing function,
  // then find the `if (!CALL()) { return false; }` pattern inside it

  const autoDreamIdx = code.indexOf(".autoDreamEnabled");
  if (autoDreamIdx !== -1) {
    // Find containing function
    let funcBraceStart = -1;
    let depth = 0;
    for (let i = autoDreamIdx; i >= 0; i--) {
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

        // Verify it has the gate pattern: if (!CALL()) { return false; }
        const gatePattern = /if\s*\(\s*!([\w$]+)\(\)\s*\)\s*\{\s*return\s+false\s*;\s*\}/;
        const gateMatch = funcBlock.match(gatePattern);

        if (gateMatch) {
          // Insert the mod guard as the first statement in the function body
          const guard = `if (typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}")) return true;`;
          // Insert after the opening brace
          const insertPos = funcBraceStart + 1;
          code = code.substring(0, insertPos) + "\n  " + guard + "\n" + code.substring(insertPos);
          count++;
        }
      }
    }
  }

  // --- Patch 2: Threshold override ---
  // Find function containing "tengu_onyx_plover" that returns { minHours, minSessions }

  // There may be multiple occurrences of "tengu_onyx_plover" — find the one inside
  // a function that also contains "minHours" (the threshold function), not the simple getter.
  const tenguOccurrences = [];
  let searchFrom = 0;
  while (true) {
    const idx = code.indexOf("tengu_onyx_plover", searchFrom);
    if (idx === -1) break;
    tenguOccurrences.push(idx);
    searchFrom = idx + 1;
  }

  for (const tenguIdx of tenguOccurrences) {
    // Find containing function
    let funcBraceStart = -1;
    let depth = 0;
    for (let i = tenguIdx; i >= 0; i--) {
      if (code[i] === '}') depth++;
      if (code[i] === '{') { if (depth === 0) { funcBraceStart = i; break; } depth--; }
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

    // Skip if this function doesn't also contain minHours — it's the wrong occurrence
    if (!funcBlock.includes("minHours")) continue;

    // Find the return { minHours: ..., minSessions: ... } statement
    const returnPattern = /return\s*\{[\s\S]*minHours[\s\S]*minSessions[\s\S]*\}/;
    const returnMatch = funcBlock.match(returnPattern);

    if (returnMatch) {
      // Extract var names from the ternary: GBVAR.minHours : DEFAULTS.minHours
      // Handles both simple (H.minHours) and complex (H?.minHours) patterns
      const ternaryPattern = /([\w$]+)\.minHours\s*:\s*([\w$]+)\.minHours/;
      const ternaryMatch = funcBlock.match(ternaryPattern);

      if (ternaryMatch) {
        const gbVar = ternaryMatch[1];
        const defaultsName = ternaryMatch[2];

        // Build the threshold IIFE for each property
        const thresholdIIFE = (propName, configKey, envVar) =>
          `(() => { let cfg = typeof __getModConfig__ === "function" ? __getModConfig__("${MOD_ID}", "${configKey}", null) : null; if (cfg != null) { let n = Number(cfg); if (Number.isFinite(n) && n > 0) return n; } if (${envVar} != null) { let n = Number(${envVar}); if (Number.isFinite(n) && n > 0) return n; } if (typeof ${gbVar}?.${propName} === "number" && Number.isFinite(${gbVar}.${propName}) && ${gbVar}.${propName} > 0) return ${gbVar}.${propName}; return ${defaultsName}.${propName}; })()`;

        const modGuard = `typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}")`;
        const overrideBlock =
          `if (${modGuard}) {\n` +
          `    let envH = process.env.CLAUDE_AUTO_DREAM_MIN_HOURS;\n` +
          `    let envS = process.env.CLAUDE_AUTO_DREAM_MIN_SESSIONS;\n` +
          `    return { minHours: ${thresholdIIFE("minHours", "min_hours", "envH")}, minSessions: ${thresholdIIFE("minSessions", "min_sessions", "envS")} };\n` +
          `  }\n`;

        // Insert before the return statement
        const returnIdx = funcBlock.indexOf(returnMatch[0]);
        const absReturnIdx = funcBraceStart + returnIdx;

        code = code.substring(0, absReturnIdx) + overrideBlock + code.substring(absReturnIdx);
        count++;
        break; // Only patch the first matching function
      }
    }
  }

  if (count === 0) {
    return { code, changed: 0 };
  }

  return { code, changed: count };
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-set-auto-dream.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const { code: output, changed } = transform(code);

  if (changed === 0) {
    throw new Error(
      "No matching auto-dream functions found (gate or threshold). The target code structure may have changed."
    );
  }
  if (changed === 1) {
    console.error(
      "WARNING: Only 1 of 2 auto-dream patches applied (gate bypass + threshold override). " +
      "The status_tests.applied regex will detect this as incomplete."
    );
  } else {
    console.error(`Patched ${changed} auto-dream function(s).`);
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

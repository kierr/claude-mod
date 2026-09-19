#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

// Flags that need object wrapping ({enabled: true, available: true}) instead of bare boolean.
// When the user sets these in mods.json as a plain boolean, we wrap to the object form
// the upstream resolver expects. When the user sets them as an object, we pass it through.
// RATIONALE: The upstream GrowthBook resolver returns objects for these flags; a bare
// boolean override would be a type mismatch. The values come from mods.json, not hardcoded.
const OBJECT_WRAP_FLAGS = ["tengu_onyx_plover", "tengu_herring_clock"];

// Injected at the top of the GrowthBook resolver body (v0o).
// Checks mods.json for feature_flags_* keys; if any match the requested flag,
// return the override value immediately.
// Known flag keys: tengu_passport_quail, tengu_session_memory, tengu_slate_thimble,
//   tengu_billiard_aviary, tengu_kairos_loop_dynamic, tengu_kairos_push_notifications,
//   tengu_kairos_loop_prompt, tengu_kairos_input_needed_push, tengu_kairos_loop_persistent,
//   tengu_kairos_loop_keepalive, tengu_kairos_cron, tengu_kairos_cron_durable,
//   tengu_amber_sentinel, tengu_onyx_plover, tengu_herring_clock,
//   tengu_streaming_tool_execution2, tengu_coral_fern, tengu_ashen_kelp,
//   tengu_destructive_command_warning, tengu_harbor, tengu_workflows_enabled
function buildGrowthBookGuard(paramName) {
  return `if (typeof __isModEnabled__ === "function" && __isModEnabled__("set_flags_and_policy") && typeof __modsLoad__ === "function") {
    var __ff_cfg = __modsLoad__();
    if (__ff_cfg && typeof __ff_cfg === "object") {
      var __ff_fk = "feature_flags_" + ${paramName};
      if (__ff_fk in __ff_cfg) {
        var __ff_raw = __ff_cfg[__ff_fk];
        // Object-wrap flags: upstream returns objects for these, so a boolean override
        // must be wrapped. If the user provided an object, pass it through directly.
        var __ff_wrap_keys = ${JSON.stringify(OBJECT_WRAP_FLAGS)};
        if (__ff_raw === true && __ff_wrap_keys.indexOf(${paramName}) !== -1) {
          return { value: { enabled: true, available: true }, source: "mod" };
        }
        if (__ff_raw && typeof __ff_raw === "object" && __ff_wrap_keys.indexOf(${paramName}) !== -1) {
          return { value: __ff_raw, source: "mod" };
        }
        return { value: __ff_raw, source: "mod" };
      }
    }
  }`;
}

// Injected at the top of the policy resolver body (Us).
// Checks mods.json for policy_* keys; if the key is true, return true (allowed).
function buildPolicyGuard(paramName) {
  return `if (typeof __isModEnabled__ === "function" && __isModEnabled__("set_flags_and_policy") && typeof __modsLoad__ === "function") {
    var __pv7_cfg = __modsLoad__();
    if (__pv7_cfg && typeof __pv7_cfg === "object") {
      var __pv7_key = "policy_" + ${paramName};
      if (__pv7_key in __pv7_cfg && __pv7_cfg[__pv7_key] === true) {
        return true;
      }
    }
  }`;
}

// Find a function body by structural anchor, return {start, paramName, bodyBracePos}
// matchFn receives the text from the function start and should return the param name
// if the anchor is found, or null otherwise.
function findFunctionByAnchor(code, anchorPattern, anchorWindow) {
  // Search for the anchor string, then walk backward to find the enclosing function.
  let searchFrom = 0;
  while (true) {
    const anchorIdx = code.indexOf(anchorPattern, searchFrom);
    if (anchorIdx === -1) return null;
    // Walk backward to find the function declaration that encloses this anchor.
    // Look for "function NAME(PARAM) {" before the anchor, within anchorWindow chars.
    const windowStart = Math.max(0, anchorIdx - anchorWindow);
    const before = code.substring(windowStart, anchorIdx);
    // Find the last "function NAME(PARAM) {" before the anchor
    const funcPattern = /function\s+([\w$]+)\s*\(\s*([\w$]+)\s*\)\s*\{/g;
    let lastMatch = null;
    let m;
    while ((m = funcPattern.exec(before)) !== null) {
      lastMatch = m;
    }
    if (lastMatch) {
      const funcStart = windowStart + lastMatch.index;
      const paramName = lastMatch[2];
      const bodyBrace = funcStart + lastMatch[0].length - 1; // position of {
      return { funcStart, paramName, bodyBrace, anchorIdx };
    }
    searchFrom = anchorIdx + 1;
  }
}

function transform(code) {
  let totalChanged = 0;

  // Idempotency
  if (code.includes("__ff_fk") && code.includes("__pv7_key")) {
    return { code, changed: 0 };
  }

  // Layer 1: patch GrowthBook resolver (the function containing cachedGrowthBookFeatures?.[)
  if (!code.includes("__ff_fk")) {
    const found = findFunctionByAnchor(code, "cachedGrowthBookFeatures?.[", 2000);
    if (found) {
      const guard = buildGrowthBookGuard(found.paramName);
      code = code.substring(0, found.bodyBrace + 1) + guard + code.substring(found.bodyBrace + 1);
      totalChanged++;
    }
  }

  // Layer 2: patch policy resolver (the function containing compliance_taints)
  if (!code.includes("__pv7_key")) {
    const found = findFunctionByAnchor(code, "compliance_taints", 2000);
    if (found) {
      const guard = buildPolicyGuard(found.paramName);
      code = code.substring(0, found.bodyBrace + 1) + guard + code.substring(found.bodyBrace + 1);
      totalChanged++;
    }
  }

  return { code, changed: totalChanged };
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-set-flags-and-policy.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const { code: output, changed } = transform(code);

  if (changed === 0) {
    if (code.includes("__ff_fk") && code.includes("__pv7_key")) {
      console.error("Feature flag + policy gate overrides already applied; skipping.");
    } else {
      throw new Error("No matching GrowthBook/policy resolver targets found — bundle may have drifted.");
    }
  } else {
    console.error(`Patched ${changed} resolver(s): GrowthBook flags + policy gates.`);
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

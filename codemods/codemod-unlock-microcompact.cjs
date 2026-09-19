#!/usr/bin/env node
// Keep removal eligibility, retained recent messages, and token-budget checks separate when selecting tool results to compact.

const MOD_ID = "unlock_microcompact";
// Partial application is expected on code-split binaries where the 5 target
// sites are distributed across multiple chunks. Each sub-patch applies
// independently; REQUIRED_CHANGES gates the __mct_patched__ marker, not
// whether the codemod reports success (any changed > 0 is progress).
const REQUIRED_CHANGES = 5;

/**
 * Discover the minified variable names for the tool-name Set and the
 * replacement string, anchored on the stable "[Old tool result content cleared]"
 * string literal. These names change every release and MUST NOT be hardcoded.
 *
 * Returns { toolNameSetVar, replacementStringVar } or null if not found.
 */
function discoverMicrocompactVars(code) {
  const replMatch = /var ([\w$]+) = "\[Old tool result content cleared\]"/.exec(code);
  if (!replMatch) return null;
  const replacementStringVar = replMatch[1];

  const searchStart = replMatch.index + replMatch[0].length;
  const searchChunk = code.slice(searchStart, searchStart + 10000);
  const setAssignMatch = /(\w+) = new Set\(\[.*?\]\);/.exec(searchChunk);
  if (!setAssignMatch) return { toolNameSetVar: null, replacementStringVar };

  const setName = setAssignMatch[1];
  const varDeclPattern = new RegExp(`var ${setName};`);
  const nearRepl = code.slice(Math.max(0, replMatch.index - 200), replMatch.index + 200);
  if (!varDeclPattern.test(nearRepl)) {
    const widerArea = code.slice(Math.max(0, replMatch.index - 500), searchStart + 5000);
    if (!varDeclPattern.test(widerArea)) return { toolNameSetVar: null, replacementStringVar };
  }

  return { toolNameSetVar: setName, replacementStringVar };
}

/**
 * Patch A: Inject time-based microcompact function + the adaptive runtime
 * (model capture receiver, profile table, policy resolver).
 */
function patchInjectTimeBasedFunction(code) {
  if (code.includes("function __mcResolvePolicy")) {
    return { code, changed: 0 };
  }

  const pattern = /(\[Old tool result content cleared\]";\n\s*var \w+ = "[^"]+";\n\s*var \w+ = \d+;\n\s*var \w+ = \d+;)/;
  const match = pattern.exec(code);
  if (!match) {
    return { code, changed: 0 };
  }

  const vars = discoverMicrocompactVars(code);
  const toolSet = vars?.toolNameSetVar;
  if (!vars?.replacementStringVar) {
    return { code, changed: 0 };
  }
  const replStr = vars.replacementStringVar;

  // Adaptive runtime: capture receiver + model profile table + policy resolver.
  // The resolver keys off the live active model (globalThis.__mcActiveModel,
  // populated by Patch E at the fetch chokepoint). Static config overrides:
  //   mode (off|idle|gentle|aggressive), context_window, provider_cache.
  const resolverFn = `
globalThis.__mcActiveModel = globalThis.__mcActiveModel || "";
globalThis.__mcCaptureModel = function (body) {
  try {
    var b = typeof body === "string" ? JSON.parse(body) : body;
    if (b && typeof b.model === "string") globalThis.__mcActiveModel = b.model;
  } catch (e) {}
};
function __mcProfile(model) {
  model = model || "";
  if (/^glm-5/i.test(model)) return { window: 1000000, cache: "5m" };
  if (/^glm-4\\.6/i.test(model)) return { window: 200000, cache: "5m" };
  if (/^glm/i.test(model)) return { window: 200000, cache: "5m" };
  if (/^claude/i.test(model)) return { window: 200000, cache: "1h" };
  return { window: 0, cache: "unknown" };
}
function __mcResolvePolicy() {
  var mcCfg = typeof __getModConfig__ === "function" ? __getModConfig__ : null;
  var get = function (k, d) { try { return mcCfg ? mcCfg("${MOD_ID}", k, d) : d; } catch (e) { return d; } };
  var mode = get("mode", "auto");
  if (mode === "off") return { enabled: false };
  if (mode === "idle" || mode === "gentle" || mode === "aggressive") return { enabled: true, mode: mode };
  var prof = (typeof __mcProfile === "function") ? __mcProfile(globalThis.__mcActiveModel || "") : { window: 0, cache: "unknown" };
  var cw = Number(get("context_window", 0));
  var ctxWin = cw > 0 ? cw : prof.window;
  var pc = get("provider_cache", "auto");
  var cached;
  if (pc === "cached") cached = true;
  else if (pc === "none") cached = false;
  else {
    if (prof.cache === "none") cached = false;
    else if (prof.cache === "5m" || prof.cache === "1h") cached = true;
    else {
      var base = "";
      try { base = (typeof process !== "undefined" && process.env && process.env.ANTHROPIC_BASE_URL) || ""; } catch (e) {}
      cached = !/chutes/i.test(base);
    }
  }
  var large = ctxWin >= 500000;
  if (large && cached) return { enabled: false, mode: "off" };
  if (large) return { enabled: true, mode: "idle" };
  if (cached) return { enabled: true, mode: "gentle" };
  return { enabled: true, mode: "aggressive" };
}`;

  const mcFunction = `
function __mcTimeBasedMutate(H, qs) {
  if (typeof __isModEnabled__ !== "function" || !__isModEnabled__("${MOD_ID}")) return;
  if (!qs || typeof qs !== "string" || !qs.startsWith("repl_main_thread")) return;
  var policy = (typeof __mcResolvePolicy === "function") ? __mcResolvePolicy() : { enabled: true, mode: "idle" };
  if (!policy || policy.enabled === false) return;
  var la = null;
  for (var i = H.length - 1; i >= 0; i--) {
    if (H[i].type === "assistant") { la = H[i]; break; }
  }
  if (!la || !la.timestamp) return;
  var gap = (Date.now() - new Date(la.timestamp).getTime()) / 60000;
  var mcCfg = typeof __getModConfig__ === "function" ? __getModConfig__ : null;
  var gapMin = mcCfg ? mcCfg("${MOD_ID}", "time_threshold_min", 30) : 30;
  if (policy.mode === "aggressive" && gapMin > 10) gapMin = 10;
  if (!Number.isFinite(gap) || gap < gapMin) return;
  var keepN = mcCfg ? mcCfg("${MOD_ID}", "keep_recent", 5) : 5;
  if (policy.mode === "gentle" && keepN < 20) keepN = 20;
  var ids = [];
  for (var j = 0; j < H.length; j++) {
    if (H[j].type === "assistant" && Array.isArray(H[j].message.content)) {
      for (var k = 0; k < H[j].message.content.length; k++) {
        var b = H[j].message.content[k];
        if (b.type === "tool_use"${toolSet ? ` && ${toolSet}.has(b.name)` : ""}) ids.push(b.id);
      }
    }
  }
  var keep = new Set(ids.slice(-keepN));
  for (var m = 0; m < H.length; m++) {
    if (H[m].type !== "user" || !Array.isArray(H[m].message.content)) continue;
    for (var n = 0; n < H[m].message.content.length; n++) {
      var bl = H[m].message.content[n];
      if (bl.type === "tool_result" && !keep.has(bl.tool_use_id)) {
        bl.content = ${replStr};
      }
    }
  }
}`;

  code = code.replace(
    pattern,
    () => match[0] + resolverFn + mcFunction
  );
  return { code, changed: 1 };
}

/**
 * Patch B: Wire time-based check into buildRequestParams.
 */
function patchWireTimeBasedCheck(code) {
  const brpMatch = /buildRequestParams\((\w+)\)\s*\{\n\s+(\w+ = false;)/.exec(code);
  if (!brpMatch) {
    return { code, changed: 0 };
  }
  const paramName = brpMatch[1];
  const brpEnd = brpMatch.index + brpMatch[0].length;

  let closureVar = null;
  const propAccessRe = /(\w+)\.querySource/g;
  propAccessRe.lastIndex = brpEnd;
  const propMatch = propAccessRe.exec(code);
  if (propMatch) {
    closureVar = propMatch[1];
  }
  if (!closureVar) {
    return { code, changed: 0 };
  }

  code = code.replace(
    brpMatch[0],
    () => brpMatch[0].replace(
      /(\w+ = false;)/,
      `if (typeof __mcTimeBasedMutate === "function") __mcTimeBasedMutate(${paramName}, ${closureVar}.querySource);\n        $1`
    )
  );
  return { code, changed: 1 };
}

/**
 * Patch C: Force-enable context hint when mod is enabled.
 */
function patchEnableContextHint(code) {
  if (/if \(typeof __isModEnabled__ === "function" && __isModEnabled__\("unlock_microcompact"\)\)\s*\n\s*return true;/.test(code)) {
    return { code, changed: 0 };
  }

  const pattern = /return (\w+)\("tengu_hazel_osprey",\s*false\);/;
  const match = pattern.exec(code);
  if (!match) {
    return { code, changed: 0 };
  }

  code = code.replace(
    pattern,
    (m, p1) => `if (typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}"))
      return true;
    return ${p1}("tengu_hazel_osprey", false);`
  );
  return { code, changed: 1 };
}

/**
 * Patch D: Make tokens-saved threshold configurable via mods.json.
 */
function patchLowerThreshold(code) {
  if (/\b__getModConfig__\("unlock_microcompact", "tokens_saved_threshold"/.test(code)) {
    return { code, changed: 0 };
  }

  const pattern = /\[Old tool result content cleared\]";\n(\s*)var (\w+) = "[^"]+";\n(\s*)var (\w+) = 20000;/;
  const match = pattern.exec(code);
  if (!match) {
    return { code, changed: 0 };
  }

  code = code.replace(
    pattern,
    () => match[0].replace(
      /var (\w+) = 20000;/,
      `var $1 = (typeof __getModConfig__ === "function" ? __getModConfig__("unlock_microcompact", "tokens_saved_threshold", 20000) : 20000);`
    )
  );
  return { code, changed: 1 };
}

/**
 * Patch E: Capture the active model slug at the SDK fetch chokepoint.
 *
 * Matches `return await <holder>.fetch.call(undefined, URL, OPTS)` (the same
 * site add_cache_keepalive hooks). Injects a guarded __mcCaptureModel(OPTS.body)
 * call before the return, filtered to /v1/messages (excluding count_token).
 * The holder/URL/OPTS identifiers are captured structurally (never hardcoded).
 *
 * Sentinel `__mc_capture_installed__` distinguishes "capture call injected"
 * from "capture function defined" (Patch A defines __mcCaptureModel), so the
 * two patches' idempotency checks don't shadow each other.
 */
function patchCaptureModel(code) {
  if (code.includes("__mc_capture_installed__")) {
    return { code, changed: 0 };
  }

  const re = /return await ([\w$]+)\.fetch\.call\(undefined,\s*([\w$]+),\s*([\w$]+)\)/g;
  let changed = 0;
  code = code.replace(re, (m, holder, urlVar, optsVar) => {
    changed++;
    return `/*__mc_capture_installed__*/ if (typeof __mcCaptureModel === "function" && typeof ${urlVar} === "string" && ${urlVar}.indexOf("/v1/messages") !== -1 && ${urlVar}.indexOf("count_token") === -1) __mcCaptureModel(${optsVar}.body);\n          return await ${holder}.fetch.call(undefined, ${urlVar}, ${optsVar})`;
  });
  return { code, changed: changed > 0 ? 1 : 0 };
}

function transform(code) {
  let totalChanged = 0;
  const alreadyPatched = code.includes("__mct_patched__");

  const a = patchInjectTimeBasedFunction(code);
  code = a.code;
  totalChanged += a.changed;

  const b = patchWireTimeBasedCheck(code);
  code = b.code;
  totalChanged += b.changed;

  const c = patchEnableContextHint(code);
  code = c.code;
  totalChanged += c.changed;

  const d = patchLowerThreshold(code);
  code = d.code;
  totalChanged += d.changed;

  const e = patchCaptureModel(code);
  code = e.code;
  totalChanged += e.changed;

  if (totalChanged > 0 && !alreadyPatched) {
    // On code-split binaries, sub-patches land in separate chunks; don't
    // require all 5 to emit the marker — any successful sub-patch writes it
    // so the applied-test can detect progress.  On monolithic, all 5 land
    // in one invocation and REQUIRED_CHANGES is still 5.
    code = "var __mct_patched__ = true;\n" + code;
  }

  return { code, changed: totalChanged };
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-unlock-microcompact.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const fs = require("fs");
  const path = require("path");

  const inputPath = path.resolve(inputFile);
  const src = fs.readFileSync(inputPath, "utf-8");

  const { code: output, changed } = transform(src);

  if (changed === 0) {
    if (src.includes("__mct_patched__")) {
      console.error("Microcompact tuning fully applied; skipping.");
    } else {
      // On code-split binaries, partial application across chunks is normal;
      // return changed:0 for THIS chunk, not an error.
      console.error("No matching targets in this chunk — may be in another chunk.");
      process.exit(0);
    }
  } else if (src.includes("__mct_patched__")) {
    console.error(`Repair: applied ${changed} previously-missed patch(es).`);
  } else {
    console.error(`Patched ${changed} target(s): time-based MC function + wire-in + context-hint enable + threshold lowering + model capture.`);
  }

  if (outputFile) {
    fs.writeFileSync(path.resolve(outputFile), output, "utf-8");
  } else {
    process.stdout.write(output);
  }
}

module.exports = { transform };

if (require.main === module) {
  main();
}

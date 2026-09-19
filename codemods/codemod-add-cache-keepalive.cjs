#!/usr/bin/env node
// Replay captured message requests while idle, using the original fetch adapter.
// These off-transcript requests can incur provider charges; the mod is default-off.

const fs = require("fs");
const { findMatchingBrace } = require("./scan-helpers.cjs");
const path = require("path");

const MOD_ID = "add_cache_keepalive";
const SENTINEL = "__CACHE_KEEPALIVE_INSTALLED__";

// The runtime module. Plain ES (var/function), no import/export, broad compat.
const MODULE_SOURCE = `
// ${SENTINEL}
// Cache keepalive: re-POSTs the last /v1/messages request at low cost during
// idle REPL moments to refresh the provider prompt-cache TTL. No-op when the
// add_cache_keepalive mod is disabled in ~/.claude/mods.json.
(function () {
  var SENTINEL = "${SENTINEL}";
  var state = { url: null, headers: null, body: null, fetchFn: null, timer: null, enabled: true };
  var MOD_ID = "add_cache_keepalive";

  function modEnabled() {
    return typeof __isModEnabled__ === "function" && __isModEnabled__(MOD_ID);
  }
  function getConfig(key, fallback) {
    if (typeof __getModConfig__ === "function") return __getModConfig__(MOD_ID, key, fallback);
    return fallback;
  }
  function interactiveGuard() {
    if (!state.enabled) return false;
    if (typeof process !== "undefined" && process.env && process.env.CLAUDE_NON_INTERACTIVE) return false;
    return true;
  }
  function lastMsgIsUnresolvedToolTurn(body) {
    var msgs = body && body.messages;
    if (!Array.isArray(msgs) || msgs.length === 0) return false;
    var last = msgs[msgs.length - 1];
    if (!last || last.role !== "assistant" || !Array.isArray(last.content)) return false;
    for (var i = 0; i < last.content.length; i++) {
      if (last.content[i] && last.content[i].type === "tool_use") return true;
    }
    return false;
  }
  function tick() {
    try {
      if (!modEnabled()) return;
      if (!state.url || !state.headers || !state.body) return;
      var body = typeof state.body === "string" ? JSON.parse(state.body) : state.body;
      if (lastMsgIsUnresolvedToolTurn(body)) return;
      body.max_tokens = 1;
      body.max_completion_tokens = 1;
      body.stream = false;
      var fn = state.fetchFn || fetch;
      var resp = fn(state.url, { method: "POST", headers: state.headers, body: JSON.stringify(body) });
      if (resp && typeof resp.then === "function") {
        resp.then(function (r) {
          return r && typeof r.text === "function" ? r.text() : null;
        }).then(null, function () {});
      }
    } catch (e) {
      try { console.error("[add-cache-keepalive] tick failed:", e && e.message); } catch (e2) {}
    }
  }

  globalThis.__ckCapture = function (url, headers, body, fetchFn) {
    try {
      state.url = url || null;
      state.headers = headers || null;
      state.body = body == null ? null : body;
      if (fetchFn) state.fetchFn = fetchFn;
    } catch (e) {}
  };
  globalThis.__ckStart = function () {
    try {
      if (!interactiveGuard() || !modEnabled()) return;
      if (state.timer !== null) { clearInterval(state.timer); state.timer = null; }
      var interval = getConfig("intervalMs", 240000);
      state.timer = setInterval(tick, interval);
      if (state.timer && typeof state.timer.unref === "function") state.timer.unref();
    } catch (e) {
      try { console.error("[add-cache-keepalive] start failed:", e && e.message); } catch (e2) {}
    }
  };
  globalThis.__ckStop = function () {
    try { if (state.timer !== null) { clearInterval(state.timer); state.timer = null; } } catch (e) {}
  };
  globalThis.__ckInvalidate = function () {
    try { state.body = null; state.url = null; state.headers = null; } catch (e) {}
  };
  globalThis.__ckTick = tick;
})();
`;

/**
 * Five injection sites, all anchored on stable property names:
 *
 * SITE 1 (CAPTURE): `return await HOLDER.fetch.call(undefined, URL, OPTS)` —
 *   insert __ckCapture guard before this return statement.
 *   Anchors: `.fetch.call(`, `undefined` as first arg, 3+ args.
 *
 * SITE 2 (START): `.lastApiCompletionTimestamp =` assignment —
 *   insert `typeof __ckStart === "function" && __ckStart()` after it.
 *
 * SITE 3 (STOP): `.lastMainRequestId =` assignment —
 *   insert `typeof __ckStop === "function" && __ckStop()` after it.
 *
 * SITE 4 (MODULE): insert the keepalive IIFE after the function containing
 *   the completion setter (identified by `.lastApiCompletionTimestamp` assignment).
 *
 * SITE 5 (INVALIDATE): `.pendingPostCompaction = true` assignment —
 *   insert `typeof __ckInvalidate === "function" && __ckInvalidate();` before it.
 */
function transform(code) {
  // Idempotency: sentinel already present
  if (code.includes(SENTINEL)) {
    return { code, changed: 0 };
  }

  let count = 0;
  let moduleInserted = false;

  // --- SITE 2: START (after .lastApiCompletionTimestamp = assignment) ---
  const startPattern = /([\w$]+)\.lastApiCompletionTimestamp\s*=\s*([\w$]+)\s*;/g;
  let startMatch;
  const startSites = [];
  while ((startMatch = startPattern.exec(code)) !== null) {
    startSites.push({ index: startMatch.index, matchStr: startMatch[0], endIdx: startMatch.index + startMatch[0].length });
  }
  // We'll process these later (need to know module insertion point)

  // --- SITE 3: STOP (after .lastMainRequestId = assignment) ---
  const stopPattern = /([\w$]+)\.lastMainRequestId\s*=\s*([\w$]+)\s*;/g;
  let stopMatch;
  const stopSites = [];
  while ((stopMatch = stopPattern.exec(code)) !== null) {
    stopSites.push({ index: stopMatch.index, matchStr: stopMatch[0], endIdx: stopMatch.index + stopMatch[0].length });
  }

  // --- SITE 5: INVALIDATE (before .pendingPostCompaction = true) ---
  const invalidatePattern = /([\w$]+)\.pendingPostCompaction\s*=\s*true\s*;/g;
  let invMatch;
  const invSites = [];
  while ((invMatch = invalidatePattern.exec(code)) !== null) {
    invSites.push({ index: invMatch.index, matchStr: invMatch[0] });
  }

  // --- SITE 1: CAPTURE (before `return await HOLDER.fetch.call(undefined, URL, OPTS)`) ---
  // Pattern: return await <holder>.fetch.call(undefined, <url>, <opts>)
  const capturePattern = /return\s+await\s+([\w$]+(?:\.\w+)*)\.fetch\.call\(undefined,\s*([\w$]+),\s*([\w$]+)\s*\)/g;
  let capMatch;
  const capSites = [];
  while ((capMatch = capturePattern.exec(code)) !== null) {
    const holder = capMatch[1];
    const urlName = capMatch[2];
    const optsName = capMatch[3];
    capSites.push({
      index: capMatch.index,
      matchStr: capMatch[0],
      holder,
      urlName,
      optsName,
    });
  }

  // Apply all injections. Process in reverse order by index to maintain offsets.
  // Collect all edits as {index, type, data} and sort by index descending.

  const edits = [];

  // CAPTURE edits
  for (const cap of capSites) {
    const captureStmt = `typeof __ckCapture === "function" && typeof ${cap.urlName} === "string" && ${cap.urlName}.indexOf("/v1/messages") !== -1 && ${cap.urlName}.indexOf("count_token") === -1 && __ckCapture(${cap.urlName}, ${cap.optsName}.headers, ${cap.optsName}.body, ${cap.holder}.fetch);`;
    edits.push({ index: cap.index, type: "insert_before", text: captureStmt + "\n" });
  }

  // START edits
  for (const site of startSites) {
    const startStmt = `typeof __ckStart === "function" && __ckStart();`;
    edits.push({ index: site.endIdx, type: "insert_after", text: "\n" + startStmt });
  }

  // STOP edits
  for (const site of stopSites) {
    const stopStmt = `typeof __ckStop === "function" && __ckStop();`;
    edits.push({ index: site.endIdx, type: "insert_after", text: "\n" + stopStmt });
  }

  // INVALIDATE edits
  for (const site of invSites) {
    const invStmt = `typeof __ckInvalidate === "function" && __ckInvalidate(); `;
    edits.push({ index: site.index, type: "insert_before", text: invStmt });
  }

  // MODULE edit: insert after the function containing the completion setter
  // Find the function that contains .lastApiCompletionTimestamp and insert the IIFE after it
  if (startSites.length > 0) {
    // Find the containing function for the first start site
    const firstStart = startSites[0].index;
    // Scan backward for function keyword/brace
    let funcBraceStart = -1;
    let depth = 0;
    for (let i = firstStart; i >= 0; i--) {
      if (code[i] === '}') depth++;
      if (code[i] === '{') {
        if (depth === 0) { funcBraceStart = i; break; }
        depth--;
      }
    }
    if (funcBraceStart !== -1) {
      // Find matching closing brace (string/comment-aware)
      const funcBraceEnd = findMatchingBrace(code, funcBraceStart);
      if (funcBraceEnd !== -1) {
        edits.push({ index: funcBraceEnd + 1, type: "insert_after", text: "\n" + MODULE_SOURCE + "\n" });
        moduleInserted = true;
      }
    }
  }

  // Sort edits by index descending (apply from end to start to maintain offsets)
  edits.sort((a, b) => b.index - a.index);

  // Apply edits
  for (const edit of edits) {
    if (edit.type === "insert_before") {
      code = code.substring(0, edit.index) + edit.text + code.substring(edit.index);
    } else if (edit.type === "insert_after") {
      code = code.substring(0, edit.index) + edit.text + code.substring(edit.index);
    }
    count++;
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
    console.error("Usage: codemod-add-cache-keepalive.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const { code: output, changed } = transform(code);

  if (changed === 0) {
    console.error(
      "add_cache_keepalive: no matching sites found (already patched or version drift)."
    );
    process.exit(1);
  }

  console.error(`add_cache_keepalive: injected ${changed} site(s).`);

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

#!/usr/bin/env node
// Replay captured message requests while idle, using the original fetch adapter.
// These off-transcript requests can incur provider charges; the mod is default-off.

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

const MOD_ID = "add_cache_keepalive";
const SENTINEL = "__CACHE_KEEPALIVE_INSTALLED__";

// The runtime module. Plain ES (var/function), no import/export, broad compat.
// RATIONALE: keepalive is the only lever for providers with automatic prefix
// caching (no cache_control/TTL flag) — see memory: add-cache-keepalive-design.
// __ckInvalidate is wired (5th injection) into the markPostCompaction body —
// the function that sets <obj>.pendingPostCompaction = true, fired at every
// compaction completion (/compact, auto-compact). Clearing the captured body
// there prevents pings that warm a prefix the next turn no longer shares.
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

// typeof NAME === "function"
function typeofFn(name) {
  return t.binaryExpression(
    "===",
    t.unaryExpression("typeof", t.identifier(name), true),
    t.stringLiteral("function")
  );
}

// <url>.indexOf(STR)
function indexOfCall(urlId, str) {
  return t.callExpression(
    t.memberExpression(urlId, t.identifier("indexOf")),
    [t.stringLiteral(str)]
  );
}

// Build the CAPTURE call statement:
//   typeof __ckCapture === "function" && typeof URL === "string"
//   && URL.indexOf("/v1/messages") !== -1 && URL.indexOf("count_token") === -1
//   && __ckCapture(URL, OPTS.headers, OPTS.body, <holder>.fetch)
// The fetch holder node is the cloned <holder>.fetch member expression from the
// matched call site (callee.object), so the captured fetchFn is exactly the
// function being invoked — this.fetch in current upstream, but robust to a
// future X.fetch holder. Avoids hardcoding `this` and preserves any SDK fetch
// adapter/proxy wired onto the actual holder.
function buildCaptureStmt(urlName, optsName, fetchHolderNode) {
  const urlId = t.identifier(urlName);
  const optsId = t.identifier(optsName);
  const minus1 = t.unaryExpression("-", t.numericLiteral(1), true);
  return t.expressionStatement(
    t.logicalExpression("&&",
      typeofFn("__ckCapture"),
      t.logicalExpression("&&",
        t.binaryExpression("===", t.unaryExpression("typeof", urlId, true), t.stringLiteral("string")),
        t.logicalExpression("&&",
          t.binaryExpression("!==", indexOfCall(urlId, "/v1/messages"), minus1),
          t.logicalExpression("&&",
            t.binaryExpression("===", indexOfCall(urlId, "count_token"), minus1),
            t.callExpression(t.identifier("__ckCapture"), [
              urlId,
              t.memberExpression(optsId, t.identifier("headers")),
              t.memberExpression(optsId, t.identifier("body")),
              fetchHolderNode,
            ])
          )
        )
      )
    )
  );
}

// typeof __ckX === "function" && __ckX()
function buildGuardedCallStmt(name) {
  return t.expressionStatement(
    t.logicalExpression("&&", typeofFn(name), t.callExpression(t.identifier(name), []))
  );
}

function isId(node, name) {
  return t.isIdentifier(node, { name });
}

// True if a FunctionDeclaration's body contains the completion-timestamp setter
// assignment (the anchor that uniquely identifies G$_ / its equivalent).
function hasCompletionSetter(fnDecl) {
  const stmts = (fnDecl.body && fnDecl.body.body) || [];
  return stmts.some(
    (s) =>
      t.isExpressionStatement(s) &&
      t.isAssignmentExpression(s.expression) &&
      t.isMemberExpression(s.expression.left) &&
      t.isIdentifier(s.expression.left.property, { name: "lastApiCompletionTimestamp" })
  );
}

// True if a FunctionDeclaration's body assigns `true` to a `.pendingPostCompaction`
// property — the markPostCompaction impl, fired at every compaction completion
// (/compact, auto-compact). Anchored on the stable property name, never the
// minified fn name (QgH today). Used to invalidate the captured keepalive body
// so a ping never warms a prefix the next turn no longer shares.
function isPostCompactionMarker(fnDecl) {
  if (!fnDecl.body || !Array.isArray(fnDecl.body.body)) return false;
  return fnDecl.body.body.some(
    (s) =>
      t.isExpressionStatement(s) &&
      t.isAssignmentExpression(s.expression) &&
      s.expression.operator === "=" &&
      t.isMemberExpression(s.expression.left) &&
      t.isIdentifier(s.expression.left.property, { name: "pendingPostCompaction" }) &&
      t.isBooleanLiteral(s.expression.right, { value: true })
  );
}

/**
 * Apply all four injections to the shared AST. Returns the count of injected
 * sites (0 = already applied or no matches). The engine verifies via status_tests
 * before/after; this returns 0 rather than throwing so batch application degrades
 * gracefully across version drift.
 */
function transform(ast, inputCode) {
  // Idempotency: the sentinel string literal only exists post-patch. The engine
  // also checks the applied status_test, but this makes standalone re-runs safe.
  if (inputCode && inputCode.indexOf(SENTINEL) !== -1) return 0;

  let count = 0;
  let moduleInserted = false;

  // Parse the module once; reused if/when we find the insertion site.
  let moduleStmts = null;
  function getModuleStmts() {
    if (!moduleStmts) {
      moduleStmts = parser.parse(MODULE_SOURCE, { sourceType: "script" }).program.body;
    }
    return moduleStmts;
  }

  traverse(ast, {
    // SITE 2 (START) + SITE 3 (STOP): setter assignments.
    ExpressionStatement(p) {
      const expr = p.node.expression;
      if (!t.isAssignmentExpression(expr) || !t.isMemberExpression(expr.left)) return;
      const prop = expr.left.property;
      if (!t.isIdentifier(prop)) return;

      if (prop.name === "lastApiCompletionTimestamp") {
        p.insertAfter(buildGuardedCallStmt("__ckStart"));
        count++;
      } else if (prop.name === "lastMainRequestId") {
        p.insertAfter(buildGuardedCallStmt("__ckStop"));
        count++;
      }
    },

    // SITE 1 (CAPTURE): the SDK fetch chokepoint.
    // Shape: return await this.fetch.call(undefined, URL, OPTS)
    ReturnStatement(p) {
      const aw = p.node.argument;
      if (!t.isAwaitExpression(aw)) return;
      const call = aw.argument;
      if (!t.isCallExpression(call)) return;
      const callee = call.callee;
      if (!t.isMemberExpression(callee)) return;
      if (!t.isMemberExpression(callee.object)) return;
      // callee.object === <X>.fetch ; callee.property === call
      if (!isId(callee.object.property, "fetch") || !isId(callee.property, "call")) return;
      const args = call.arguments;
      if (!Array.isArray(args) || args.length < 3) return;
      const urlArg = args[1];
      const optsArg = args[2];
      if (!t.isIdentifier(urlArg) || !t.isIdentifier(optsArg)) return;

      // callee.object is the <holder>.fetch member expression — clone it so the
      // capture stashes exactly the fetch function being invoked (see buildCaptureStmt).
      const fetchHolder = t.cloneNode(callee.object, true);
      p.insertBefore(buildCaptureStmt(urlArg.name, optsArg.name, fetchHolder));
      count++;
    },

    // SITE 4 (MODULE) + SITE 5 (INVALIDATE).
    FunctionDeclaration(p) {
      // MODULE: insert the keepalive IIFE once, after the completion-setter fn.
      if (!moduleInserted && hasCompletionSetter(p.node)) {
        const stmts = getModuleStmts();
        for (let i = stmts.length - 1; i >= 0; i--) {
          p.insertAfter(stmts[i]);
        }
        moduleInserted = true;
        count++;
      }
      // INVALIDATE: inject __ckInvalidate() at the top of markPostCompaction's body
      // (the pendingPostCompaction=true setter) so any compaction completion clears
      // the captured body, preventing a ping that warms a stale prefix.
      if (isPostCompactionMarker(p.node)) {
        p.node.body.body.unshift(buildGuardedCallStmt("__ckInvalidate"));
        count++;
      }
    },
  });

  return count;
}

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-add-cache-keepalive.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const ast = parser.parse(code, {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript"],
  });

  const changedCount = transform(ast, code);

  if (changedCount === 0) {
    console.error(
      "add_cache_keepalive: no matching sites found (already patched or version drift)."
    );
    process.exit(1);
  }

  console.error(`add_cache_keepalive: injected ${changedCount} site(s).`);

  const output = generate(ast, { retainLines: false }, code).code;

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

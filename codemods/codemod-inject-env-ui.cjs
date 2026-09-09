#!/usr/bin/env node
// Environment changes are persisted to settings and require a restart.
// Managed-settings writes must validate the exact target before requesting elevated privileges.

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

/**
 * Read the merged env-var catalog. Curated entries (rich metadata) take precedence
 * over discovered ones by name. Returns { entries, rules }.
 * @param {Function|null} readJson - optional filename-to-catalog reader
 */
function getEnvCatalog(readJson = null) {
  const patchesDir = path.join(__dirname, "..", "patches");
  readJson ||= (file) => {
    const p = path.join(patchesDir, file);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
  };
  const curatedFile = readJson("env-catalog.json") || { curated: [], rules: [] };
  const discoveredFile = readJson("env-catalog.discovered.json");
  const discovered = discoveredFile && Array.isArray(discoveredFile.entries) ? discoveredFile.entries : [];

  const byName = new Map();
  // Discovered first (thin), curated overrides (rich).
  for (const d of discovered) {
    byName.set(d.name, {
      name: d.name,
      tier: "discovered",
      category: d.category || "Claude Code",
      type: "string",
      default: "",
      live: "restart",
      summary: "(undocumented — discovered in bundle)",
      detail: "Read " + (d.reads || 0) + "× in the baseline.",
    });
  }
  for (const c of curatedFile.curated || []) {
    byName.set(c.name, Object.assign({ tier: "curated", live: "restart" }, c));
  }

  const catOrder = (cat) => {
    const order = [
      "Provider & Auth", "Model Routing", "Streaming & Reliability", "Limits & Timeouts",
      "Toggles", "Claude Code", "Claude", "Telemetry & Privacy", "UI & UX",
      "Hidden Commands", "Agent & Subagent", "Bash & Tooling", "MCP",
    ];
    const i = order.indexOf(cat);
    return i === -1 ? 99 : i;
  };
  const entries = [...byName.values()].sort(
    (a, b) => catOrder(a.category) - catOrder(b.category) || a.name.localeCompare(b.name)
  );
  return { entries, rules: curatedFile.rules || [] };
}

/**
 * Build the Environment tab runtime component as a string template, parsed to AST
 * later. Placeholders __REACT_REF__, __REQUIRE_FN__, __INK_BOX__, __INK_TEXT__ are
 * substituted with the bundle's actual minified identifiers in buildEnvTabAST.
 *
 * Runtime behavior:
 *   - reads ~/.claude/settings.json + managed-settings + process.env
 *   - per var: resolved value + source layer (managed > user > shell-env > default)
 *   - writes: default user settings.json `env`; opt-in managed via osascript admin
 *   - restart-required badge on every row (env vars don't hot-reload)
 *   - recommendations panel (rules from the catalog)
 */
function buildEnvTabExpression() {
  const catalog = getEnvCatalog();
  let tabCode = `
function __EnvTab__() {
  var React = __REACT_REF__;
  var useState = React.useState;
  var useEffect = React.useEffect;
  var fs = __REQUIRE_FN__("fs");
  var path = __REQUIRE_FN__("path");
  var os = __REQUIRE_FN__("os");
  var child_process = __REQUIRE_FN__("child_process");

  var CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  var USER_SETTINGS = path.join(CLAUDE_DIR, "settings.json");
  var MANAGED_PATH = process.platform === "darwin" ? "/Library/Application Support/ClaudeCode/managed-settings.json" : null;

  var CATALOG = ${JSON.stringify(catalog.entries)};
  var RULES = ${JSON.stringify(catalog.rules)};

  function stripJsonComments(s) {
    // tolerant read: remove // line comments and /* */ blocks outside strings
    var out = ""; var i = 0; var inStr = false; var q = "";
    while (i < s.length) {
      var c = s[i], n = s[i+1];
      if (inStr) {
        out += c;
        if (c === "\\\\") { out += n; i += 2; continue; }
        if (c === q) inStr = false;
        i++; continue;
      }
      if (c === '"' || c === "'") { inStr = true; q = c; out += c; i++; continue; }
      if (c === "/" && n === "/") { while (i < s.length && s[i] !== "\\n") i++; continue; }
      if (c === "/" && n === "*") { i += 2; while (i < s.length && !(s[i] === "*" && s[i+1] === "/")) i++; i += 2; continue; }
      out += c; i++;
    }
    return out;
  }
  function loadJson(p) {
    try { return JSON.parse(stripJsonComments(fs.readFileSync(p, "utf8"))); }
    catch (e) { return {}; }
  }

  function resolveVar(name) {
    var procVal = process.env[name];
    var settings = loadJson(USER_SETTINGS);
    var userEnv = settings && settings.env ? settings.env : {};
    var managedEnv = {};
    if (MANAGED_PATH && fs.existsSync(MANAGED_PATH)) { var m = loadJson(MANAGED_PATH); managedEnv = m && m.env ? m.env : {}; }
    var managedVal = managedEnv[name];
    var userVal = userEnv[name];
    var value, source;
    if (managedVal !== undefined && managedVal !== null) { value = managedVal; source = "managed"; }
    else if (userVal !== undefined && userVal !== null) { value = userVal; source = "user"; }
    else if (procVal !== undefined && procVal !== null && procVal !== "") { value = procVal; source = "env"; }
    else { value = null; source = "default"; }
    return { value: value, source: source, managedLocked: managedVal !== undefined && managedVal !== null };
  }

  function writeUserEnv(name, value) {
    var obj = loadJson(USER_SETTINGS);
    if (!obj.env) obj.env = {};
    if (value === "" || value === null || value === undefined) delete obj.env[name];
    else obj.env[name] = String(value);
    try { fs.writeFileSync(USER_SETTINGS, JSON.stringify(obj, null, 2) + "\\n", "utf8"); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  }

  function shellSingle(s) {
    // Single-quote a path for /bin/sh. Both paths we pass are safe (a constant
    // managed path with one space, and an os.tmpdir() staged file with none), so
    // we only need to refuse an embedded single quote — none expected. Returning
    // null on a bad path avoids fabricating a dangerous shell fragment.
    s = String(s);
    if (s.indexOf("'") >= 0) return null;
    return "'" + s + "'";
  }
  function writeManagedEnv(name, value) {
    if (!MANAGED_PATH) return { ok: false, error: "managed settings unavailable on this platform" };
    var obj = loadJson(MANAGED_PATH);
    if (!obj.env) obj.env = {};
    if (value === "" || value === null || value === undefined) delete obj.env[name];
    else obj.env[name] = String(value);
    var staged = path.join(os.tmpdir(), "claude-env-stage-" + process.pid + ".json");
    try { fs.writeFileSync(staged, JSON.stringify(obj, null, 2) + "\\n", "utf8"); }
    catch (e) { return { ok: false, error: e.message }; }
    // Elevated copy: constant command shape, two single-quoted absolute paths, staged
    // content. Touch ID via the macOS GUI admin dialog; no TTY sudo, no shell interpolation
    // of file content (content lives in the staged file, not the command string).
    var a = shellSingle(staged), b = shellSingle(MANAGED_PATH);
    if (!a || !b) { try { fs.unlinkSync(staged); } catch (e2) {} return { ok: false, error: "path quoting failed" }; }
    var script = "do shell script \\"cp " + a + " " + b + "\\" with administrator privileges";
    var r = child_process.spawnSync("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    try { fs.unlinkSync(staged); } catch (e) {}
    if (r.status === 0) return { ok: true };
    return { ok: false, error: (r.stderr && r.stderr.toString()) || "elevation failed" };
  }

  function applyEdit(entry, value) {
    if (writeTarget === "managed") {
      var r = writeManagedEnv(entry.name, value);
      if (!r.ok && value !== "" && value !== null) {
        // fall back to user settings if managed elevation refused
        var r2 = writeUserEnv(entry.name, value);
        return r2.ok ? { ok: true, note: "managed auth refused; wrote user settings (overridable)" } : r2;
      }
      return r;
    }
    return writeUserEnv(entry.name, value);
  }

  // ---- state ----
  var _c = useState(0); var cursor = _c[0]; var setCursor = _c[1];
  var _sm = useState(false); var searchMode = _sm[0]; var setSearchMode = _sm[1];
  var _sq = useState(""); var searchQuery = _sq[0]; var setSearchQuery = _sq[1];
  var _wt = useState("user"); var writeTarget = _wt[0]; var setWriteTarget = _wt[1];
  var _dv = useState(null); var detail = _dv[0]; var setDetail = _dv[1];
  var _ev = useState(""); var editValue = _ev[0]; var setEditValue = _ev[1];
  var _ed = useState(false); var editing = _ed[0]; var setEditing = _ed[1];
  var _rv = useState(false); var showRecs = _rv[0]; var setShowRecs = _rv[1];
  var _tg = useState(""); var toast = _tg[0]; var setToast = _tg[1];
  var _tk = useState(0); var tick = _tk[0]; var setTick = _tk[1]; // force re-resolve after a write

  useEffect(function() {
    if (!toast) return;
    var h = setTimeout(function() { setToast(""); }, 2200);
    return function() { clearTimeout(h); };
  }, [toast]);

  // ---- derived ----
  var filtered = CATALOG;
  if (searchQuery) {
    var q = searchQuery.toLowerCase();
    filtered = CATALOG.filter(function(e) {
      return (e.name.toLowerCase().indexOf(q) >= 0) || ((e.summary || "").toLowerCase().indexOf(q) >= 0);
    });
  }
  var total = filtered.length;
  var effectiveCursor = total > 0 ? Math.min(cursor, total - 1) : 0;

  function isTrue(v) { return v === "1" || v === "true" || v === true; }
  function sourceColor(source) {
    return source === "managed" ? "magenta" : source === "user" ? "cyan" : source === "env" ? "yellow" : "gray";
  }
  function sourceLabel(source) {
    return source === "managed" ? "managed" : source === "user" ? "user" : source === "env" ? "shell" : "default";
  }
  function shortText(value, max) {
    value = String(value == null ? "" : value);
    if (value.length <= max) return value;
    return value.slice(0, Math.max(1, max - 1)) + "\\u2026";
  }
  function displayValue(entry, resolved, max) {
    if (entry.type === "secret") return resolved.value ? "********" : "-";
    if (resolved.value === null) return "-";
    if (entry.type === "boolean") return isTrue(resolved.value) ? "on" : "off";
    return shortText(String(resolved.value), max || 48);
  }

  function evalRule(rule) {
    try {
      if (rule.id === "non_anthropic_base_url") {
        var b = process.env.ANTHROPIC_BASE_URL || "";
        if (!b) return false;
        var hasScheme = b.indexOf("://") > 0;
        var isAnth = b.indexOf("api.anthropic.com") >= 0;
        return hasScheme && !isAnth
          && !(isTrue(process.env.CLAUDE_ENABLE_STREAM_WATCHDOG) && isTrue(process.env.CLAUDE_ENABLE_BYTE_WATCHDOG));
      }
      if (rule.id === "retry_budget") {
        var retries = Number(process.env.CLAUDE_CODE_MAX_RETRIES || 10);
        var timeout = Number(process.env.API_TIMEOUT_MS || 300000);
        return retries * timeout > 3600000;
      }
      if (rule.id === "auth_token_user_settings") {
        var s = loadJson(USER_SETTINGS);
        return !!(s.env && s.env.ANTHROPIC_AUTH_TOKEN);
      }
    } catch (e) {}
    return false;
  }

  function handleKeyDown(evt) {
    var input = (evt.key && evt.key.length === 1 && !evt.ctrl && !evt.meta) ? evt.key : "";
    var isUp = evt.name === "up", isDown = evt.name === "down", isReturn = evt.name === "return";
    var isEscape = evt.name === "escape", isBackspace = evt.name === "backspace" || evt.name === "delete";

    if (showRecs) {
      if (isEscape || isReturn) setShowRecs(false);
      return;
    }

    // edit mode (string/number typing)
    if (editing && detail) {
      var ent = CATALOG.find(function(e) { return e.name === detail; });
      if (isEscape) { setEditing(false); setEditValue(""); }
      else if (isReturn) {
        var v = editValue;
        // numbers coerce
        if (ent.type === "number") { var n = Number(v); v = Number.isFinite(n) ? String(n) : ""; }
        var r = applyEdit(ent, v);
        setEditing(false); setEditValue("");
        setToast(r.ok ? ("saved " + ent.name + " (" + writeTarget + ")") : ("error: " + (r.error || "unknown")));
        setTick(tick + 1);
      } else if (isBackspace) { setEditValue(function(x) { return x.slice(0, -1); }); }
      else if (input) { setEditValue(function(x) { return x + input; }); }
      return;
    }

    // detail view
    if (detail) {
      var ent = CATALOG.find(function(e) { return e.name === detail; });
      if (!ent) { setDetail(null); return; }
      if (isEscape) { setDetail(null); }
      else if (isReturn || (input === " " && ent.type === "boolean")) {
        if (ent.type === "boolean") {
          var cur = resolveVar(ent.name);
          var r = applyEdit(ent, isTrue(cur.value) ? "" : "1");
          setToast(r.ok ? ("toggled " + ent.name) : ("error: " + (r.error || "unknown")));
          setTick(tick + 1);
        } else {
          var cur2 = resolveVar(ent.name);
          setEditing(true); setEditValue(cur2.value === null ? "" : String(cur2.value));
        }
      } else if (input === "t") {
        setWriteTarget(writeTarget === "user" ? "managed" : "user");
        setToast("write target: " + (writeTarget === "user" ? "managed" : "user"));
      } else if (input === "c") {
        // clear (remove from target layer)
        var rc = applyEdit(ent, "");
        setToast(rc.ok ? ("cleared " + ent.name) : ("error: " + (rc.error || "unknown")));
        setTick(tick + 1);
      }
      return;
    }

    // search mode
    if (searchMode) {
      if (isEscape) { if (searchQuery.length) setSearchQuery(""); else setSearchMode(false); }
      else if (isReturn || isDown) { if (total > 0) { setSearchMode(false); setCursor(0); } }
      else if (isBackspace) { setSearchQuery(function(x) { return x.slice(0, -1); }); }
      else if (input && input >= " ") { setSearchQuery(function(x) { return x + input; }); }
      return;
    }

    // navigation
    if (input === "/") { setCursor(0); setSearchMode(true); setSearchQuery(""); return; }
    if (input === "r") { setShowRecs(true); return; }
    if (total === 0) return;
    if (isUp) setCursor(function(p) { return Math.max(0, p - 1); });
    else if (isDown) setCursor(function(p) { return Math.min(total - 1, p + 1); });
    else if (input === " ") {
      var sel = filtered[effectiveCursor];
      if (sel && sel.type === "boolean") {
        var cur3 = resolveVar(sel.name);
        var rt = applyEdit(sel, isTrue(cur3.value) ? "" : "1");
        setToast(rt.ok ? ("toggled " + sel.name) : ("error: " + (rt.error || "unknown")));
        setTick(tick + 1);
      }
    } else if (isReturn) {
      var sel2 = filtered[effectiveCursor];
      if (sel2) setDetail(sel2.name);
    } else if (input === "t") {
      setWriteTarget(writeTarget === "user" ? "managed" : "user");
      setToast("write target: " + (writeTarget === "user" ? "managed" : "user"));
    }
  }

  // ---- recommendations view ----
  if (showRecs) {
    var fireRules = RULES.filter(evalRule);
    var recEls = [];
    recEls.push(React.createElement(V, { key: "h", bold: true }, "Recommendations"));
    if (fireRules.length === 0) {
      recEls.push(React.createElement(V, { key: "empty", dimColor: true, marginTop: 1 }, "No active recommendations for this configuration."));
    }
    fireRules.forEach(function(rule) {
      recEls.push(React.createElement(B, { key: rule.id, marginTop: 1 },
        React.createElement(V, { color: rule.severity === "warn" ? "yellow" : "cyan", bold: true }, rule.title),
        React.createElement(V, { dimColor: true }, rule.rationale)
      ));
    });
    recEls.push(React.createElement(V, { key: "help", dimColor: true, marginTop: 1 }, "Esc back"));
    return React.createElement.apply(React, [B, { flexDirection: "column", tabIndex: 0, onKeyDown: handleKeyDown }].concat(recEls));
  }

  // ---- detail view ----
  if (detail) {
    var ent = CATALOG.find(function(e) { return e.name === detail; });
    if (!ent) return null;
    var res = resolveVar(ent.name);
    var dEls = [];
    dEls.push(React.createElement(V, { key: "n", bold: true }, ent.name));
    dEls.push(React.createElement(B, { key: "meta" },
      React.createElement(V, { dimColor: true }, ent.category + "  "),
      React.createElement(V, { color: ent.tier === "curated" ? "green" : "gray" }, ent.tier === "curated" ? "documented" : "discovered")
    ));
    var badgeColor = sourceColor(res.source);
    var valShown = ent.type === "secret" ? (res.value ? "********" : "(unset)") : (res.value === null ? "(unset)" : shortText(String(res.value), 96));
    dEls.push(React.createElement(B, { key: "v", marginTop: 1 },
      React.createElement(V, { dimColor: true }, "Value: "),
      React.createElement(V, { color: valShown === "(unset)" ? "gray" : "green" }, valShown + " "),
      React.createElement(V, { color: badgeColor }, "[" + sourceLabel(res.source) + "]"),
      React.createElement(V, { italic: true, dimColor: true }, "  restart required")
    ));
    if (ent.summary) dEls.push(React.createElement(V, { key: "s", marginTop: 1 }, ent.summary));
    if (ent.detail) dEls.push(React.createElement(V, { key: "d", dimColor: true }, ent.detail));
    if (res.managedLocked) dEls.push(React.createElement(V, { key: "lock", color: "magenta", italic: true }, "set in managed policy (non-overridable); edit managed with the 't' target"));
    dEls.push(React.createElement(V, { key: "wt", dimColor: true, marginTop: 1 }, "write target: " + writeTarget));
    if (editing) dEls.push(React.createElement(V, { key: "edit", color: "yellow", inverse: true }, editValue + "\\u258B"));
    dEls.push(React.createElement(V, { key: "h", dimColor: true, marginTop: 1 },
      (ent.type === "boolean" ? "Space/Enter toggle" : "Enter edit") + " \\u00b7 t target \\u00b7 c clear \\u00b7 Esc back"));
    return React.createElement.apply(React, [B, { flexDirection: "column", tabIndex: 0, onKeyDown: handleKeyDown }].concat(dEls));
  }

  // ---- list view ----
  var termRows = process.stdout.rows || 24;
  var viewport = Math.max(3, termRows - 7);
  var start = Math.max(0, effectiveCursor - Math.floor(viewport / 2));
  start = Math.min(start, Math.max(0, total - viewport));
  var visible = filtered.slice(start, start + viewport);
  var above = start;
  var below = total - start - visible.length;

  var els = [];
  els.push(React.createElement(B, { key: "top" },
    React.createElement(V, { color: "gray" }, "\\u2315 "),
    searchQuery.length === 0
      ? React.createElement(V, { dimColor: true }, "Search " + total + "/" + CATALOG.length + " env vars\\u2026  target:" + writeTarget + "  managed:" + (MANAGED_PATH ? "available" : "n/a"))
      : React.createElement(V, null, searchQuery, "\\u2588")
  ));
  els.push(React.createElement(V, { key: "sp" }, ""));
  if (above > 0) {
    els.push(React.createElement(V, { key: "above", dimColor: true }, "\\u2191 " + above + " more above"));
  }

  var lastCat = null;
  for (var i = 0; i < visible.length; i++) {
    var e = visible[i];
    var realIdx = start + i;
    var selected = realIdx === effectiveCursor;
    if (e.category !== lastCat) {
      lastCat = e.category;
      els.push(React.createElement(V, { key: "cat-" + realIdx, dimColor: true, bold: true }, "\\u2500 " + e.category + " \\u2500"));
    }
    var r = resolveVar(e.name);
    var col = sourceColor(r.source);
    var val = displayValue(e, r, 56);
    var srcTag = sourceLabel(r.source);
    els.push(React.createElement(B, { key: e.name },
      React.createElement(B, { width: 46 },
        React.createElement(V, { color: selected ? "white" : undefined }, (selected ? "\\u25B6 " : "  ") + shortText(e.name, 43))
      ),
      React.createElement(B, { width: 10 },
        React.createElement(V, { color: col }, srcTag)
      ),
      React.createElement(V, { color: col }, val)
    ));
  }
  if (below > 0) {
    els.push(React.createElement(V, { key: "below", dimColor: true }, "\\u2193 " + below + " more below"));
  }
  if (total === 0 && searchQuery.length > 0) {
    els.push(React.createElement(V, { key: "empty", italic: true, dimColor: true }, 'No env vars match "' + searchQuery + '"'));
  }

  if (toast) {
    els.push(React.createElement(V, { key: "toast", color: "green", italic: true }, toast));
  }
  els.push(React.createElement(V, { key: "help", dimColor: true }, "Enter details \\u00b7 Space toggle booleans \\u00b7 t target \\u00b7 r recs \\u00b7 / search"));
  return React.createElement.apply(React, [B, { flexDirection: "column", tabIndex: 0, autoFocus: true, onKeyDown: handleKeyDown }].concat(els));
}
`;
  tabCode = tabCode.replace(/createElement\(\s*B,/g, "createElement(__INK_BOX__,");
  tabCode = tabCode.replace(/createElement\(\s*V,/g, "createElement(__INK_TEXT__,");
  tabCode = tabCode.replace(/\[\s*B,/g, "[__INK_BOX__,");
  tabCode = tabCode.replace(/\[\s*V,/g, "[__INK_TEXT__,");
  return tabCode;
}

/**
 * Discover ink Box/Text minified identifiers. Structural match on the
 * anyCallee(target, { Box: () => X, Text: () => Y, ... }) export pattern —
 * callee name is a minifier artifact, never checked. Duplicated from
 * codemod-inject-mods-ui.cjs because codemods are intentionally standalone.
 */
function discoverInkComponentNames(ast) {
  let boxName = null;
  let textName = null;
  const candidates = [];
  traverse(ast, {
    CallExpression(path) {
      if (boxName && textName) return;
      if (path.node.arguments.length < 2) return;
      const exportsObj = path.node.arguments[1];
      if (!t.isObjectExpression(exportsObj)) return;
      const hasBoxOrText = exportsObj.properties.some(p =>
        t.isObjectProperty(p) && t.isIdentifier(p.key) && (p.key.name === "Box" || p.key.name === "Text"));
      if (!hasBoxOrText) return;
      for (const prop of exportsObj.properties) {
        if (!t.isObjectProperty(prop) || !t.isIdentifier(prop.key)) continue;
        let name = null;
        if (prop.key.name === "Box" || prop.key.name === "Text") {
          if (t.isArrowFunctionExpression(prop.value)) {
            if (t.isIdentifier(prop.value.body)) name = prop.value.body.name;
            else if (t.isBlockStatement(prop.value.body)) {
              const stmts = prop.value.body.body;
              if (stmts.length === 1 && t.isReturnStatement(stmts[0]) && t.isIdentifier(stmts[0].argument)) name = stmts[0].argument.name;
            }
          } else if (t.isIdentifier(prop.value)) name = prop.value.name;
        }
        if (prop.key.name === "Box" && name) boxName = name;
        if (prop.key.name === "Text" && name) textName = name;
      }
    },
    VariableDeclarator(varPath) {
      if (!t.isIdentifier(varPath.node.id) || !t.isMemberExpression(varPath.node.init)) return;
      if (varPath.node.init.computed || !t.isIdentifier(varPath.node.init.property) || !t.isIdentifier(varPath.node.init.object)) return;
      if (varPath.node.init.property.name === "Box" || varPath.node.init.property.name === "Text") {
        candidates.push({ propName: varPath.node.init.property.name, moduleName: varPath.node.init.object.name, varName: varPath.node.id.name });
      }
    },
  });
  if (!boxName || !textName) {
    const box = candidates.filter(c => c.propName === "Box" && !boxName);
    const txt = candidates.filter(c => c.propName === "Text" && !textName);
    for (const bc of box) {
      const m = txt.find(tc => tc.moduleName === bc.moduleName);
      if (m) { boxName = bc.varName; textName = m.varName; break; }
    }
  }
  return { boxName, textName };
}

function buildEnvTabAST(reactName, requireFnName, boxName, textName) {
  let code = buildEnvTabExpression();
  code = code.replace(/__REACT_REF__/g, reactName);
  code = code.replace(/__REQUIRE_FN__/g, requireFnName);
  code = code.replace(/__INK_BOX__/g, boxName);
  code = code.replace(/__INK_TEXT__/g, textName);
  const ast = parser.parse(code, { sourceType: "unambiguous", plugins: ["jsx", "typescript"] });
  return ast.program.body[0];
}

/**
 * Inject the Environment tab: find the Stats tab element (captures React var +
 * tab wrapper), find the tab array (SpreadElement) in the same scope, resolve the
 * require fn (ESM createRequire or CJS wrapper), insert __EnvTab__ before the
 * panel function, and splice an "Environment" tab element before the spread.
 */
function transform(ast) {
  let statsTabPath = null;
  let tabArrayPath = null;
  let reactVar = null;
  let tabComp = null;
  let parentFnPath = null;
  let createRequireAlias = null;
  let requireFnName = null;
  let alreadyApplied = false;

  traverse(ast, {
    CallExpression(callPath) {
      if (alreadyApplied) return;
      const callee = callPath.node.callee;
      if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.property, { name: "createElement" })) return;
      const args = callPath.node.arguments;
      if (args.length < 2) return;
      const propsArg = args[1];
      if (!t.isObjectExpression(propsArg)) return;

      if (!alreadyApplied) {
        const hasEnvTitle = propsArg.properties.some(p =>
          t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "title" }) && t.isStringLiteral(p.value, { value: "Environment" }));
        if (hasEnvTitle) { alreadyApplied = true; return; }
      }
      if (!statsTabPath) {
        const hasStatsTitle = propsArg.properties.some(p =>
          t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "title" }) && t.isStringLiteral(p.value, { value: "Stats" }));
        if (hasStatsTitle) {
          statsTabPath = callPath;
          reactVar = callee.object;
          tabComp = args[0];
          parentFnPath = callPath.getFunctionParent();
        }
      }
    },
    ImportDeclaration(path) {
      if (createRequireAlias) return;
      if (path.node.source.value !== "node:module") return;
      for (const spec of path.node.specifiers) {
        if (t.isImportSpecifier(spec) && t.isIdentifier(spec.imported, { name: "createRequire" })) {
          createRequireAlias = spec.local.name;
        }
      }
    },
  });
  if (alreadyApplied) return 0;
  if (!statsTabPath || !parentFnPath) return 0;

  traverse(ast, {
    ArrayExpression(arrayPath) {
      if (tabArrayPath) return;
      if (arrayPath.getFunctionParent() !== parentFnPath) return;
      const hasSpread = arrayPath.node.elements.some(e => t.isSpreadElement(e));
      if (!hasSpread) return;
      tabArrayPath = arrayPath;
    },
    Program(programPath) {
      if (!createRequireAlias || requireFnName) return;
      const body = programPath.node.body;
      for (let i = 0; i < body.length; i++) {
        if (!t.isVariableDeclaration(body[i])) continue;
        for (const decl of body[i].declarations) {
          if (t.isCallExpression(decl.init) && t.isIdentifier(decl.init.callee, { name: createRequireAlias }) && decl.init.arguments.length === 1) {
            const arg = decl.init.arguments[0];
            if (t.isMemberExpression(arg) && t.isMetaProperty(arg.object) && t.isIdentifier(arg.property, { name: "url" })) {
              requireFnName = decl.id.name;
            }
          }
        }
      }
    },
  });
  if (!tabArrayPath) return 0;

  if (!requireFnName) {
    const firstExpr = ast.program.body.find(n => t.isExpressionStatement(n) && !t.isDirective(n));
    if (firstExpr) {
      let fnExpr = firstExpr.expression;
      for (let i = 0; i < 4 && fnExpr && !t.isFunctionExpression(fnExpr); i++) {
        if (t.isCallExpression(fnExpr)) {
          if (t.isFunctionExpression(fnExpr.callee)) fnExpr = fnExpr.callee;
          else if (fnExpr.arguments.length > 0) fnExpr = fnExpr.arguments[0];
          else break;
        } else if (t.isUnaryExpression(fnExpr)) fnExpr = fnExpr.argument;
        else break;
      }
      if (t.isFunctionExpression(fnExpr) && fnExpr.params.some(p => t.isIdentifier(p, { name: "require" }))) {
        requireFnName = "require";
      }
    }
  }
  if (!requireFnName) {
    console.error("Warning: could not find createRequire(import.meta.url) or CJS wrapper; Environment tab may not work.");
    return 0;
  }

  const { boxName: dBox, textName: dText } = discoverInkComponentNames(ast);
  const boxName = dBox || "B";
  const textName = dText || "V";
  if (!dBox || !dText) {
    console.error(`Warning: could not discover ink Box/Text names; using fallback B/${dText || "V"}.`);
  }

  const fnDecl = buildEnvTabAST(reactVar.name, requireFnName, boxName, textName);
  parentFnPath.insertBefore(fnDecl);

  const envTabElement = t.callExpression(
    t.memberExpression(t.cloneNode(reactVar), t.identifier("createElement")),
    [
      t.cloneNode(tabComp),
      t.objectExpression([
        t.objectProperty(t.identifier("key"), t.stringLiteral("environment")),
        t.objectProperty(t.identifier("title"), t.stringLiteral("Environment")),
      ]),
      t.callExpression(
        t.memberExpression(t.cloneNode(reactVar), t.identifier("createElement")),
        [t.identifier("__EnvTab__"), t.nullLiteral()]
      ),
    ]
  );

  const elements = tabArrayPath.node.elements;
  const spreadIdx = elements.findIndex(e => t.isSpreadElement(e));
  if (spreadIdx === -1) return 0;
  elements.splice(spreadIdx, 0, envTabElement);
  return 2;
}

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-inject-env-ui.cjs <input.js> [output.js]");
    process.exit(1);
  }
  const code = fs.readFileSync(path.resolve(inputFile), "utf8");
  const ast = parser.parse(code, { sourceType: "unambiguous", plugins: ["jsx", "typescript"] });
  const changed = transform(ast);
  if (changed === 0) console.error("No matching config tab structure found; nothing changed.");
  else console.error(`Injected Environment tab into config UI (${changed} location(s)).`);
  const output = generate(ast, { retainLines: false }, code).code;
  if (outputFile) fs.writeFileSync(path.resolve(outputFile), output, "utf8");
  else process.stdout.write(output);
}

module.exports = { transform, getEnvCatalog, buildEnvTabExpression };

if (require.main === module) {
  main();
}

#!/usr/bin/env node
// Discover the existing tab component and React binding from neighboring config tabs; do not hardcode generated names.

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

/**
 * Build the Mods tab content component as an inline function.
 *
 * Renders a list of toggleable mods with LIVE/RESTART badges.
 * Reads/writes ~/.claude/mods.json for persistence.
 */
function buildModsTabExpression() {
  // Build source with discovered React and Ink bindings, then parse it into an AST.
  // Use focusable-Box key events for input; component names must be discovered.
  let tabCode = `
function __ModsTab__() {
  var React = __REACT_REF__;
  var useState = React.useState;
  var useEffect = React.useEffect;
  var fs = __REQUIRE_FN__("fs");
  var path = __REQUIRE_FN__("path");
  var os = __REQUIRE_FN__("os");

  var MODS_PATH = path.join(
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
    "mods.json"
  );

  // Build-time registry from patch YAML files. Patches added after codemod
  // execution won't appear — re-run patching to pick up new entries.
  var MOD_REGISTRY = ${JSON.stringify(getModRegistry())};

  // --- Persistence ---

  function loadMods() {
    try {
      var data = JSON.parse(fs.readFileSync(MODS_PATH, "utf8"));
      return (data && typeof data === "object" && !Array.isArray(data)) ? data : {};
    } catch (e) {
      return {};
    }
  }

  function saveMods(mods) {
    try {
      var dir = path.dirname(MODS_PATH);
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
      fs.writeFileSync(MODS_PATH, JSON.stringify(mods, null, 2) + "\\n", "utf8");
    } catch (e) {
      console.error("Failed to save mods: " + e.message);
    }
  }

  function getConfigValue(mods, modId, field) {
    var flatKey = modId + "_" + field.key;
    if (mods[flatKey] !== undefined) return mods[flatKey];
    return field.default;
  }

  function setConfigValue(mods, setMods, modId, field, value) {
    var next = Object.assign({}, mods);
    var flatKey = modId + "_" + field.key;
    if (value === field.default) {
      delete next[flatKey];
    } else {
      next[flatKey] = value;
    }
    setMods(next);
    saveMods(next);
  }

  // --- State ---

  var _s = useState(loadMods); var mods = _s[0]; var setMods = _s[1];
  var _c = useState(0); var cursor = _c[0]; var setCursor = _c[1];
  var _sm = useState(false); var searchMode = _sm[0]; var setSearchMode = _sm[1];
  var _sq = useState(""); var searchQuery = _sq[0]; var setSearchQuery = _sq[1];

  // Detail view state (description + optional config editing)
  var _cv = useState(null); var detailView = _cv[0]; var setDetailView = _cv[1];
  var _cc = useState(0); var configCursor = _cc[0]; var setConfigCursor = _cc[1];
  var _ef = useState(null); var editField = _ef[0]; var setEditField = _ef[1];
  var _ev = useState(""); var editValue = _ev[0]; var setEditValue = _ev[1];

  // --- Derived data (recomputed every render, cheap for ~15 items) ---

  var filtered = MOD_REGISTRY;
  if (searchQuery) {
    var q = searchQuery.toLowerCase();
    filtered = MOD_REGISTRY.filter(function(mod) {
      return mod.name.toLowerCase().indexOf(q) >= 0
        || mod.description.toLowerCase().indexOf(q) >= 0;
    });
  }

  var totalMods = filtered.length;
  // Clamp cursor into valid range when filter narrows results
  var effectiveCursor = totalMods > 0 ? Math.min(cursor, totalMods - 1) : 0;
  var enabledCount = MOD_REGISTRY.filter(function(mod) { return mods[mod.id] === true; }).length;

  function categoryLabel(mod) {
    if (!mod.category) return "Other";
    return mod.category.split(/[_-]+/).map(function(part) {
      return part ? part.charAt(0).toUpperCase() + part.slice(1) : part;
    }).join(" ");
  }

  function shortText(value, max) {
    value = String(value == null ? "" : value);
    if (value.length <= max) return value;
    return value.slice(0, Math.max(1, max - 1)) + "\\u2026";
  }

  function fieldDisplayValue(field, value) {
    if (field.type === "boolean") return value ? "ON" : "OFF";
    if (field.type === "select" && Array.isArray(field.options)) {
      var match = field.options.find(function(option) { return option.value === value; });
      return match ? match.label + " (" + value + ")" : String(value);
    }
    return String(value);
  }

  function cycleSelectValue(modId, field) {
    if (!Array.isArray(field.options) || field.options.length === 0) return;
    var current = getConfigValue(mods, modId, field);
    var idx = field.options.findIndex(function(option) { return option.value === current; });
    var next = field.options[(idx + 1) % field.options.length];
    if (next) setConfigValue(mods, setMods, modId, field, next.value);
  }

  // --- Detail view validation ---
  useEffect(function() {
    if (detailView) {
      var valid = MOD_REGISTRY.some(function(m) { return m.id === detailView; });
      if (!valid) {
        setDetailView(null);
        setConfigCursor(0);
      }
    }
  }, [detailView]);

  // --- Input handling via onKeyDown (2.1.136+ pattern) ---
  // Key events: { name: "return"|"down"|"up"|"escape", key: string, ctrl, shift, meta }
  function handleKeyDown(evt) {
    var input = (evt.key && evt.key.length === 1 && !evt.ctrl && !evt.meta) ? evt.key : "";
    var isUp = evt.name === "up";
    var isDown = evt.name === "down";
    var isReturn = evt.name === "return";
    var isEscape = evt.name === "escape";
    var isBackspace = evt.name === "backspace" || evt.name === "delete";

    // -- Detail view mode --
    if (detailView) {
      var cmod = MOD_REGISTRY.find(function(m) { return m.id === detailView; });
      if (!cmod) {
        setDetailView(null);
        return;
      }
      var hasFields = cmod.config && cmod.config.length > 0;
      var fields = hasFields ? cmod.config : [];

      // Field editing sub-mode
      if (editField !== null) {
        var field = fields[editField];
        if (isEscape) {
          setEditField(null);
          setEditValue("");
        } else if (isReturn) {
          if (field.type === "number") {
            var n = Number(editValue);
            if (Number.isFinite(n)) {
              var min = field.min !== undefined ? field.min : -Infinity;
              var max = field.max !== undefined ? field.max : Infinity;
              n = Math.min(max, Math.max(min, n));
              setConfigValue(mods, setMods, detailView, field, n);
            }
          } else {
            setConfigValue(mods, setMods, detailView, field, editValue);
          }
          setEditField(null);
          setEditValue("");
        } else if (isBackspace) {
          setEditValue(function(v) { return v.slice(0, -1); });
        } else if (input && !isUp && !isDown) {
          setEditValue(function(v) { return v + input; });
        }
        return;
      }

      if (isEscape) {
        setDetailView(null);
        setConfigCursor(0);
      } else if (isUp && hasFields) {
        setConfigCursor(function(p) { return Math.max(0, p - 1); });
      } else if (isDown && hasFields) {
        setConfigCursor(function(p) { return Math.min(fields.length - 1, p + 1); });
      } else if (input === " ") {
        var next = Object.assign({}, mods);
        next[cmod.id] = !mods[cmod.id];
        setMods(next);
        saveMods(next);
      } else if (input === "c" && hasFields) {
        var reset = fields[configCursor];
        if (reset) setConfigValue(mods, setMods, detailView, reset, reset.default);
      } else if (isReturn && hasFields) {
        var sel = fields[configCursor];
        if (sel) {
          if (sel.type === "boolean") {
            var cur = getConfigValue(mods, detailView, sel);
            setConfigValue(mods, setMods, detailView, sel, !cur);
          } else if (sel.type === "select") {
            cycleSelectValue(detailView, sel);
          } else {
            setEditField(configCursor);
            setEditValue(String(getConfigValue(mods, detailView, sel)));
          }
        }
      }
      return;
    }

    // -- Search mode --
    if (searchMode) {
      if (isEscape) {
        if (searchQuery.length > 0) {
          setSearchQuery("");
        } else {
          setSearchMode(false);
        }
      } else if (isReturn || isDown) {
        if (totalMods > 0) {
          setSearchMode(false);
          setCursor(0);
        }
      } else if (isBackspace) {
        setSearchQuery(function(q) { return q.slice(0, -1); });
      } else if (input && input >= " ") {
        setSearchQuery(function(q) { return q + input; });
      }
      return;
    }

    // -- Navigation mode --
    function getSelectedMod(cur) {
      return filtered[cur] || null;
    }
    if (input === "/") {
      setCursor(0);
      setSearchMode(true);
      setSearchQuery("");
      return;
    }
    if (totalMods === 0) {
      if (input && input >= " " && input !== " ") {
        setCursor(0);
        setSearchMode(true);
        setSearchQuery(input);
      }
      return;
    }
    if (isUp) {
      setCursor(function(p) { return Math.max(0, p - 1); });
    } else if (isDown) {
      setCursor(function(p) { return Math.min(totalMods - 1, p + 1); });
    } else if (input === " ") {
      var mod = getSelectedMod(effectiveCursor);
      if (mod) {
        var next = Object.assign({}, mods);
        next[mod.id] = !mods[mod.id];
        setMods(next);
        saveMods(next);
      }
    } else if (isReturn) {
      var dmod = getSelectedMod(effectiveCursor);
      if (dmod) {
        setDetailView(dmod.id);
        setConfigCursor(0);
      }
    } else if (input && input >= " " && input !== " ") {
      setCursor(0);
      setSearchMode(true);
      setSearchQuery(input);
    }
  }

  // --- Detail view rendering ---
  if (detailView) {
    var cmod = MOD_REGISTRY.find(function(m) { return m.id === detailView; });
    if (!cmod) {
      return null;
    }
    var hasFields = cmod.config && cmod.config.length > 0;
    var fields = hasFields ? cmod.config : [];
    var isOn = mods[cmod.id] === true;
    var detailElements = [];
    // Header: patch name
    detailElements.push(
      React.createElement(V, { key: "title", bold: true }, cmod.name)
    );
    detailElements.push(
      React.createElement(B, { key: "meta" },
        React.createElement(V, { dimColor: true }, cmod.id + "  "),
        React.createElement(V, { color: cmod.live ? "green" : "yellow" }, cmod.live ? "live toggle" : "restart required")
      )
    );
    // Status line: enabled/disabled + optional restart-required
    var statusParts = [
      React.createElement(V, { key: "lbl", dimColor: true }, "Status: "),
      React.createElement(V, { key: "val", color: isOn ? "green" : "gray" }, isOn ? "enabled" : "disabled")
    ];
    if (!cmod.live) {
      statusParts.push(React.createElement(V, { key: "rs", italic: true, dimColor: true }, "  restart required"));
    }
    detailElements.push(
      React.createElement(B, { key: "status", marginTop: 1 }, statusParts)
    );
    // Description
    if (cmod.description) {
      detailElements.push(
        React.createElement(V, { key: "desc", marginTop: 1 }, cmod.description)
      );
    }
    // Config fields (if any)
    if (hasFields) {
      detailElements.push(
        React.createElement(V, { key: "cfg-hdr", dimColor: true, bold: true, marginTop: 1 }, "\\u2500\\u2500 Config \\u2500\\u2500")
      );
      var fieldElements = fields.map(function(field, idx) {
        var val = getConfigValue(mods, detailView, field);
        var selected = idx === configCursor;
        var editing = editField === idx;
        var displayVal = fieldDisplayValue(field, val);
        var changed = val !== field.default;
        return React.createElement(
          B,
          { key: field.key, marginTop: 1 },
          React.createElement(
            V,
            { color: selected ? "white" : "gray" },
            selected ? "\\u25B6 " : "  "
          ),
          React.createElement(V, { bold: selected, dimColor: !selected }, field.label + ": "),
          editing
            ? React.createElement(V, { color: "yellow", inverse: true }, editValue + "\\u258B")
            : React.createElement(
                V,
                { color: field.type === "boolean" ? (val ? "green" : "gray") : "cyan" },
                shortText(displayVal, 56)
              )
          ,
          changed
            ? React.createElement(V, { color: "yellow" }, "  modified")
            : React.createElement(V, { dimColor: true }, "  default"),
          field.description && selected
            ? React.createElement(V, { dimColor: true }, "  " + shortText(field.description, 70))
            : null
          ,
          field.env_check
            ? React.createElement(V,
                { color: process.env[field.env_check] ? "green" : "yellow" },
                (process.env[field.env_check] ? "\\u2713 env " : "\\u26A0 env unset: ") + field.env_check + (field.env_hint ? " \\u2014 " + shortText(field.env_hint, 56) : ""))
            : (field.env_hint
              ? React.createElement(V, { dimColor: true }, "\\u2014 " + shortText(field.env_hint, 62))
              : null)
        );
      });
      detailElements.push.apply(detailElements, fieldElements);
    }
    // Help bar
    var detailHelp = "Space toggle \\u00b7 ";
    if (hasFields) {
      detailHelp += "\\u2191/\\u2193 config \\u00b7 Enter edit/cycle \\u00b7 c default \\u00b7 ";
    }
    detailHelp += "Esc back";
    detailElements.push(
      React.createElement(V, { key: "help", dimColor: true, marginTop: 1 }, detailHelp)
    );
    return React.createElement.apply(
      React,
      [B, { flexDirection: "column", tabIndex: 0, onKeyDown: handleKeyDown }].concat(detailElements)
    );
  }

  // --- Mod list rendering (redesigned) ---

  // Viewport: reserve rows for search bar, spacer, possible scroll indicators, help bar
  var termRows = process.stdout.rows || 24;
  var viewportRows = Math.max(3, termRows - 5);

  // Center the selected item in the scroll window
  var scrollStart = Math.max(0, effectiveCursor - Math.floor(viewportRows / 2));
  scrollStart = Math.min(scrollStart, Math.max(0, totalMods - viewportRows));
  var visibleMods = filtered.slice(scrollStart, scrollStart + viewportRows);
  var aboveCount = scrollStart;
  var belowCount = totalMods - scrollStart - visibleMods.length;

  // Collect render elements
  var elements = [];

  // 1. Search bar (replicating Config tab's inline search pattern)
  elements.push(
    React.createElement(B, { key: "search-bar" },
      React.createElement(V, { color: "gray" }, "\\u2315 "),
      searchQuery.length === 0
        ? React.createElement(V, { dimColor: true }, "Search " + totalMods + " mods\\u2026  enabled:" + enabledCount + "/" + MOD_REGISTRY.length)
        : React.createElement(V, null, searchQuery, "\\u2588")
    )
  );

  // 2. Spacer
  elements.push(React.createElement(V, { key: "spacer" }, ""));

  // 3. Scroll indicator: items above viewport
  if (aboveCount > 0) {
    elements.push(
      React.createElement(V, { key: "scroll-above", dimColor: true },
        "\\u2191 " + aboveCount + " more above"
      )
    );
  }

  // 4. Visible mod rows
  var lastCategory = null;
  for (var vi = 0; vi < visibleMods.length; vi++) {
    var mod = visibleMods[vi];
    var selected = scrollStart + vi === effectiveCursor;
    var enabled = mods[mod.id] === true;
    var category = categoryLabel(mod);
    if (category !== lastCategory) {
      lastCategory = category;
      elements.push(
        React.createElement(V, { key: "cat-" + mod.id, dimColor: true, bold: true }, "\\u2500 " + category + " \\u2500")
      );
    }
      elements.push(
        React.createElement(B, { key: mod.id },
          React.createElement(B, { width: 44 },
            React.createElement(V,
              { color: selected ? "white" : undefined },
              (selected ? "\\u25B6 " : "  ") + shortText(mod.name, 41)
            )
          ),
          React.createElement(B, null,
            React.createElement(V,
              { color: enabled ? "green" : "gray", bold: selected },
              enabled ? "enabled " : "disabled"
            ),
            mod.config && mod.config.length
              ? React.createElement(V, { color: "cyan" }, "  config")
              : null,
            mod.live
              ? null
              : React.createElement(V, { color: "yellow" }, "  restart")
          )
        )
      );
  }

  // 5. Scroll indicator: items below viewport
  if (belowCount > 0) {
    elements.push(
      React.createElement(V, { key: "scroll-below", dimColor: true },
        "\\u2193 " + belowCount + " more below"
      )
    );
  }

  // 6. Empty state when search yields no results
  if (totalMods === 0 && searchQuery.length > 0) {
    elements.push(
      React.createElement(V, { key: "empty-state", italic: true, dimColor: true },
        'No mods match "' + searchQuery + '"'
      )
    );
  }

  // 7. Context-sensitive help bar (replicating Config tab's three-state pattern)
  var helpText;
  if (searchMode) {
    helpText = "Type to filter \\u00b7 Enter select \\u00b7 Esc clear";
  } else {
    helpText = "Space toggle \\u00b7 Enter details \\u00b7 / search \\u00b7 enabled=active now, restart=restart needed";
  }
  elements.push(React.createElement(V, { key: "help-bar", dimColor: true }, helpText));

  return React.createElement.apply(
    React,
    [B, { flexDirection: "column", tabIndex: 0, autoFocus: true, onKeyDown: handleKeyDown }].concat(elements)
  );
}
`;
  // Replace hardcoded B/V component references with discoverable placeholders
  tabCode = tabCode.replace(/createElement\(\s*B,/g, "createElement(__INK_BOX__,");
  tabCode = tabCode.replace(/createElement\(\s*V,/g, "createElement(__INK_TEXT__,");
  tabCode = tabCode.replace(/\[\s*B,/g, "[__INK_BOX__,");
  tabCode = tabCode.replace(/\[\s*V,/g, "[__INK_TEXT__,");
  return tabCode;
}

/**
 * Get mod registry from patch YAML files.
 * Returns array of { id, name, description, live, order, category, config } objects.
 * Uses the shared parseYAML from lib/utils.cjs for consistency.
 */
function getModRegistry() {
  const patchesDir = path.join(__dirname, "..", "patches");
  const registry = [];

  if (!fs.existsSync(patchesDir)) return registry;

  // Reuse the shared manifest parser so mod metadata stays in sync.
  const { parseYAML } = require("../lib/utils.cjs");

  const files = fs.readdirSync(patchesDir).filter(f => f.endsWith(".yaml"));
  for (const file of files) {
    const content = fs.readFileSync(path.join(patchesDir, file), "utf8");
    const parsed = parseYAML(content);

    if (parsed.id && parsed.name) {
      const mod = parsed.mod || {};
      // config is an array of field objects from the YAML mod.config section
      const configFields = Array.isArray(mod.config) ? mod.config : [];
      registry.push({
        id: parsed.id,
        name: parsed.name,
        description: parsed.description || "",
        live: mod.live === true,
        order: (() => { const n = parsed.order != null ? Number(parsed.order) : 50; return Number.isInteger(n) ? n : 50; })(),
        category: mod.category || "",
        config: configFields,
        section: mod.section || "mods",
        backend_required: mod.backend_required === true,
      });
    }
  }

  // Section-based grouping: Core (substrate) is hidden; Unlock + Mods are shown.
  // `section: "core"` on mods_runtime/mods_ui/mods_env_panel hides them robust to renames.
  const sectionOrder = ["unlock", "mods"];
  const sectionRank = (section) => {
    const i = sectionOrder.indexOf(section || "mods");
    return i === -1 ? 99 : i;
  };
  const categoryOrder = [
    "model",
    "features",
    "reliability",
    "remote",
    "display",
    "system",
  ];
  const categoryRank = (category) => {
    const i = categoryOrder.indexOf(category || "");
    return i === -1 ? 99 : i;
  };

  return registry
    .filter(entry => entry.section !== "core")
    .sort((a, b) => sectionRank(a.section) - sectionRank(b.section) || categoryRank(a.category) - categoryRank(b.category) || a.order - b.order || a.id.localeCompare(b.id));
}

/**
 * Find Box and Text exports by the second argument's object shape, not the
 * export helper's generated name. Either result may be null when absent.
 */
function discoverInkComponentNames(ast) {
  let boxName = null;
  let textName = null;
  // Collected for secondary strategy — matched after traversal completes.
  const candidates = [];

  // Single traversal combining both discovery strategies:
  //   Primary: anyCall(X, { Box: () => Y, Text: () => Z }) patterns (structural match)
  //   Secondary: var B = someModule.Box; var V = someModule.Text;
  traverse(ast, {
    CallExpression(path) {
      if (boxName && textName) return;
      // Structural match: callee(anything, ObjectExpr) where ObjectExpr has
      // both "Box" and "Text" getter properties. The callee name is a minifier
      // artifact (__export, f_, etc.) — do NOT check it.
      if (path.node.arguments.length < 2) return;
      const exportsObj = path.node.arguments[1];
      if (!t.isObjectExpression(exportsObj)) return;
      // Quick pre-check: must contain at least Box or Text before doing full scan
      const hasBoxOrText = exportsObj.properties.some(p =>
        t.isObjectProperty(p) && t.isIdentifier(p.key) &&
        (p.key.name === "Box" || p.key.name === "Text"));
      if (!hasBoxOrText) return;

      for (const prop of exportsObj.properties) {
        if (!t.isObjectProperty(prop) || !t.isIdentifier(prop.key)) continue;
        let componentName = null;

        if (prop.key.name === "Box" || prop.key.name === "Text") {
          if (t.isArrowFunctionExpression(prop.value)) {
            if (t.isIdentifier(prop.value.body)) {
              componentName = prop.value.body.name;
            } else if (t.isBlockStatement(prop.value.body)) {
              const stmts = prop.value.body.body;
              if (stmts.length === 1 && t.isReturnStatement(stmts[0]) && t.isIdentifier(stmts[0].argument)) {
                componentName = stmts[0].argument.name;
              }
            }
          }
          else if (t.isIdentifier(prop.value)) {
            componentName = prop.value.name;
          }
        }

        if (prop.key.name === "Box" && componentName) boxName = componentName;
        if (prop.key.name === "Text" && componentName) textName = componentName;
      }
    },
    // Secondary strategy (member expression): var B = someModule.Box
    VariableDeclarator(varPath) {
      if (!t.isIdentifier(varPath.node.id)) return;
      if (!t.isMemberExpression(varPath.node.init)) return;
      if (varPath.node.init.computed) return;
      if (!t.isIdentifier(varPath.node.init.property)) return;
      if (!t.isIdentifier(varPath.node.init.object)) return;

      if (varPath.node.init.property.name === "Box" || varPath.node.init.property.name === "Text") {
        candidates.push({
          propName: varPath.node.init.property.name,
          moduleName: varPath.node.init.object.name,
          varName: varPath.node.id.name,
        });
      }
    },
  });

  // Resolve secondary candidates: Box and Text must come from the same module
  if (!boxName || !textName) {
    const boxCandidates = candidates.filter(c => c.propName === "Box" && !boxName);
    const textCandidates = candidates.filter(c => c.propName === "Text" && !textName);
    for (const bc of boxCandidates) {
      const match = textCandidates.find(tc => tc.moduleName === bc.moduleName);
      if (match) {
        boxName = bc.varName;
        textName = match.varName;
        break;
      }
    }
  }

  return { boxName, textName };
}

/**
 * Build an AST node for the Mods tab component function.
 * Substitutes bundle variable names for React, require, and ink component references.
 * Returns a FunctionDeclaration node.
 */
function buildModsTabAST(reactName, requireFnName, boxName, textName) {
  let code = buildModsTabExpression();
  // Replace placeholders with the bundle's actual variable names.
  // These resolve via closure at render time (after lazy module initialization).
  code = code.replace(/__REACT_REF__/g, reactName);
  code = code.replace(/__REQUIRE_FN__/g, requireFnName);
  code = code.replace(/__INK_BOX__/g, boxName);
  code = code.replace(/__INK_TEXT__/g, textName);
  const ast = parser.parse(code, {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript"],
  });
  return ast.program.body[0];
}

/**
 * Discover the React and tab bindings from the Stats tab, then insert Mods
 * before the plugin-tab spread.
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

  // ── Traversal 1: Discovery pass ──
  // Merge idempotency check, Stats tab search, and createRequire import
  // discovery into a single AST walk.
  traverse(ast, {
    CallExpression(callPath) {
      if (alreadyApplied) return;
      const callee = callPath.node.callee;
      if (!t.isMemberExpression(callee)) return;
      if (!t.isIdentifier(callee.property, { name: "createElement" })) return;

      const args = callPath.node.arguments;
      if (args.length < 2) return;
      const propsArg = args[1];
      if (!t.isObjectExpression(propsArg)) return;

      // Idempotency: check for existing "Mods" tab
      if (!alreadyApplied) {
        const hasModsTitle = propsArg.properties.some(p =>
          t.isObjectProperty(p) &&
          t.isIdentifier(p.key, { name: "title" }) &&
          t.isStringLiteral(p.value, { value: "Mods" })
        );
        if (hasModsTitle) { alreadyApplied = true; return; }
      }

      // Discovery: find "Stats" tab to extract reactVar and tabComp
      if (!statsTabPath) {
        const hasStatsTitle = propsArg.properties.some(p =>
          t.isObjectProperty(p) &&
          t.isIdentifier(p.key, { name: "title" }) &&
          t.isStringLiteral(p.value, { value: "Stats" })
        );
        if (hasStatsTitle) {
          statsTabPath = callPath;
          reactVar = callee.object;
          tabComp = args[0];
          parentFnPath = callPath.getFunctionParent();
        }
      }
    },
    // Strategy 1: ESM — createRequire import discovery
    ImportDeclaration(path) {
      if (createRequireAlias) return;
      if (path.node.source.value !== "node:module") return;
      for (const spec of path.node.specifiers) {
        if (t.isImportSpecifier(spec) &&
            t.isIdentifier(spec.imported, { name: "createRequire" })) {
          createRequireAlias = spec.local.name;
        }
      }
    },
  });
  if (alreadyApplied) return 0;
  if (!statsTabPath || !parentFnPath) return 0;

  // ── Traversal 2: Dependent discovery ──
  // Find tab array and require function name — both depend on traversal 1 results.
  traverse(ast, {
    // Find tab array (has SpreadElement) in same function scope as Stats tab
    ArrayExpression(arrayPath) {
      if (tabArrayPath) return;
      if (arrayPath.getFunctionParent() !== parentFnPath) return;

      const hasSpread = arrayPath.node.elements.some(e => t.isSpreadElement(e));
      if (!hasSpread) return;

      tabArrayPath = arrayPath;
    },
    // Strategy 1 (ESM): resolve createRequire(import.meta.url) call
    Program(programPath) {
      if (!createRequireAlias || requireFnName) return;
      const body = programPath.node.body;
      for (let i = 0; i < body.length; i++) {
        if (!t.isVariableDeclaration(body[i])) continue;
        for (const decl of body[i].declarations) {
          if (
            t.isCallExpression(decl.init) &&
            t.isIdentifier(decl.init.callee, { name: createRequireAlias }) &&
            decl.init.arguments.length === 1
          ) {
            const arg = decl.init.arguments[0];
            if (
              t.isMemberExpression(arg) &&
              t.isMetaProperty(arg.object) &&
              t.isIdentifier(arg.property, { name: "url" })
            ) {
              requireFnName = decl.id.name;
            }
          }
        }
      }
    },
  });

  if (!tabArrayPath) return 0;

  // Strategy 2: CJS wrapper — (function(exports, require, module, __filename, __dirname) { ... })
  // No traverse needed — direct Program.body inspection.
  if (!requireFnName) {
    const firstExpr = ast.program.body.find(n =>
      t.isExpressionStatement(n) && !t.isDirective(n)
    );
    if (firstExpr) {
      let fnExpr = firstExpr.expression;
      for (let i = 0; i < 4 && fnExpr && !t.isFunctionExpression(fnExpr); i++) {
        if (t.isCallExpression(fnExpr)) {
          if (t.isFunctionExpression(fnExpr.callee)) {
            fnExpr = fnExpr.callee;
          } else if (fnExpr.arguments.length > 0) {
            fnExpr = fnExpr.arguments[0];
          } else {
            break;
          }
        } else if (t.isUnaryExpression(fnExpr)) {
          fnExpr = fnExpr.argument;
        } else {
          break;
        }
      }
      if (t.isFunctionExpression(fnExpr)) {
        const hasRequireParam = fnExpr.params.some(param =>
          t.isIdentifier(param, { name: "require" })
        );
        if (hasRequireParam) {
          requireFnName = "require";
        }
      }
    }
  }

  if (!requireFnName) {
    console.error("Warning: could not find createRequire(import.meta.url) or CJS wrapper; Mods tab may not work.");
    return 0;
  }

  // Inject __ModsTab__ function before the config panel function.
  // The function uses closure to reference the bundle's React variable
  // and dynamically-discovered Box/Text component variable names.
  const { boxName: discoveredBox, textName: discoveredText } = discoverInkComponentNames(ast);
  const boxName = discoveredBox || "B";
  const textName = discoveredText || "V";
  if (!discoveredBox || !discoveredText) {
    console.error(`Warning: could not discover ink Box/Text variable names via structural export pattern; using fallback B/${discoveredText || 'V'}.`);
  }

  const modsTabFnDecl = buildModsTabAST(reactVar.name, requireFnName, boxName, textName);
  parentFnPath.insertBefore(modsTabFnDecl);

  // Build the Mods tab element:
  // React.createElement(tabComp, { key: "mods", title: "Mods" },
  //   React.createElement(__ModsTab__, null))
  const modsTabElement = t.callExpression(
    t.memberExpression(t.cloneNode(reactVar), t.identifier("createElement")),
    [
      t.cloneNode(tabComp),
      t.objectExpression([
        t.objectProperty(t.identifier("key"), t.stringLiteral("mods")),
        t.objectProperty(t.identifier("title"), t.stringLiteral("Mods")),
      ]),
      t.callExpression(
        t.memberExpression(t.cloneNode(reactVar), t.identifier("createElement")),
        [t.identifier("__ModsTab__"), t.nullLiteral()]
      ),
    ]
  );

  // Insert the Mods tab element before the spread element in the array
  const elements = tabArrayPath.node.elements;
  const spreadIdx = elements.findIndex(e => t.isSpreadElement(e));
  if (spreadIdx === -1) return 0;

  elements.splice(spreadIdx, 0, modsTabElement);

  return 2;
}

/** CLI wrapper */

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-inject-mods-ui.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const ast = parser.parse(code, {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript"],
  });

  const changedCount = transform(ast);

  if (changedCount === 0) {
    console.error("No matching config tab structure found; nothing changed.");
  } else {
    console.error(`Injected Mods tab into config UI (${changedCount} location(s)).`);
  }

  const output = generate(ast, { retainLines: false }, code).code;

  if (outputFile) {
    fs.writeFileSync(path.resolve(outputFile), output, "utf8");
  } else {
    process.stdout.write(output);
  }
}

module.exports = { transform, getModRegistry, buildModsTabExpression };

if (require.main === module) {
  main();
}

#!/usr/bin/env node
// Filter the option list, not just its highlighted text.
// Keep injected hooks unconditional so toggling the mod does not change hook order.

const fs = require("fs");
const path = require("path");

const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

const MOD_ID = "model_picker_search";
const SEARCH_MODE_NAME = "__mpSearchMode";
const SEARCH_QUERY_NAME = "__mpSearchQuery";
const SET_SEARCH_MODE_NAME = "__setMpSearchMode";
const SET_SEARCH_QUERY_NAME = "__setMpSearchQuery";
const FILTERED_NAME = "__mpFilteredOptions";
const WRAPPER_NAME = "__ModelSearchSelect__";


// Structural matchers


/** True if a MemberExpression reads `process.env.<name>` (stable env name). */
function isProcessEnvDot(node, envName) {
  if (!t.isMemberExpression(node) || node.computed) return false;
  if (!t.isIdentifier(node.property, { name: envName })) return false;
  const obj = node.object;
  if (!t.isMemberExpression(obj) || obj.computed) return false;
  if (!t.isIdentifier(obj.property, { name: "env" })) return false;
  return t.isIdentifier(obj.object) && obj.object.name === "process";
}

/**
 * Identify the model picker function: contains both a
 * `process.env.ANTHROPIC_CUSTOM_MODEL_OPTION` read and an
 * `additionalModelOptionsCache` identifier reference. Both are stable string
 * literals / property names, not minified names.
 */
function isModelPickerFunction(path) {
  let hasCustomModelOption = false;
  let hasAdditionalCache = false;
  path.traverse({
    MemberExpression(p) {
      if (!hasCustomModelOption && isProcessEnvDot(p.node, "ANTHROPIC_CUSTOM_MODEL_OPTION")) {
        hasCustomModelOption = true;
      }
    },
    Identifier(p) {
      if (p.node.name === "additionalModelOptionsCache") {
        hasAdditionalCache = true;
      }
    },
  });
  return hasCustomModelOption && hasAdditionalCache;
}

/** True if an ObjectExpression has a property `key: <name>` whose value is a string literal. */
function hasStringProp(objExpr, propName, value) {
  return objExpr.properties.some(p =>
    t.isObjectProperty(p) && !p.computed &&
    t.isIdentifier(p.key, { name: propName }) &&
    t.isStringLiteral(p.value, { value })
  );
}

/**
 * Discover everything the transform needs from the AST. Single pass.
 * Returns null if any anchor is missing (fail-closed — transform no-ops).
 */
function discover(ast) {
  const found = {
    pickerFnPath: null,        // FunctionDeclaration of the picker
    reactName: null,           // React default export identifier (e.g. kl)
    selectName: null,          // Select component identifier (e.g. Ar)
    boxName: null,             // Box component identifier (e.g. B)
    textName: null,            // Text component identifier (e.g. w)
    useStateModuleName: null,  // React-hooks module alias (e.g. U0e)
    useStateAnchorPath: null,  // the `let [g,_] = X.useState(false)` decl to insert after
    optionsIdName: null,       // the picker options array id (e.g. D) — the `options:` value
    optionsDeclPath: null,     // the `let D = O;` decl to insert the filter after
    arCallPath: null,          // the inner createElement(Select, {options, ...}) call
    wtMemoPath: null,          // the IfStatement memo block wrapping the Ar call
    beMemoPath: null,         // the IfStatement memo block assigning `Be`
    woCallPath: null,         // the Wo({...}, Be) call
    woName: null,             // Wo callee identifier
    keymapBindingsPath: null, // the `{ s: "modelPicker:thisSessionOnly" }` ObjectExpression
    q2rArrayPath: null,       // the Q2r actions array (contains "modelPicker:thisSessionOnly")
  };

  // Pass 1: find the picker function + Q2r + keymap by their stable string markers.
  traverse(ast, {
    FunctionDeclaration(path) {
      if (found.pickerFnPath) return;
      if (!isModelPickerFunction(path)) return;
      found.pickerFnPath = path;
    },
    ArrayExpression(path) {
      if (found.q2rArrayPath) return;
      // The Q2r actions registry array: a flat array of string literals that
      // includes "modelPicker:thisSessionOnly". Structural: many string
      // elements + the specific marker. Avoids hardcoding the array variable.
      // Parent is an AssignmentExpression (`Q2r = [...]`) or VariableDeclarator.
      const elems = path.node.elements;
      if (elems.length < 20) return;
      if (!elems.every(e => t.isStringLiteral(e))) return;
      if (!elems.some(e => e.value === "modelPicker:thisSessionOnly")) return;
      const parentType = path.parent.type;
      if (parentType !== "VariableDeclarator" && parentType !== "AssignmentExpression") return;
      found.q2rArrayPath = path;
    },
    ObjectExpression(path) {
      // The ModelPicker keymap bindings block:
      //   { left: "modelPicker:decreaseEffort", right: "modelPicker:increaseEffort", s: "modelPicker:thisSessionOnly" }
      // Identified structurally by the three stable action string values.
      if (found.keymapBindingsPath) return;
      const props = path.node.properties;
      if (props.length !== 3) return; // ModelPicker bindings has exactly 3
      const values = props
        .filter(p => t.isObjectProperty(p) && t.isStringLiteral(p.value))
        .map(p => p.value.value);
      if (values.length !== 3) return;
      if (
        values.includes("modelPicker:decreaseEffort") &&
        values.includes("modelPicker:increaseEffort") &&
        values.includes("modelPicker:thisSessionOnly")
      ) {
        found.keymapBindingsPath = path;
      }
    },
  });

  if (!found.pickerFnPath) return null;
  if (process.env.MP_DEBUG) console.error("[mp] pass1: picker=ok q2r=" + !!found.q2rArrayPath + " keymap=" + !!found.keymapBindingsPath);

  // Pass 2: inside the picker function, find the useState module, the Ar call,
  // the wt memo block, the Be memo block, the Wo call, the options id, and
  // the `let D = O;` decl. Single traverse with early-exits.
  const pickerFn = found.pickerFnPath;
  pickerFn.traverse({
    VariableDeclarator(path) {
      // useState module discovery: `let [a, b] = <X>.useState(<lit>)`.
      // Capture <X> and anchor on the boolean-false useState (stable shape:
      // the picker's `let [g, _] = U0e.useState(false);`).
      if (!found.useStateModuleName && t.isArrayPattern(path.node.id) && path.node.id.elements.length === 2) {
        const init = path.node.init;
        if (t.isCallExpression(init) && t.isMemberExpression(init.callee) && !init.callee.computed &&
          t.isIdentifier(init.callee.property, { name: "useState" }) && t.isIdentifier(init.callee.object)) {
          // Prefer the useState(false) call as the anchor (the g/_ state);
          // falls back to any useState if no boolean one is found.
          if (init.arguments.length === 1 && t.isBooleanLiteral(init.arguments[0], { value: false })) {
            found.useStateModuleName = init.callee.object.name;
            found.useStateAnchorPath = path;
          } else if (!found.useStateModuleName) {
            found.useStateModuleName = init.callee.object.name;
            if (!found.useStateAnchorPath) found.useStateAnchorPath = path;
          }
        }
      }
    },
    CallExpression(path) {
      if (!found.arCallPath && t.isMemberExpression(path.node.callee) && !path.node.callee.computed &&
        t.isIdentifier(path.node.callee.property, { name: "createElement" })) {
        const args = path.node.arguments;
        if (args.length >= 2 && t.isIdentifier(args[0]) && t.isObjectExpression(args[1])) {
          const propsArg = args[1];
          // The Select createElement has exactly: defaultValue, defaultFocusValue,
          // options, onChange, onFocus, onCancel, visibleOptionCount.
          if (
            hasStringProp(propsArg, "onChange", "qe" /* not stable; use presence-only */) ||
            true
          ) {
            // Presence-based: must have options + onChange + onCancel + visibleOptionCount
            const required = ["options", "onChange", "onCancel", "visibleOptionCount", "defaultValue", "defaultFocusValue", "onFocus"];
            const present = required.every(name => propsArg.properties.some(p =>
              t.isObjectProperty(p) && !p.computed && t.isIdentifier(p.key, { name })
            ));
            if (present) {
              found.arCallPath = path;
              found.selectName = args[0].name;
              found.reactName = path.node.callee.object.name;
              // Capture the options prop value (e.g. identifier `D`).
              const optionsProp = propsArg.properties.find(p =>
                t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "options" }));
              if (optionsProp && t.isIdentifier(optionsProp.value)) {
                found.optionsIdName = optionsProp.value.name;
              }
            }
          }
        }
      }

      // Wo call discovery: Wo({ ..., "modelPicker:thisSessionOnly": ... }, Be)
      // The callee is an identifier (Wo is imported into scope).
      if (!found.woCallPath && t.isIdentifier(path.node.callee)) {
        const args = path.node.arguments;
        if (args.length === 2 && t.isObjectExpression(args[0]) && args[0].properties.some(p =>
          t.isObjectProperty(p) && t.isStringLiteral(p.key, { value: "modelPicker:thisSessionOnly" }))) {
          found.woCallPath = path;
          found.woName = path.node.callee.name;
        }
      }
    },
  });

  if (!found.arCallPath || !found.woCallPath || !found.useStateModuleName) {
    if (process.env.MP_DEBUG) console.error("[mp] pass2: ar=" + !!found.arCallPath + " wo=" + !!found.woCallPath + " useState=" + !!found.useStateModuleName + " hooksMod=" + found.useStateModuleName);
    return null;
  }

  // Derive the `B` (Box) component name from the OUTER createElement that wraps
  // the Ar call: `kl.createElement(B, {flexDirection:"column"}, kl.createElement(Ar, {...}))`.
  // The Ar call's parent is the outer createElement's arguments[2].
  const arParent = found.arCallPath.parentPath;
  if (
    arParent && arParent.isCallExpression() &&
    t.isMemberExpression(arParent.node.callee) &&
    t.isIdentifier(arParent.node.callee.property, { name: "createElement" }) &&
    arParent.node.arguments.length >= 1 &&
    t.isIdentifier(arParent.node.arguments[0])
  ) {
    found.boxName = arParent.node.arguments[0].name;
  }

  // Find the wt memo IfStatement (the one containing the Ar call).
  let p = found.arCallPath.parentPath; // the outer createElement
  while (p && !p.isIfStatement()) p = p.parentPath;
  if (p && p.isIfStatement()) found.wtMemoPath = p;

  // Find the Be memo IfStatement: the one assigning `Be = { context: "ModelPicker" }`
  // with the react.memo_cache_sentinel check. Walk the Wo call's 2nd arg back.
  // The Wo call's 2nd arg is `Be` (an identifier referencing the memo block's var).
  const woArg1 = found.woCallPath.node.arguments[1];
  let beName = null;
  if (t.isIdentifier(woArg1)) beName = woArg1.name;
  if (beName) {
    // Scan the picker function body for `let <beName>; if (t[N] === Symbol.for(...)) { <beName> = {context:"ModelPicker"}; ...}`
    for (const stmt of pickerFn.node.body.body) {
      if (!t.isVariableDeclaration(stmt)) continue;
      const decl = stmt.declarations[0];
      if (!decl || !t.isIdentifier(decl.id, { name: beName })) continue;
      // The following statement should be the IfStatement memo block.
      // But the decl and the if are separate statements; find the if by scanning siblings.
      // Simpler: traverse for the IfStatement whose consequent assigns beName = {context:"ModelPicker"}.
      break;
    }
    pickerFn.traverse({
      IfStatement(path) {
        if (found.beMemoPath) return;
        const cons = path.node.consequent;
        if (!t.isBlockStatement(cons) || cons.body.length === 0) return;
        // Look for an ExpressionStatement `X = { context: "ModelPicker" }`.
        for (const s of cons.body) {
          if (t.isExpressionStatement(s) && t.isAssignmentExpression(s.expression) &&
            t.isIdentifier(s.expression.left, { name: beName }) &&
            t.isObjectExpression(s.expression.right) &&
            s.expression.right.properties.some(p =>
              t.isObjectProperty(p) && !p.computed &&
              t.isIdentifier(p.key, { name: "context" }) &&
              t.isStringLiteral(p.value, { value: "ModelPicker" }))) {
            found.beMemoPath = path;
            return;
          }
        }
      },
    });
  }

  if (!found.wtMemoPath || !found.beMemoPath) {
    if (process.env.MP_DEBUG) console.error("[mp] pass2b: wtMemo=" + !!found.wtMemoPath + " beMemo=" + !!found.beMemoPath + " box=" + found.boxName);
    return null;
  }

  // Find the `let <optionsId> = <id2>;` declaration to insert the filter after.
  // Anchor: a VariableDeclaration whose sole declarator id matches optionsIdName.
  if (found.optionsIdName) {
    for (const stmt of pickerFn.node.body.body) {
      if (t.isVariableDeclaration(stmt) && stmt.declarations.length === 1) {
        const decl = stmt.declarations[0];
        if (t.isIdentifier(decl.id, { name: found.optionsIdName })) {
          found.optionsDeclPath = { stmt };
          break;
        }
      }
    }
  }

  return found;
}


// Wrapper component (string template + placeholder substitution)


/**
 * Disable the underlying Select and picker key handlers while search has focus,
 * so typing cannot activate picker shortcuts. React and Ink bindings are substituted
 * before parsing; the discovered Select component is supplied as a prop.
 */
function buildWrapperComponentSource() {
  return `
function ${WRAPPER_NAME}(props) {
  var React = __REACT_REF__;
  var Bx = __INK_BOX__;
  var Tx = __INK_TEXT__;
  var SelectComp = props.selectComp;
  var searchMode = props.searchMode;
  var searchQuery = props.searchQuery;
  var setSearchMode = props.setSearchMode;
  var setSearchQuery = props.setSearchQuery;
  var options = (props.options && props.options.length) ? props.options : [];

  function handleSearchKey(evt) {
    var key = (evt && typeof evt.key === "string") ? evt.key : "";
    var name = (evt && typeof evt.name === "string") ? evt.name : "";
    var isPrintable = key.length === 1 && !(evt && (evt.ctrl || evt.meta));
    if (name === "escape") {
      if (searchQuery.length > 0) {
        setSearchQuery("");
      } else {
        setSearchMode(false);
      }
      if (evt && typeof evt.preventDefault === "function") evt.preventDefault();
      return;
    }
    if (name === "return" || name === "down" || name === "tab") {
      // Exit search but keep the filter; Select re-grabs focus (isDisabled flips false).
      setSearchMode(false);
      if (evt && typeof evt.preventDefault === "function") evt.preventDefault();
      return;
    }
    if (name === "backspace" || name === "delete") {
      setSearchQuery(function(q) { return q.slice(0, -1); });
      if (evt && typeof evt.preventDefault === "function") evt.preventDefault();
      return;
    }
    if (name === "up") {
      // Stay in search; swallow so Select never sees it.
      if (evt && typeof evt.preventDefault === "function") evt.preventDefault();
      return;
    }
    if (isPrintable && key !== " ") {
      setSearchQuery(function(q) { return q + key; });
      if (evt && typeof evt.preventDefault === "function") evt.preventDefault();
      return;
    }
    // Space or unhandled: swallow in search mode so Select never acts.
    if (name === "space" || key === " ") {
      setSearchQuery(function(q) { return q + " "; });
      if (evt && typeof evt.preventDefault === "function") evt.preventDefault();
      return;
    }
  }

  function filterOptions(list) {
    if (!searchQuery) return list;
    var q = searchQuery.toLowerCase();
    return list.filter(function(_o) {
      if (typeof _o.label === "string" && _o.label.toLowerCase().indexOf(q) >= 0) return true;
      if (typeof _o.description === "string" && _o.description.toLowerCase().indexOf(q) >= 0) return true;
      if (typeof _o.value === "string" && _o.value.toLowerCase().indexOf(q) >= 0) return true;
      return false;
    });
  }

  var filtered = searchMode ? filterOptions(options) : options;

  var children = [];
  if (searchMode) {
    var hint = filtered.length + "/" + options.length;
    children.push(
      React.createElement(Bx, {
        key: "mp-search-input",
        marginBottom: 1,
        tabIndex: 0,
        autoFocus: true,
        onKeyDown: handleSearchKey
      },
        React.createElement(Tx, { color: "gray" }, "\\u2315 "),
        searchQuery.length === 0
          ? React.createElement(Tx, { dimColor: true }, "Filter " + options.length + " models\\u2026  (" + hint + ")")
          : React.createElement(Tx, null, searchQuery, "\\u2588"),
        searchQuery.length > 0
          ? React.createElement(Tx, { dimColor: true }, "  " + hint + "  Esc clear")
          : null
      )
    );
  }

  children.push(
    React.createElement(SelectComp, {
      key: "mp-select",
      defaultValue: props.defaultValue,
      defaultFocusValue: props.defaultFocusValue,
      options: filtered,
      onChange: props.onChange,
      onFocus: props.onFocus,
      onCancel: props.onCancel,
      visibleOptionCount: props.visibleOptionCount,
      isDisabled: searchMode
    })
  );

  return React.createElement.apply(
    React,
    [Bx, { flexDirection: "column" }].concat(children)
  );
}
`;
}

function buildWrapperAST(reactName, boxName, textName) {
  let code = buildWrapperComponentSource();
  code = code.replace(/__REACT_REF__/g, reactName);
  code = code.replace(/__INK_BOX__/g, boxName);
  code = code.replace(/__INK_TEXT__/g, textName);
  const ast = parser.parse(code, {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript"],
  });
  return ast.program.body[0];
}


// Discovery of ink Box/Text component names (mirrors codemod-inject-mods-ui)


function discoverInkComponentNames(ast, knownBox, pickerFnPath, reactName) {
  // Prefer the Box name captured at the picker's outer createElement (already
  // a stable in-scope identifier). Text is discovered via the ink export map:
  // anyCallee(mod, { Box: () => B, Text: () => V, ... }) — structural.
  let boxName = knownBox || null;
  let textName = null;
  traverse(ast, {
    CallExpression(path) {
      if (textName) return;
      if (path.node.arguments.length < 2) return;
      const exportsObj = path.node.arguments[1];
      if (!t.isObjectExpression(exportsObj)) return;
      const hasBoxOrText = exportsObj.properties.some(p =>
        t.isObjectProperty(p) && t.isIdentifier(p.key) &&
        (p.key.name === "Box" || p.key.name === "Text"));
      if (!hasBoxOrText) return;
      for (const prop of exportsObj.properties) {
        if (!t.isObjectProperty(prop) || !t.isIdentifier(prop.key)) continue;
        if (prop.key.name !== "Text") continue;
        if (t.isArrowFunctionExpression(prop.value)) {
          if (t.isIdentifier(prop.value.body)) {
            textName = prop.value.body.name;
          } else if (t.isBlockStatement(prop.value.body)) {
            const stmts = prop.value.body.body;
            if (stmts.length === 1 && t.isReturnStatement(stmts[0]) && t.isIdentifier(stmts[0].argument)) {
              textName = stmts[0].argument.name;
            }
          }
        } else if (t.isIdentifier(prop.value)) {
          textName = prop.value.name;
        }
      }
    },
  });
  // Fallback: scan the picker function for reactName.createElement(<id>, {dimColor: ...}).
  // `dimColor` is a stable ink Text prop; the picker's subtitle/headers all use
  // Text with dimColor. The first such <id> (distinct from Box) is Text.
  if (!textName && pickerFnPath && reactName) {
    pickerFnPath.traverse({
      CallExpression(path) {
        if (textName) return;
        const callee = path.node.callee;
        if (!t.isMemberExpression(callee) || callee.computed) return;
        if (!t.isIdentifier(callee.property, { name: "createElement" })) return;
        if (!t.isIdentifier(callee.object, { name: reactName })) return;
        const args = path.node.arguments;
        if (args.length < 2 || !t.isIdentifier(args[0])) return;
        if (args[1] === boxName) return; // skip Box
        const propsObj = args[1];
        if (!t.isObjectExpression(propsObj)) return;
        const hasDimColor = propsObj.properties.some(p =>
          t.isObjectProperty(p) && !p.computed && t.isIdentifier(p.key, { name: "dimColor" }));
        if (hasDimColor && args[0].name !== boxName) {
          textName = args[0].name;
        }
      },
    });
  }
  return { boxName, textName };
}


// Transform


function transform(ast) {
  const found = discover(ast);
  if (!found) {
    throw new Error("No matching model picker structure found; nothing changed.");
  }

  let changes = 0;
  const reactName = found.reactName;
  const selectName = found.selectName;
  const hooksMod = found.useStateModuleName;
  const optionsIdName = found.optionsIdName;

  // ── T1: add searchMode / searchQuery useState after the anchor useState ──
  const anchorStmt = found.useStateAnchorPath.parentPath; // VariableDeclaration
  anchorStmt.insertAfter(
    t.variableDeclaration("let", [
      t.variableDeclarator(
        t.arrayPattern([t.identifier(SEARCH_MODE_NAME), t.identifier(SET_SEARCH_MODE_NAME)]),
        t.callExpression(
          t.memberExpression(t.identifier(hooksMod), t.identifier("useState")),
          [t.booleanLiteral(false)]
        )
      ),
    ])
  );
  anchorStmt.insertAfter(
    t.variableDeclaration("let", [
      t.variableDeclarator(
        t.arrayPattern([t.identifier(SEARCH_QUERY_NAME), t.identifier(SET_SEARCH_QUERY_NAME)]),
        t.callExpression(
          t.memberExpression(t.identifier(hooksMod), t.identifier("useState")),
          [t.stringLiteral("")]
        )
      ),
    ])
  );
  changes++;

  // ── T2: add filtered-options local before the wt memo block ──
  // `let <FILTERED> = <optionsId> ? <optionsId>.filter(function(_o){...}) : <optionsId>;`
  const filterFn = t.functionExpression(null, [t.identifier("_o")], t.blockStatement([
    t.returnStatement(t.logicalExpression("||",
      t.logicalExpression("||",
        t.logicalExpression("&&",
          t.binaryExpression("===", t.unaryExpression("typeof", t.memberExpression(t.identifier("_o"), t.identifier("label"))), t.stringLiteral("string")),
          t.binaryExpression(">=",
            t.callExpression(t.memberExpression(
              t.callExpression(t.memberExpression(t.memberExpression(t.identifier("_o"), t.identifier("label")), t.identifier("toLowerCase")), []),
              t.identifier("indexOf")
            ), [t.identifier("_q")]),
            t.numericLiteral(0)
          )
        ),
        t.logicalExpression("&&",
          t.binaryExpression("===", t.unaryExpression("typeof", t.memberExpression(t.identifier("_o"), t.identifier("description"))), t.stringLiteral("string")),
          t.binaryExpression(">=",
            t.callExpression(t.memberExpression(
              t.callExpression(t.memberExpression(t.memberExpression(t.identifier("_o"), t.identifier("description")), t.identifier("toLowerCase")), []),
              t.identifier("indexOf")
            ), [t.identifier("_q")]),
            t.numericLiteral(0)
          )
        )
      ),
      t.logicalExpression("&&",
        t.binaryExpression("===", t.unaryExpression("typeof", t.memberExpression(t.identifier("_o"), t.identifier("value"))), t.stringLiteral("string")),
        t.binaryExpression(">=",
          t.callExpression(t.memberExpression(
            t.callExpression(t.memberExpression(t.memberExpression(t.identifier("_o"), t.identifier("value")), t.identifier("toLowerCase")), []),
            t.identifier("indexOf")
          ), [t.identifier("_q")]),
          t.numericLiteral(0)
        )
      )
    )),
  ]));
  // Hoist the query var: wrap filter in an IIFE-scoped `var _q = searchQuery.toLowerCase();`
  const filterExpr = t.conditionalExpression(
    t.identifier(SEARCH_QUERY_NAME),
    t.callExpression(
      t.memberExpression(t.identifier(optionsIdName), t.identifier("filter")),
      [
        t.functionExpression(null, [t.identifier("_o")], t.blockStatement([
          t.variableDeclaration("var", [
            t.variableDeclarator(t.identifier("_q"),
              t.callExpression(
                t.memberExpression(t.identifier(SEARCH_QUERY_NAME), t.identifier("toLowerCase")),
                []
              )
            ),
          ]),
          t.returnStatement(
            t.logicalExpression("||",
              t.logicalExpression("||",
                t.logicalExpression("&&",
                  t.binaryExpression("===", t.unaryExpression("typeof", t.memberExpression(t.identifier("_o"), t.identifier("label"))), t.stringLiteral("string")),
                  t.binaryExpression(">=",
                    t.callExpression(t.memberExpression(
                      t.callExpression(t.memberExpression(t.memberExpression(t.identifier("_o"), t.identifier("label")), t.identifier("toLowerCase")), []),
                      t.identifier("indexOf")
                    ), [t.identifier("_q")]),
                    t.numericLiteral(0)
                  )
                ),
                t.logicalExpression("&&",
                  t.binaryExpression("===", t.unaryExpression("typeof", t.memberExpression(t.identifier("_o"), t.identifier("description"))), t.stringLiteral("string")),
                  t.binaryExpression(">=",
                    t.callExpression(t.memberExpression(
                      t.callExpression(t.memberExpression(t.memberExpression(t.identifier("_o"), t.identifier("description")), t.identifier("toLowerCase")), []),
                      t.identifier("indexOf")
                    ), [t.identifier("_q")]),
                    t.numericLiteral(0)
                  )
                )
              ),
              t.logicalExpression("&&",
                t.binaryExpression("===", t.unaryExpression("typeof", t.memberExpression(t.identifier("_o"), t.identifier("value"))), t.stringLiteral("string")),
                t.binaryExpression(">=",
                  t.callExpression(t.memberExpression(
                    t.callExpression(t.memberExpression(t.memberExpression(t.identifier("_o"), t.identifier("value")), t.identifier("toLowerCase")), []),
                    t.identifier("indexOf")
                  ), [t.identifier("_q")]),
                  t.numericLiteral(0)
                )
              )
            )
          ),
        ])),
      ]
    ),
    t.identifier(optionsIdName)
  );
  const filterStmt = t.variableDeclaration("let", [
    t.variableDeclarator(t.identifier(FILTERED_NAME), filterExpr),
  ]);
  // Insert the filter decl right before the wt memo IfStatement.
  found.wtMemoPath.insertBefore(filterStmt);
  // Silence unused-var: filterFn was a draft; the real filter is inlined above.
  void filterFn;
  changes++;

  // ── T3: edit the wt memo block ──
  //   (a) extend the test condition with t[101]/t[102] deps
  //   (b) replace the inner Select createElement call with __ModelSearchSelect__,
  //       options: <FILTERED>, + search props + selectComp: <selectName>
  //   (c) extend the assignment block with t[101]/t[102]
  const wtIf = found.wtMemoPath.node;
  // (a) extend test: `... || t[101] !== <SEARCH_MODE> || t[102] !== <SEARCH_QUERY>`
  let test = wtIf.test;
  test = t.logicalExpression("||", test,
    t.binaryExpression("!==",
      t.memberExpression(t.identifier("t"), t.numericLiteral(101), true),
      t.identifier(SEARCH_MODE_NAME)
    ));
  test = t.logicalExpression("||", test,
    t.binaryExpression("!==",
      t.memberExpression(t.identifier("t"), t.numericLiteral(102), true),
      t.identifier(SEARCH_QUERY_NAME)
    ));
  wtIf.test = test;

  // (b) rewrite the inner Select call's callee-arg-0 + props
  const arCall = found.arCallPath.node;
  arCall.arguments[0] = t.identifier(WRAPPER_NAME);
  const propsObj = arCall.arguments[1];
  // Replace `options: <optionsId>` → `options: <FILTERED>`
  for (const prop of propsObj.properties) {
    if (t.isObjectProperty(prop) && !prop.computed && t.isIdentifier(prop.key, { name: "options" })) {
      prop.value = t.identifier(FILTERED_NAME);
    }
  }
  // Add new props: searchMode, searchQuery, setSearchMode, setSearchQuery, selectComp
  const newProps = [
    t.objectProperty(t.identifier("searchMode"), t.identifier(SEARCH_MODE_NAME)),
    t.objectProperty(t.identifier("searchQuery"), t.identifier(SEARCH_QUERY_NAME)),
    t.objectProperty(t.identifier("setSearchMode"), t.identifier(SET_SEARCH_MODE_NAME)),
    t.objectProperty(t.identifier("setSearchQuery"), t.identifier(SET_SEARCH_QUERY_NAME)),
    t.objectProperty(t.identifier("selectComp"), t.identifier(selectName)),
  ];
  for (const np of newProps) propsObj.properties.push(np);

  // (c) extend assignment block: append `t[101] = <SEARCH_MODE>; t[102] = <SEARCH_QUERY>;`
  const consBlock = wtIf.consequent; // BlockStatement
  consBlock.body.push(
    t.expressionStatement(t.assignmentExpression("=",
      t.memberExpression(t.identifier("t"), t.numericLiteral(101), true),
      t.identifier(SEARCH_MODE_NAME)
    )),
    t.expressionStatement(t.assignmentExpression("=",
      t.memberExpression(t.identifier("t"), t.numericLiteral(102), true),
      t.identifier(SEARCH_QUERY_NAME)
    ))
  );
  changes++;

  // ── T4: replace the Be memo block + add modelPicker:search handler ──
  // Replace the whole `let Be; if (t[55] === Symbol...) {...} else {...}` with
  // `let Be = { context: "ModelPicker", isActive: !<SEARCH_MODE> };`
  const beIf = found.beMemoPath.node;
  // Mutate in place: turn the VariableDeclaration (parent) into `let Be = {...}`.
  // beMemoPath is the IfStatement; its parent is the statement list. Replace
  // the IfStatement with a VariableDeclaration.
  const beDecl = t.variableDeclaration("let", [
    t.variableDeclarator(
      t.identifier("Be"),
      t.objectExpression([
        t.objectProperty(t.identifier("context"), t.stringLiteral("ModelPicker")),
        t.objectProperty(t.identifier("isActive"),
          t.unaryExpression("!", t.identifier(SEARCH_MODE_NAME))),
      ])
    ),
  ]);
  found.beMemoPath.replaceWith(beDecl);

  // Add `"modelPicker:search"` handler to the Wo object literal (1st arg).
  const woObj = found.woCallPath.node.arguments[0];
  woObj.properties.push(
    t.objectProperty(
      t.stringLiteral("modelPicker:search"),
      t.arrowFunctionExpression([], t.blockStatement([
        t.expressionStatement(t.callExpression(t.identifier(SET_SEARCH_MODE_NAME), [t.booleanLiteral(true)])),
        t.expressionStatement(t.callExpression(t.identifier(SET_SEARCH_QUERY_NAME), [t.stringLiteral("")])),
      ]))
    )
  );
  changes++;

  // ── T5: keymap binding + Q2r action registry ──
  // Add `"/": "modelPicker:search"` to the ModelPicker bindings ObjectExpression.
  found.keymapBindingsPath.node.properties.push(
    t.objectProperty(t.stringLiteral("/"), t.stringLiteral("modelPicker:search"))
  );
  // Add `"modelPicker:search"` to the Q2r array (after "modelPicker:thisSessionOnly").
  const q2rElems = found.q2rArrayPath.node.elements;
  const idx = q2rElems.findIndex(e => t.isStringLiteral(e, { value: "modelPicker:thisSessionOnly" }));
  if (idx !== -1) {
    q2rElems.splice(idx + 1, 0, t.stringLiteral("modelPicker:search"));
  } else {
    q2rElems.push(t.stringLiteral("modelPicker:search"));
  }
  changes++;

  // ── T6: inject the wrapper component before the picker function ──
  const { boxName, textName } = discoverInkComponentNames(ast, found.boxName, found.pickerFnPath, reactName);
  if (!boxName || !textName) {
    throw new Error("Could not discover ink Box/Text component names; aborting.");
  }
  const wrapperDecl = buildWrapperAST(reactName, boxName, textName);
  found.pickerFnPath.insertBefore(wrapperDecl);
  changes++;

  return changes;
}


// CLI


function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-model-picker-search.cjs <input.js> [output.js]");
    process.exit(1);
  }
  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");
  const ast = parser.parse(code, {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript"],
  });
  let changedCount;
  try {
    changedCount = transform(ast);
  } catch (e) {
    console.error("Error: " + e.message);
    process.exit(1);
  }
  if (!changedCount) {
    console.error("No matching model picker structure found; nothing changed.");
  } else {
    console.error(`Applied model picker search (${changedCount} transform group(s)).`);
  }
  const output = generate(ast, { retainLines: false }, code).code;
  if (outputFile) {
    fs.writeFileSync(path.resolve(outputFile), output, "utf8");
  } else {
    process.stdout.write(output);
  }
}

module.exports = { transform, discover, buildWrapperComponentSource, MOD_ID };

if (require.main === module) {
  main();
}

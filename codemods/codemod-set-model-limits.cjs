#!/usr/bin/env node
// Retain the upstream limits when the mod is disabled; configured overrides and cached capabilities apply only when enabled.

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

const MOD_ID = "set_model_limits";

const HELPER_CODE = `
var __modelCaps_cache__ = null;
var __modelCaps_cache_time__ = 0;
function __modelCaps__(model) {
  var fs = __REQUIRE_FN__("fs");
  var path = __REQUIRE_FN__("path");
  var os = __REQUIRE_FN__("os");
  var now = Date.now();
  if (!__modelCaps_cache__ || (now - __modelCaps_cache_time__) >= 2000) {
    try {
      var p = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "cache", "model-capabilities.json");
      var raw = JSON.parse(fs.readFileSync(p, "utf8"));
      var list = (raw && raw.models) || [];
      var map = {};
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (!m || !m.id) continue;
        var ctx = m.max_input_tokens || m.context_window || (m.limit && m.limit.input);
        var out = m.max_tokens || m.max_output || (m.limit && m.limit.output);
        if (!ctx && !out) continue;
        map[m.id] = { context: ctx || null, output: out || null };
      }
      __modelCaps_cache__ = map;
    } catch (e) {
      __modelCaps_cache__ = {};
    }
    __modelCaps_cache_time__ = now;
  }
  if (!model) return null;
  var entry = __modelCaps_cache__[model];
  if (entry === undefined) {
    for (var k in __modelCaps_cache__) {
      if (model.indexOf(k) >= 0) { entry = __modelCaps_cache__[k]; break; }
    }
  }
  return entry || null;
}
`;

/**
 * Detect the CJS wrapper body + bare `require` parameter name. Mirrors
 * codemod-inject-mods-runtime.cjs: the native-binary-era bundle is wrapped in
 * (function(exports, require, module, __filename, __dirname){ ... }).
 */
function getInjectionTarget(ast) {
  const firstExpr = ast.program.body.find(
    (n) => t.isExpressionStatement(n) && !t.isDirective(n)
  );
  if (!firstExpr) return null;
  let fnExpr = firstExpr.expression;
  // Unwrap layers (IIFE callee, function-as-first-arg, unary !IIFE) until we reach
  // a FunctionExpression. Superset of mods_runtime's logic, so the real CJS
  // wrapper (whatever invocation shape) still resolves.
  for (let i = 0; i < 5 && fnExpr; i++) {
    if (t.isFunctionExpression(fnExpr)) break;
    if (t.isCallExpression(fnExpr)) {
      if (t.isFunctionExpression(fnExpr.callee)) {
        fnExpr = fnExpr.callee;
      } else if (fnExpr.arguments.length > 0 && t.isFunctionExpression(fnExpr.arguments[0])) {
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
  if (
    t.isFunctionExpression(fnExpr) &&
    fnExpr.params.some((p) => t.isIdentifier(p, { name: "require" }))
  ) {
    return { body: fnExpr.body.body, requireFnName: "require" };
  }
  return null;
}

/** mod guard: typeof __isModEnabled__==="function" && __isModEnabled__("set_model_limits") && typeof __modelCaps__==="function" */
function buildGuard() {
  return t.logicalExpression(
    "&&",
    t.logicalExpression(
      "&&",
      t.binaryExpression(
        "===",
        t.unaryExpression("typeof", t.identifier("__isModEnabled__")),
        t.stringLiteral("function")
      ),
      t.callExpression(t.identifier("__isModEnabled__"), [t.stringLiteral(MOD_ID)])
    ),
    t.binaryExpression(
      "===",
      t.unaryExpression("typeof", t.identifier("__modelCaps__")),
      t.stringLiteral("function")
    )
  );
}

/** True if `root`'s subtree contains a call to `fnName`(). */
function containsCall(root, fnName) {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== "object") continue;
    if (t.isCallExpression(n) && t.isIdentifier(n.callee, { name: fnName })) return true;
    for (const key of Object.keys(n)) {
      if (key === "loc" || key === "start" || key === "end" || key === "type") continue;
      const child = n[key];
      if (Array.isArray(child)) {
        for (const c of child) if (c && typeof c === "object") stack.push(c);
      } else if (child && typeof child === "object") {
        stack.push(child);
      }
    }
  }
  return false;
}

/** Read a `.max_tokens` property access (plain or optional) anywhere under `fn`. */
function readsMaxTokens(fnPath) {
  let found = false;
  fnPath.traverse({
    MemberExpression(p) {
      if (!p.node.computed && t.isIdentifier(p.node.property, { name: "max_tokens" })) found = true;
    },
    OptionalMemberExpression(p) {
      if (!p.node.computed && t.isIdentifier(p.node.property, { name: "max_tokens" })) found = true;
    },
  });
  return found;
}

function transform(ast) {
  let changed = 0;

  // Transform 1: inject __modelCaps__ helper (idempotent on its declaration)
  let helperPresent = false;
  traverse(ast, {
    FunctionDeclaration(fnPath) {
      if (t.isIdentifier(fnPath.node.id, { name: "__modelCaps__" })) helperPresent = true;
    },
  });
  if (!helperPresent) {
    const target = getInjectionTarget(ast);
    if (target) {
      const resolved = HELPER_CODE.replace(/__REQUIRE_FN__/g, target.requireFnName);
      const helperStmts = parser.parse(resolved, { sourceType: "script" }).program.body;
      // Insert after the last mods-runtime helper if present, else at wrapper top.
      let insertIndex = 0;
      for (let i = 0; i < target.body.length; i++) {
        const s = target.body[i];
        if (
          t.isFunctionDeclaration(s) &&
          t.isIdentifier(s.id) &&
          ["__getModConfig__", "__isModEnabled__", "__modsLoad__"].includes(s.id.name)
        ) {
          insertIndex = i + 1;
        }
      }
      for (let i = helperStmts.length - 1; i >= 0; i--) {
        target.body.splice(insertIndex, 0, helperStmts[i]);
      }
      changed++;
    } else {
      console.error("Warning: no CJS wrapper injection target; __modelCaps__ not injected.");
    }
  }

  // Transform 2: CXH (getModelMaxOutputTokens) output override
  // Unique shape: a function whose body returns {default:<id>, upperLimit:<id>}
  // and reads `.max_tokens`. Insert the override before that return.
  let cxhPatched = false;
  traverse(ast, {
    FunctionDeclaration(fnPath) {
      if (cxhPatched) return;
      const fn = fnPath.node;
      if (containsCall(fn, "__modelCaps__")) return;
      if (!readsMaxTokens(fnPath)) return;
      let retPath = null;
      let defaultId = null;
      let upperId = null;
      fnPath.traverse({
        ReturnStatement(rPath) {
          if (retPath) return;
          const arg = rPath.node.argument;
          if (!t.isObjectExpression(arg)) return;
          let dProp = null;
          let uProp = null;
          for (const prop of arg.properties) {
            if (!t.isObjectProperty(prop)) continue;
            if (t.isIdentifier(prop.key, { name: "default" })) dProp = prop;
            if (t.isIdentifier(prop.key, { name: "upperLimit" })) uProp = prop;
          }
          if (dProp && uProp) {
            retPath = rPath;
            defaultId = dProp.value;
            upperId = uProp.value;
          }
        },
      });
      if (
        retPath &&
        t.isIdentifier(defaultId) &&
        t.isIdentifier(upperId) &&
        fn.params.length >= 1
      ) {
        const modelId = t.cloneNode(fn.params[0], true);
        const override = t.ifStatement(
          buildGuard(),
          t.blockStatement([
            t.variableDeclaration("var", [
              t.variableDeclarator(
                t.identifier("__mcOut"),
                t.callExpression(t.identifier("__modelCaps__"), [modelId])
              ),
            ]),
            t.ifStatement(
              t.logicalExpression(
                "&&",
                t.identifier("__mcOut"),
                t.memberExpression(t.identifier("__mcOut"), t.identifier("output"))
              ),
              t.blockStatement([
                t.expressionStatement(
                  t.assignmentExpression(
                    "=",
                    t.cloneNode(upperId, true),
                    t.memberExpression(t.identifier("__mcOut"), t.identifier("output"))
                  )
                ),
                t.expressionStatement(
                  t.assignmentExpression(
                    "=",
                    t.cloneNode(defaultId, true),
                    t.callExpression(
                      t.memberExpression(t.identifier("Math"), t.identifier("min")),
                      [t.cloneNode(defaultId, true), t.cloneNode(upperId, true)]
                    )
                  )
                ),
              ])
            ),
          ])
        );
        t.addComment(override, "leading", " model_limits_out ");
        retPath.insertBefore(override);
        cxhPatched = true;
        changed++;
      }
    },
  });
  if (!cxhPatched) {
    console.error("Warning: getModelMaxOutputTokens (CXH) not found; output override not applied.");
  }

  // Transform 3: w37 (getContextWindowForModel) context override
  // Unique shape: the function with >=2 `return 1000000;` statements. Insert the
  // override at the top of its body so the file is authoritative.
  let w37Patched = false;
  traverse(ast, {
    FunctionDeclaration(fnPath) {
      if (w37Patched) return;
      const fn = fnPath.node;
      if (containsCall(fn, "__modelCaps__")) return;
      // getContextWindowForModel: the unique function with >=2 `return 1000000`
      // statements (they nest inside if-branches, so traverse the whole body).
      let countM = 0;
      fnPath.traverse({
        ReturnStatement(p) {
          if (t.isNumericLiteral(p.node.argument, { value: 1000000 })) countM++;
        },
      });
      if (countM >= 2 && fn.params.length >= 1) {
        const modelId = t.cloneNode(fn.params[0], true);
        const override = t.ifStatement(
          buildGuard(),
          t.blockStatement([
            t.variableDeclaration("var", [
              t.variableDeclarator(
                t.identifier("__mcCtx"),
                t.callExpression(t.identifier("__modelCaps__"), [modelId])
              ),
            ]),
            t.ifStatement(
              t.logicalExpression(
                "&&",
                t.identifier("__mcCtx"),
                t.memberExpression(t.identifier("__mcCtx"), t.identifier("context"))
              ),
              t.returnStatement(
                t.memberExpression(t.identifier("__mcCtx"), t.identifier("context"))
              )
            ),
          ])
        );
        t.addComment(override, "leading", " model_limits_ctx ");
        fn.body.body.unshift(override);
        w37Patched = true;
        changed++;
      }
    },
  });
  if (!w37Patched) {
    console.error("Warning: getContextWindowForModel (w37) not found; context override not applied.");
  }

  // Override the effective output-limit resolver, not only its defaults.
  // Otherwise the global environment cap and stock ceiling still restrict the result.
  // Anchor on the effective property of the max-output-token lookup.
  let effPatched = false;
  traverse(ast, {
    FunctionDeclaration(fnPath) {
      if (effPatched) return;
      const fn = fnPath.node;
      if (!fn.body || !Array.isArray(fn.body.body) || fn.params.length < 1) return;
      if (containsCall(fn, "__modelCaps__")) return;
      let hasEff = false;
      for (const stmt of fn.body.body) {
        if (!t.isReturnStatement(stmt)) continue;
        const arg = stmt.argument;
        if (
          t.isMemberExpression(arg, { computed: false }) &&
          t.isIdentifier(arg.property, { name: "effective" }) &&
          t.isCallExpression(arg.object) &&
          t.isStringLiteral(arg.object.arguments[0], {
            value: "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
          })
        ) {
          hasEff = true;
          break;
        }
      }
      if (!hasEff) return;
      const modelId = t.cloneNode(fn.params[0], true);
      const override = t.ifStatement(
        buildGuard(),
        t.blockStatement([
          t.variableDeclaration("var", [
            t.variableDeclarator(
              t.identifier("__mcEff"),
              t.callExpression(t.identifier("__modelCaps__"), [modelId])
            ),
          ]),
          t.ifStatement(
            t.logicalExpression(
              "&&",
              t.identifier("__mcEff"),
              t.memberExpression(t.identifier("__mcEff"), t.identifier("output"))
            ),
            t.returnStatement(
              t.memberExpression(t.identifier("__mcEff"), t.identifier("output"))
            )
          ),
        ])
      );
      t.addComment(override, "leading", " model_limits_out_eff ");
      fn.body.body.unshift(override);
      effPatched = true;
      changed++;
    },
  });
  if (!effPatched) {
    console.error("Warning: effective output site (S$H) not found; output may be capped by the global env var.");
  }

  return changed;
}

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-set-model-limits.cjs <input.js> [output.js]");
    process.exit(1);
  }
  const code = fs.readFileSync(path.resolve(inputFile), "utf8");
  const ast = parser.parse(code, {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript"],
  });
  const changed = transform(ast);
  console.error(`set_model_limits: ${changed} change(s).`);
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

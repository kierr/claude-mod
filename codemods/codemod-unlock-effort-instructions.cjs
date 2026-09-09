#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

const MOD_ID = "unlock_effort_instructions";


// Discovery: find minified names by structural signatures


/**
 * Single-pass discovery of all three minified function names.
 * Merges discoverUltrathinkDetector + discoverEffortGetter + discoverEffortSupport
 * into one AST traversal (was 3, now 1).
 *
 * Returns { ultrathinkFn, effortGetterFn, effortSupportFn } — any may be null.
 */
function discoverAll(ast) {
  const TARGET = "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT";
  let ultrathinkFn = null;
  let effortGetterFn = null;
  let effortGetterParams = null;
  let effortSupportFn = null;
  let settingsGetterFn = null;

  traverse(ast, {
    // Discover ultrathink detector: FunctionDeclaration whose body contains
    // ReturnStatement → ArrayExpression → ObjectExpression with { type: "ultrathink_effort" }
    FunctionDeclaration(funcPath) {
      if (!funcPath.node.id || !t.isIdentifier(funcPath.node.id)) return;
      const body = funcPath.node.body;
      if (!t.isBlockStatement(body)) return;

      // Check for ultrathink detector signature
      if (!ultrathinkFn) {
        for (const stmt of body.body) {
          if (!t.isReturnStatement(stmt) || !t.isArrayExpression(stmt.argument)) continue;
          for (const elem of stmt.argument.elements) {
            if (!t.isObjectExpression(elem)) continue;
            for (const prop of elem.properties) {
              if (
                t.isObjectProperty(prop) &&
                !prop.computed &&
                t.isIdentifier(prop.key, { name: "type" }) &&
                t.isStringLiteral(prop.value, { value: "ultrathink_effort" })
              ) {
                ultrathinkFn = funcPath.node.id.name;
                break;
              }
            }
            if (ultrathinkFn) break;
          }
          if (ultrathinkFn) break;
        }
      }

      // Check for effort getter signature: last stmt is return CallExpr(X.effortLevel)
      if (!effortGetterFn && body.body.length >= 1) {
        const stmt = body.body[body.body.length - 1];
        if (t.isReturnStatement(stmt) && t.isCallExpression(stmt.argument) &&
            stmt.argument.arguments.length === 1) {
          const arg = stmt.argument.arguments[0];
          if (
            t.isMemberExpression(arg) && !arg.computed &&
            t.isIdentifier(arg.property, { name: "effortLevel" })
          ) {
            effortGetterFn = funcPath.node.id.name;
            effortGetterParams = funcPath.node.params.length;
          }
        }
      }
    },
    // Discover effort support check: StringLiteral containing target env var
    StringLiteral(path) {
      if (effortSupportFn) return;
      if (path.node.value !== TARGET) return;
      const funcPath = path.getFunctionParent();
      if (
        funcPath &&
        t.isFunctionDeclaration(funcPath.node) &&
        funcPath.node.id &&
        t.isIdentifier(funcPath.node.id)
      ) {
        effortSupportFn = funcPath.node.id.name;
      }
    },
    // Also match dot-access: process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT
    Identifier(path) {
      if (effortSupportFn) return;
      if (path.node.name !== TARGET) return;
      const parent = path.parent;
      if (!t.isMemberExpression(parent) || parent.computed) return;
      if (parent.property !== path.node) return;
      const funcPath = path.getFunctionParent();
      if (
        funcPath &&
        t.isFunctionDeclaration(funcPath.node) &&
        funcPath.node.id &&
        t.isIdentifier(funcPath.node.id)
      ) {
        effortSupportFn = funcPath.node.id.name;
      }
    },
  });

  // For getters that accept state, discover the settings resolver from an
  // existing call that supplies cli, env, and settings fields.
  if (effortGetterFn && effortGetterParams > 0) {
    traverse(ast, {
      CallExpression(path) {
        if (settingsGetterFn) return;
        const callee = path.node.callee;
        if (!t.isIdentifier(callee, { name: effortGetterFn })) return;
        const arg0 = path.node.arguments[0];
        if (!t.isObjectExpression(arg0)) return;
        for (const prop of arg0.properties) {
          if (
            t.isObjectProperty(prop) && !prop.computed &&
            t.isIdentifier(prop.key, { name: "settings" }) &&
            t.isCallExpression(prop.value) && t.isIdentifier(prop.value.callee)
          ) {
            settingsGetterFn = prop.value.callee.name;
            break;
          }
        }
      },
    });
  }

  return { ultrathinkFn, effortGetterFn, effortGetterParams, effortSupportFn, settingsGetterFn };
}


// AST builders


/** typeof __isModEnabled__ === "function" && __isModEnabled__(modId) */
function buildModGuard(modId) {
  return t.logicalExpression(
    "&&",
    t.binaryExpression(
      "===",
      t.unaryExpression("typeof", t.identifier("__isModEnabled__")),
      t.stringLiteral("function")
    ),
    t.callExpression(t.identifier("__isModEnabled__"), [t.stringLiteral(modId)])
  );
}

/**
 * Call zero-argument getters directly. Other forms require a state object;
 * use an empty cli layer to let environment and settings determine effort.
 */
function buildEffortGetterCall(effortGetterFn, effortGetterParams, settingsGetterFn) {
  const callee = t.identifier(effortGetterFn);
  if (!effortGetterParams || effortGetterParams === 0) {
    return t.callExpression(callee, []);
  }
  return t.callExpression(callee, [
    t.objectExpression([
      t.objectProperty(t.identifier("cli"), t.objectExpression([])),
      t.objectProperty(
        t.identifier("env"),
        t.memberExpression(t.identifier("process"), t.identifier("env"))
      ),
      t.objectProperty(
        t.identifier("settings"),
        t.callExpression(t.identifier(settingsGetterFn), [])
      ),
    ]),
  ]);
}


// Main transform


function transform(ast) {
  // Pass 1: Discover minified names (single traversal)
  const { ultrathinkFn, effortGetterFn, effortGetterParams, effortSupportFn, settingsGetterFn } = discoverAll(ast);
  if (!ultrathinkFn) {
    throw new Error("Could not find ultrathink detector function (contains 'ultrathink_effort')");
  }
  if (!effortGetterFn) {
    throw new Error("Could not find effort level getter function (returns call on 'effortLevel')");
  }
  if (!effortSupportFn) {
    throw new Error("Could not find effort support check function ('CLAUDE_CODE_ALWAYS_ENABLE_EFFORT')");
  }
  if (effortGetterParams > 0 && !settingsGetterFn) {
    throw new Error(
      `Effort getter ${effortGetterFn} takes a state argument (${effortGetterParams} params) but ` +
      `no canonical call site ({..., settings: <getter>()}) was found to derive the settings getter. ` +
      `Refusing to emit a bare call that would crash at runtime.`
    );
  }

  console.error(`Discovered: ultrathink=${ultrathinkFn}, effortGetter=${effortGetterFn} (${effortGetterParams} params), effortSupport=${effortSupportFn}, settingsGetter=${settingsGetterFn || "n/a"}`);

  // Pass 2: Transform function body + call site (single traversal)
  let bodyChanged = 0;
  let callSiteChanged = 0;
  let mainLoopModelExpr = null;

  traverse(ast, {
    FunctionDeclaration(funcPath) {
      if (!t.isIdentifier(funcPath.node.id, { name: ultrathinkFn })) return;

      const body = funcPath.node.body;
      if (!t.isBlockStatement(body)) return;
      const stmts = body.body;

      // Validate expected 3-statement structure: [if-stmt, expr-stmt, return-stmt]
      if (stmts.length !== 3) {
        throw new Error(`Expected 3 statements in ${ultrathinkFn}, found ${stmts.length}`);
      }
      if (!t.isIfStatement(stmts[0])) {
        throw new Error(`First statement in ${ultrathinkFn} is not an if-statement`);
      }
      if (!t.isExpressionStatement(stmts[1])) {
        throw new Error(`Second statement in ${ultrathinkFn} is not an expression statement`);
      }
      if (!t.isReturnStatement(stmts[2])) {
        throw new Error(`Third statement in ${ultrathinkFn} is not a return statement`);
      }

      // 1. Add model + effort parameters (effort = per-turn resolved effortValue,
      //    passed from the call site via _.getAppState().effortValue; covers max
      //    and transient /effort + --effort, which the settings getter cannot see)
      funcPath.node.params.push(t.identifier("model"));
      funcPath.node.params.push(t.identifier("effort"));

      // 2. Build new body
      const origIf = stmts[0];
      const origTelemetry = stmts[1];
      const origReturn = stmts[2];
      const ultrathinkArray = origReturn.argument;

      // Restructure if-statement: keep condition, clear consequent, add else branch
      origIf.consequent = t.blockStatement([]);
      origIf.alternate = t.blockStatement([
        origTelemetry,
        t.expressionStatement(
          t.callExpression(
            t.memberExpression(t.identifier("_patchResults"), t.identifier("push")),
            [t.spreadElement(ultrathinkArray)]
          )
        ),
      ]);

      const newBody = [
        // let _patchResults = [];
        t.variableDeclaration("let", [
          t.variableDeclarator(t.identifier("_patchResults"), t.arrayExpression([])),
        ]),
        // restructured if-else
        origIf,
        // effort fallback:
        //   if (_patchResults.length === 0 && <mod guard> && model) { ... }
        t.ifStatement(
          t.logicalExpression(
            "&&",
            t.logicalExpression(
              "&&",
              t.binaryExpression(
                "===",
                t.memberExpression(t.identifier("_patchResults"), t.identifier("length")),
                t.numericLiteral(0)
              ),
              buildModGuard(MOD_ID)
            ),
            t.identifier("model")
          ),
          t.blockStatement([
            // let _patchEffort = effort !== undefined ? effort : <settings getter>;
            // Primary source is the passed per-turn effortValue (covers max + /effort
            // + --effort); the settings getter is a fallback for when effortValue is unset.
            t.variableDeclaration("let", [
              t.variableDeclarator(
                t.identifier("_patchEffort"),
                t.conditionalExpression(
                  t.binaryExpression("!==", t.identifier("effort"), t.identifier("undefined")),
                  t.identifier("effort"),
                  buildEffortGetterCall(effortGetterFn, effortGetterParams, settingsGetterFn)
                )
              ),
            ]),
            // if (_patchEffort && !effortSupportFn(model)) { push ... }
            t.ifStatement(
              t.logicalExpression(
                "&&",
                t.identifier("_patchEffort"),
                t.unaryExpression(
                  "!",
                  t.callExpression(t.identifier(effortSupportFn), [t.identifier("model")])
                )
              ),
              t.blockStatement([
                t.expressionStatement(
                  t.callExpression(
                    t.memberExpression(t.identifier("_patchResults"), t.identifier("push")),
                    [
                      t.objectExpression([
                        t.objectProperty(t.identifier("type"), t.stringLiteral("ultrathink_effort")),
                        t.objectProperty(t.identifier("level"), t.identifier("_patchEffort")),
                      ]),
                    ]
                  )
                ),
              ])
            ),
          ])
        ),
        // return _patchResults;
        t.returnStatement(t.identifier("_patchResults")),
      ];

      funcPath.node.body = t.blockStatement(newBody);
      bodyChanged += 1;
    },

    // Transform call site: f2Y(q) → f2Y(q, K.options.mainLoopModel, K.getAppState().effortValue)
    // Walk up from call site through enclosing functions until one contains mainLoopModel.
    CallExpression(callPath) {
      if (!t.isIdentifier(callPath.node.callee, { name: ultrathinkFn })) return;
      if (callPath.node.arguments.length !== 1) return;

      // First call site: discover mainLoopModel expression from ancestors
      if (!mainLoopModelExpr) {
        let current = callPath.parentPath;
        while (current) {
          if (t.isFunction(current.node)) {
            // Scoped traverse — walks only this ancestor function, not the full AST
            traverse(current.node, {
              MemberExpression(memPath) {
                if (mainLoopModelExpr) return;
                if (
                  !memPath.node.computed &&
                  t.isIdentifier(memPath.node.property, { name: "mainLoopModel" }) &&
                  t.isMemberExpression(memPath.node.object) &&
                  !memPath.node.object.computed &&
                  t.isIdentifier(memPath.node.object.property, { name: "options" }) &&
                  t.isIdentifier(memPath.node.object.object)
                ) {
                  mainLoopModelExpr = memPath.node;
                }
              },
            }, current.scope);
            if (mainLoopModelExpr) break;
          }
          current = current.parentPath;
        }
      }

      // Apply: add mainLoopModel argument, then effortValue argument.
      // effortValue = <base>.getAppState().effortValue where <base> is the same query
      // object the .options.mainLoopModel access is rooted on (mainLoopModelExpr.object.object).
      // That object carries getAppState() — confirmed by sibling accessors mY(H)/aI6(H)
      // which read H.getAppState().effortValue / .ultracode alongside H.options.mainLoopModel.
      if (!mainLoopModelExpr) return;
      callPath.node.arguments.push(t.cloneNode(mainLoopModelExpr, true));
      const baseObj = t.cloneNode(mainLoopModelExpr.object.object, true);
      callPath.node.arguments.push(
        t.memberExpression(
          t.callExpression(
            t.memberExpression(baseObj, t.identifier("getAppState")),
            []
          ),
          t.identifier("effortValue")
        )
      );
      callSiteChanged += 1;
    },
  });

  if (bodyChanged !== 1) {
    throw new Error(`Expected to patch exactly one ultrathink detector function, patched ${bodyChanged}.`);
  }
  if (!mainLoopModelExpr) {
    throw new Error("Could not find X.options.mainLoopModel reference in call site scope");
  }
  if (callSiteChanged !== 1) {
    throw new Error(`Expected exactly one call site for ${ultrathinkFn}, found ${callSiteChanged}.`);
  }

  console.error(`Discovered mainLoopModel context object: ${mainLoopModelExpr.object.object.name}`);

  return bodyChanged + callSiteChanged;
}





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

  let ast;
  try {
    ast = parser.parse(code, {
      sourceType: "unambiguous",
      plugins: ["jsx", "typescript"],
    });
  } catch (err) {
    console.error(`Error: Failed to parse input file: ${err.message}`);
    process.exit(1);
  }

  let totalChanges;
  try {
    totalChanges = transform(ast);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  console.error(`Patched ${totalChanges} location(s) (function body + call site).`);

  const output = generate(ast, { retainLines: false }, code).code;

  if (outputFile) {
    const outputPath = path.resolve(outputFile);
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(outputPath, output, "utf8");
  } else {
    process.stdout.write(output);
  }
}

module.exports = { transform };

if (require.main === module) {
  main();
}

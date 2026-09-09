#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

const MOD_ID = "display_model_name";
const EXPLICIT_MODEL_VAR = "__explicitModel__";
const SESSION_MODEL_VAR = "__sessionModel__";
const RESOLVED_MODEL_VAR = "__resolvedModel__";

/**
 * Find the model display hook function by looking for a FunctionDeclaration
 * whose body contains store accessor calls reading .mainLoopModel and
 * .mainLoopModelForSession via arrow functions.
 */
function findModelHook(ast) {
  let hookName = null;

  traverse(ast, {
    FunctionDeclaration(funcPath) {
      if (hookName) return;
      const body = funcPath.node.body;
      if (!t.isBlockStatement(body)) return;

      let hasMainLoopModel = false;
      let hasMainLoopModelForSession = false;

      for (const stmt of body.body) {
        if (!t.isVariableDeclaration(stmt)) continue;
        for (const decl of stmt.declarations) {
          const init = decl.init;
          if (!t.isCallExpression(init) || init.arguments.length !== 1) continue;
          const arg = init.arguments[0];
          if (!t.isArrowFunctionExpression(arg)) continue;

          const arrowBody = arg.body;
          if (isPropertyAccess(arrowBody, "mainLoopModel")) {
            hasMainLoopModel = true;
          }
          if (isPropertyAccess(arrowBody, "mainLoopModelForSession")) {
            hasMainLoopModelForSession = true;
          }
        }
      }

      if (hasMainLoopModel && hasMainLoopModelForSession) {
        hookName = funcPath.node.id.name;
        funcPath.stop();
      }
    },
  });

  return hookName;
}

function isPropertyAccess(node, propName) {
  return (
    t.isMemberExpression(node) &&
    !node.computed &&
    t.isIdentifier(node.property, { name: propName })
  );
}

/**
 * Step 1: Modify the data function to extract model from parsed Agent input.
 *
 * Matches a function containing:
 *   - safeParse on some input
 *   - .data.subagent_type access
 *   - returned object with agentType, description
 *
 * Adds `model: <parsed>.success ? <parsed>.data.model : undefined` to the
 * returned object.
 */
function modifyDataFunction(ast) {
  let changed = 0;

  traverse(ast, {
    // The safeParse and return with id/agentType live inside a map callback,
    // so we match on the ArrowFunctionExpression that contains them.
    ArrowFunctionExpression(arrowPath) {
      if (changed > 0) return;

      const body = arrowPath.node.body;
      if (!t.isBlockStatement(body)) return;

      let parsedVar = null;

      // Look for: let Z = pL8().safeParse(j.input) somewhere in the body
      for (const stmt of body.body) {
        if (!t.isVariableDeclaration(stmt)) continue;
        for (const decl of stmt.declarations) {
          const init = decl.init;
          if (!t.isCallExpression(init)) continue;

          // Match: X.safeParse(Y.input) or fn().safeParse(Y.input)
          const callee = init.callee;
          if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.property, { name: "safeParse" })) continue;
          if (init.arguments.length !== 1) continue;
          const arg = init.arguments[0];
          if (!t.isMemberExpression(arg) || !t.isIdentifier(arg.property, { name: "input" })) continue;

          // The parsed result is assigned to decl.id (e.g., let Z = ...)
          if (t.isIdentifier(decl.id)) {
            parsedVar = decl.id.name;
          }
          break;
        }
        if (parsedVar) break;
      }

      if (!parsedVar) return;

      // Verify the callback accesses subagent_type and returns agentType
      const codeStr = generate(arrowPath.node).code;
      if (!codeStr.includes("subagent_type") || !codeStr.includes("agentType")) return;
      if (!codeStr.includes("description") || !codeStr.includes("toolUseCount")) return;

      // Find the returned object with id, agentType properties
      let returnObjPath = null;
      arrowPath.traverse({
        ReturnStatement(retPath) {
          if (returnObjPath) return;
          const arg = retPath.node.argument;
          if (!t.isObjectExpression(arg)) return;

          const hasId = arg.properties.some(p =>
            t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "id" })
          );
          const hasAgentType = arg.properties.some(p =>
            t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "agentType" })
          );

          if (hasId && hasAgentType) {
            returnObjPath = retPath;
          }
        },
      });

      if (!returnObjPath) return;

      const objExpr = returnObjPath.node.argument;

      // Don't add twice (idempotency)
      const alreadyHasModel = objExpr.properties.some(p =>
        t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "model" })
      );
      if (alreadyHasModel) return;

      // Add model: <parsed>.success ? <parsed>.data.model : undefined
      const modelProp = t.objectProperty(
        t.identifier("model"),
        t.conditionalExpression(
          t.memberExpression(t.identifier(parsedVar), t.identifier("success")),
          t.optionalMemberExpression(
            t.memberExpression(t.identifier(parsedVar), t.identifier("data")),
            t.identifier("model"),
            false,
            true
          ),
          t.identifier("undefined")
        )
      );

      // Insert after the `id` property for readability
      let insertIdx = objExpr.properties.length;
      for (let i = 0; i < objExpr.properties.length; i++) {
        const p = objExpr.properties[i];
        if (t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "id" })) {
          insertIdx = i + 1;
          break;
        }
      }
      objExpr.properties.splice(insertIdx, 0, modelProp);
      changed++;
    },
  });

  return changed;
}

/**
 * Step 2: Modify the FC7 caller to pass model prop.
 *
 * Finds the createElement call that passes agentType and description to FC7
 * and adds model: <iterVar>.model.
 */
function modifyCaller(ast) {
  let changed = 0;

  traverse(ast, {
    CallExpression(callPath) {
      if (changed > 0) return;

      // Match: createElement(FC7, { agentType: X, description: Y, ... })
      const callee = callPath.node.callee;
      if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.property, { name: "createElement" })) return;
      if (callPath.node.arguments.length < 2) return;

      const propsArg = callPath.node.arguments[1];
      if (!t.isObjectExpression(propsArg)) return;

      const hasAgentType = propsArg.properties.some(p =>
        t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "agentType" })
      );
      const hasDescription = propsArg.properties.some(p =>
        t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "description" })
      );

      const hasToolUseCount = propsArg.properties.some(p =>
        t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "toolUseCount" })
      );

      if (!hasAgentType || !hasDescription || !hasToolUseCount) return;

      // Find the iteration variable from agentType: X.agentType
      let iterVar = null;
      for (const p of propsArg.properties) {
        if (!t.isObjectProperty(p) || !t.isIdentifier(p.key, { name: "agentType" })) continue;
        if (t.isMemberExpression(p.value) && t.isIdentifier(p.value.property, { name: "agentType" }) && t.isIdentifier(p.value.object)) {
          iterVar = p.value.object.name;
          break;
        }
      }

      if (!iterVar) return;

      // Don't add twice (idempotency)
      const alreadyHas = propsArg.properties.some(p =>
        t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "model" })
      );
      if (alreadyHas) return;

      // Add: model: <iterVar>.model
      const modelProp = t.objectProperty(
        t.identifier("model"),
        t.memberExpression(t.identifier(iterVar), t.identifier("model"))
      );

      // Insert after agentType
      let insertIdx = propsArg.properties.length;
      for (let i = 0; i < propsArg.properties.length; i++) {
        const p = propsArg.properties[i];
        if (t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "agentType" })) {
          insertIdx = i + 1;
          break;
        }
      }
      propsArg.properties.splice(insertIdx, 0, modelProp);
      changed++;
    },
  });

  return changed;
}

/**
 * Step 3: Modify FC7 component to display model.
 *
 * Finds the component that destructures `agentType` and `description` from
 * its first param, then:
 *   - Adds `model: __explicitModel__` to destructured props
 *   - Injects model hook call (unconditional)
 *   - Computes resolved model with mod guard
 *   - Adds model display in the final return
 */
function modifyFC7Component(ast, hookName) {
  let changed = 0;

  traverse(ast, {
    FunctionDeclaration(funcPath) {
      if (changed > 0) return;

      const body = funcPath.node.body;
      if (!t.isBlockStatement(body)) return;

      // Idempotency: skip if already patched (contains __explicitModel__)
      const codeStr = generate(funcPath.node).code;
      if (codeStr.includes(EXPLICIT_MODEL_VAR)) return;

      // Match: function that uses a React-Compiler cache-init pattern and
      // destructures agentType. The cache init is structurally
      //   let _ = <id>.<prop>(<numeric>)
      // where <id> is the cache module (UC7, FC7, cache, ...) and <prop> is
      // the cache-slot accessor. Webcrack has historically preserved the
      // React-Compiler convention `<obj>.c(<slot>)`, but relying on the
      // literal `c` is a name-bake that will silently fail to match if a
      // future webcrack or React-Compiler release renames it. We match on
      // structure alone (member-call with identifier object and a single
      // numeric-literal arg) — distinctive in combination with the
      // agentType destructure + createElement + dimColor + flexDirection/
      // connectors guards below.
      let hasCacheInit = false;
      let hasAgentType = false;
      let reactVar = null;
      let textCompVar = null;
      let boxCompVar = null;
      let connCompVar = null;
      let isLastVar = null;

      for (let i = 0; i < body.body.length; i++) {
        const stmt = body.body[i];

        // Match: let _ = UC7.c(32)  (cache init — any prop name)
        if (t.isVariableDeclaration(stmt) && stmt.declarations.length === 1) {
          const decl = stmt.declarations[0];
          if (t.isCallExpression(decl.init)) {
            const call = decl.init;
            if (t.isMemberExpression(call.callee) &&
                t.isIdentifier(call.callee.object) &&
                t.isIdentifier(call.callee.property) &&
                call.arguments.length === 1 &&
                t.isNumericLiteral(call.arguments[0])) {
              hasCacheInit = true;
            }
          }
        }

        // Match: let { agentType: q, description: K, ... } = H
        if (t.isVariableDeclaration(stmt) && stmt.declarations.length === 1) {
          const decl = stmt.declarations[0];
          if (t.isObjectPattern(decl.id)) {
            for (const prop of decl.id.properties) {
              if (t.isObjectProperty(prop) &&
                  t.isIdentifier(prop.key, { name: "agentType" }) &&
                  t.isIdentifier(prop.value)) {
                hasAgentType = true;
              }
              // Also capture: isLast: w
              if (t.isObjectProperty(prop) &&
                  t.isIdentifier(prop.key, { name: "isLast" }) &&
                  t.isIdentifier(prop.value)) {
                isLastVar = prop.value.name;
              }
            }
          }
        }
      }

      if (!hasCacheInit || !hasAgentType) return;

      // Extract component variable names from createElement calls
      funcPath.traverse({
        CallExpression(callPath) {
          const callee = callPath.node.callee;
          if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.property, { name: "createElement" })) return;
          if (!t.isIdentifier(callee.object)) return;

          if (!reactVar) reactVar = callee.object.name;

          // Find Text component: createElement(V, { dimColor: ... }, ...)
          for (let i = 0; i < callPath.node.arguments.length; i++) {
            const arg = callPath.node.arguments[i];
            if (!t.isIdentifier(arg)) continue;
            const nextArg = callPath.node.arguments[i + 1];
            if (!t.isObjectExpression(nextArg)) continue;

            const hasDimColor = nextArg.properties.some(p =>
              t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "dimColor" })
            );
            if (hasDimColor && !textCompVar) {
              textCompVar = arg.name;
            }
            const hasFlexDir = nextArg.properties.some(p =>
              t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "flexDirection" })
            );
            if (hasFlexDir && !boxCompVar) {
              boxCompVar = arg.name;
            }
            const hasConnectors = nextArg.properties.some(p =>
              t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "connectors" })
            );
            if (hasConnectors && !connCompVar) {
              connCompVar = arg.name;
            }
          }
        },
      });

      if (!reactVar || !textCompVar) return;
      if (!boxCompVar && !connCompVar) return;

      // Find the `w` variable (isLast alias) — it's used for connector type
      // Look for: let f = J === undefined ? false : J; let X = M === undefined ? false : M; let P = f && j;
      // Then `w` is the destructured isLast. We already captured isLastVar.

      // Verify isLastVar appears in a conditional: w ? "last" : "branch"
      let hasLastConditional = false;
      if (isLastVar) {
        funcPath.traverse({
          ConditionalExpression(condPath) {
            if (hasLastConditional) return;
            const node = condPath.node;
            if (t.isStringLiteral(node.consequent, { value: "last" }) &&
                t.isStringLiteral(node.alternate, { value: "branch" })) {
              if (t.isIdentifier(node.test) && node.test.name === isLastVar) {
                hasLastConditional = true;
              }
            }
          },
        });
      }

      // 1. Add `model: __explicitModel__` to the destructured props
      let destructureStmtIdx = -1;
      for (let i = 0; i < body.body.length; i++) {
        const stmt = body.body[i];
        if (t.isVariableDeclaration(stmt) && stmt.declarations.length === 1) {
          const decl = stmt.declarations[0];
          if (t.isObjectPattern(decl.id)) {
            const hasAgent = decl.id.properties.some(p =>
              t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "agentType" })
            );
            if (hasAgent) {
              destructureStmtIdx = i;
              // Add model to destructuring
              decl.id.properties.push(t.objectProperty(
                t.identifier("model"),
                t.identifier(EXPLICIT_MODEL_VAR)
              ));
              break;
            }
          }
        }
      }

      if (destructureStmtIdx === -1) return;

      // 2. Inject model hook call right after the destructuring
      const hookCall = t.variableDeclaration("let", [
        t.variableDeclarator(
          t.identifier(SESSION_MODEL_VAR),
          t.callExpression(t.identifier(hookName), [])
        ),
      ]);
      body.body.splice(destructureStmtIdx + 1, 0, hookCall);

      // 3. Find the final return statement and inject model display before it
      // The function ends with: return m; (where m is the cached final element)
      let returnIdx = -1;
      for (let i = body.body.length - 1; i >= 0; i--) {
        if (t.isReturnStatement(body.body[i])) {
          returnIdx = i;
          break;
        }
      }

      if (returnIdx === -1) return;

      const returnStmt = body.body[returnIdx];
      const returnVar = t.isIdentifier(returnStmt.argument) ? returnStmt.argument.name : null;
      if (!returnVar) return;

      // 4. Build model resolution code
      const modCheck = t.logicalExpression(
        "&&",
        t.binaryExpression(
          "===",
          t.unaryExpression("typeof", t.identifier("__isModEnabled__")),
          t.stringLiteral("function")
        ),
        t.callExpression(t.identifier("__isModEnabled__"), [t.stringLiteral(MOD_ID)])
      );

      // __resolvedModel__ = __isModEnabled__(...) ? (__explicitModel__ ?? __sessionModel__) : undefined
      // When mod is disabled, resolved model is undefined so the early return fires and no
      // model is displayed — matching stock behavior. Other mods use the same pattern.
      const resolvedModelDecl = t.variableDeclaration("let", [
        t.variableDeclarator(
          t.identifier(RESOLVED_MODEL_VAR),
          t.conditionalExpression(
            modCheck,
            t.logicalExpression(
              "??",
              t.identifier(EXPLICIT_MODEL_VAR),
              t.identifier(SESSION_MODEL_VAR)
            ),
            t.identifier("undefined")
          )
        ),
      ]);

      // 5. Build model display element
      // __modelEl__ = __resolvedModel__ && createElement(HnH, { connectors: [w ? "space" : "pipe"] },
      //   createElement(V, { dimColor: true }, "  ", __resolvedModel__))
      const connType = hasLastConditional && isLastVar
        ? t.conditionalExpression(
            t.identifier(isLastVar),
            t.stringLiteral("space"),
            t.stringLiteral("pipe")
          )
        : t.stringLiteral("pipe");

      const modelDisplayEl = t.logicalExpression(
        "&&",
        t.identifier(RESOLVED_MODEL_VAR),
        t.callExpression(
          t.memberExpression(t.identifier(reactVar), t.identifier("createElement")),
          [
            t.identifier(connCompVar || boxCompVar),
            connCompVar
              ? t.objectExpression([
                  t.objectProperty(t.identifier("connectors"), t.arrayExpression([connType]))
                ])
              : t.objectExpression([
                  t.objectProperty(t.identifier("flexDirection"), t.stringLiteral("column")),
                  t.objectProperty(t.identifier("paddingLeft"), t.numericLiteral(3))
                ]),
            t.callExpression(
              t.memberExpression(t.identifier(reactVar), t.identifier("createElement")),
              [
                t.identifier(textCompVar),
                t.objectExpression([
                  t.objectProperty(t.identifier("dimColor"), t.booleanLiteral(true))
                ]),
                t.stringLiteral("  "),
                t.identifier(RESOLVED_MODEL_VAR)
              ]
            )
          ]
        )
      );

      const modelElDecl = t.variableDeclaration("let", [
        t.variableDeclarator(t.identifier("__modelEl__"), modelDisplayEl)
      ]);

      // 6. Build the new return. We don't try to deconstruct the cached element —
      //    instead we wrap it: if (!model) return m; else return createElement(B, ..., m, modelEl)
      const wrapperExpr = t.callExpression(
        t.memberExpression(t.identifier(reactVar), t.identifier("createElement")),
        [
          t.identifier(boxCompVar || connCompVar),
          t.objectExpression([
            t.objectProperty(t.identifier("flexDirection"), t.stringLiteral("column"))
          ]),
          t.identifier(returnVar),
          t.identifier("__modelEl__"),
        ]
      );

      // if (!__resolvedModel__) return returnVar; return wrapper;
      const earlyReturn = t.ifStatement(
        t.unaryExpression("!", t.identifier(RESOLVED_MODEL_VAR)),
        t.blockStatement([t.returnStatement(t.identifier(returnVar))])
      );
      const newReturn = t.returnStatement(wrapperExpr);

      // Replace the existing return with the new code
      body.body.splice(returnIdx, 1,
        resolvedModelDecl,
        modelElDecl,
        earlyReturn,
        newReturn
      );

      changed++;
    },
  });

  return changed;
}

/**
 * Main transform: discover model hook, modify data function, caller, and FC7.
 */
function transform(ast) {
  const hookName = findModelHook(ast);
  if (!hookName) {
    throw new Error(
      "Could not find model display hook (function accessing both " +
        "mainLoopModel and mainLoopModelForSession)"
    );
  }

  const dataChanged = modifyDataFunction(ast);
  const callerChanged = modifyCaller(ast);
  const fc7Changed = modifyFC7Component(ast, hookName);

  return {
    changed: dataChanged + callerChanged + fc7Changed,
    hookName,
    dataChanged,
    callerChanged,
    fc7Changed,
  };
}

/** CLI wrapper */

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-subagent-show-model.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const ast = parser.parse(code, {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript"],
  });

  const { changed, hookName, dataChanged, callerChanged, fc7Changed } = transform(ast);

  if (changed === 0) {
    console.error("No matching patterns found; nothing changed.");
  } else {
    console.error(
      `Modified ${changed} locations (data:${dataChanged}, caller:${callerChanged}, FC7:${fc7Changed}), using model hook "${hookName}".`
    );
  }

  const output = generate(ast, { retainLines: false }, code).code;

  if (outputFile) {
    fs.writeFileSync(path.resolve(outputFile), output, "utf8");
  } else {
    process.stdout.write(output);
  }
}

module.exports = { transform, findModelHook };

if (require.main === module) {
  main();
}

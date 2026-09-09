#!/usr/bin/env node
// Call the model hook unconditionally to preserve React hook order; guard only the displayed suffix.

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

const MOD_ID = "display_model_name";
const MODEL_VAR = "__planModelDisplay__";
const TARGET_TITLES = ["Ready to code?", "Exit plan mode?"];

/**
 * Check if a node is X.propName (non-computed MemberExpression with matching property).
 */
function isPropertyAccess(node, propName) {
  return (
    t.isMemberExpression(node) &&
    !node.computed &&
    t.isIdentifier(node.property, { name: propName })
  );
}

/**
 * Find the model display hook function by looking for a FunctionDeclaration
 * whose body contains variable declarations initialized with store accessor
 * calls that read .mainLoopModel and .mainLoopModelForSession via arrow functions.
 *
 * Pattern (names are minifier artifacts — we match on structure):
 *   function OJ() {
 *     let q = J8(Y => Y.mainLoopModel);
 *     let K = J8(Y => Y.mainLoopModelForSession);
 *     ...
 *   }
 *
 * Returns the function name (e.g. "OJ") or null if not found.
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

          // Arrow body can be a direct expression (e.g. Y => Y.mainLoopModel)
          // or a block statement (e.g. Y => { return Y.mainLoopModel; })
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

/**
 * Main transform: discover model hook, find title props, inject hook call,
 * and replace string literals with mod-guarded concatenation.
 */
function transform(ast) {
  // Step 1: Discover the model display hook identifier
  const hookName = findModelHook(ast);
  if (!hookName) {
    throw new Error(
      "Could not find model display hook (function accessing both " +
        "mainLoopModel and mainLoopModelForSession)"
    );
  }

  // Step 2: Find and modify title props
  let changed = 0;

  traverse(ast, {
    ObjectProperty(propPath) {
      const key = propPath.node.key;
      const value = propPath.node.value;

      // Match: title: "Ready to code?" or title: "Exit plan mode?"
      const isTitleKey =
        t.isIdentifier(key, { name: "title" }) ||
        t.isStringLiteral(key, { value: "title" });
      if (!isTitleKey) return;
      if (!t.isStringLiteral(value)) return;
      if (!TARGET_TITLES.includes(value.value)) return;

      // Find the enclosing function (React component)
      const funcPath = propPath.getFunctionParent();
      if (!funcPath) return;

      const body = funcPath.node.body;
      if (!t.isBlockStatement(body)) return;

      // Idempotency: don't inject the hook call twice
      const alreadyInjected = body.body.some((stmt) => {
        if (!t.isVariableDeclaration(stmt)) return false;
        return stmt.declarations.some((d) =>
          t.isIdentifier(d.id, { name: MODEL_VAR })
        );
      });

      if (!alreadyInjected) {
        // Inject: let __planModelDisplay__ = hookName();
        const hookCall = t.variableDeclaration("let", [
          t.variableDeclarator(
            t.identifier(MODEL_VAR),
            t.callExpression(t.identifier(hookName), [])
          ),
        ]);
        body.body.unshift(hookCall);
      }

      // Build: typeof __isModEnabled__ === "function" && __isModEnabled__("plan_exit_show_model")
      const modCheck = t.logicalExpression(
        "&&",
        t.binaryExpression(
          "===",
          t.unaryExpression("typeof", t.identifier("__isModEnabled__")),
          t.stringLiteral("function")
        ),
        t.callExpression(t.identifier("__isModEnabled__"), [
          t.stringLiteral(MOD_ID),
        ])
      );

      // Build: " (" + __planModelDisplay__ + ")"
      const modelPart = t.binaryExpression(
        "+",
        t.stringLiteral(" ("),
        t.binaryExpression("+", t.identifier(MODEL_VAR), t.stringLiteral(")"))
      );

      // Build: (modCheck ? modelPart : "")
      const conditional = t.conditionalExpression(modCheck, modelPart, t.stringLiteral(""));

      // Replace title value with: originalTitle + conditional
      propPath.node.value = t.binaryExpression(
        "+",
        t.stringLiteral(value.value),
        conditional
      );

      changed++;
    },
  });

  return { changed, hookName };
}

/** CLI wrapper */

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error(
      "Usage: codemod-plan-exit-show-model.cjs <input.js> [output.js]"
    );
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const ast = parser.parse(code, {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript"],
  });

  const { changed, hookName } = transform(ast);

  if (changed === 0) {
    console.error("No matching plan exit title props found; nothing changed.");
  } else {
    console.error(
      `Replaced ${changed} plan exit title(s), using model hook "${hookName}".`
    );
  }

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

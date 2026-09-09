#!/usr/bin/env node
// Guard cache clearing rather than removing it: disabled behavior and the preceding state snapshot must remain intact.

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

const MOD_ID = "fix_file_cache";

/**
 * Check if a CallExpression is f(X.readFileState) — any function name — and
 * return the object identifier name (e.g. "K" or "_") or null.
 *
 * The callee name (sm1, ZB1, etc.) is a minifier artifact and changes every
 * release. We match on structure: single-arg call where the arg is
 * X.readFileState (a MemberExpression with property "readFileState").
 */
function extractReadFileStateSnapshot(node) {
  if (!t.isCallExpression(node)) return null;
  // Match any function call with a single argument that is X.readFileState
  // (callee name is a minifier artifact — not semantically meaningful)
  if (node.arguments.length !== 1) return null;

  const arg = node.arguments[0];
  if (
    !t.isMemberExpression(arg) ||
    arg.computed ||
    !t.isIdentifier(arg.property, { name: "readFileState" })
  ) {
    return null;
  }

  return t.isIdentifier(arg.object) ? arg.object.name : null;
}

/**
 * Check if a node is `X.readFileState.clear()` with matching object identifier.
 */
function isReadFileStateClear(node, objectName) {
  if (!t.isExpressionStatement(node)) return false;

  const expr = node.expression;
  if (!t.isCallExpression(expr)) return false;

  const callee = expr.callee;
  if (
    !t.isMemberExpression(callee) ||
    callee.computed ||
    !t.isIdentifier(callee.property, { name: "clear" })
  ) {
    return false;
  }

  const obj = callee.object;
  if (
    !t.isMemberExpression(obj) ||
    obj.computed ||
    !t.isIdentifier(obj.property, { name: "readFileState" })
  ) {
    return false;
  }

  return t.isIdentifier(obj.object, { name: objectName });
}

/**
 * Main transform: find VariableDeclarations initialized with f(X.readFileState)
 * (any callee name), then wrap the next sibling X.readFileState.clear() in a mod guard.
 */
function transform(ast) {
  let wrapped = 0;

  traverse(ast, {
    VariableDeclaration(varPath) {
      for (const decl of varPath.node.declarations) {
        const objectName = extractReadFileStateSnapshot(decl.init);
        if (objectName === null) continue;

        // Found: let v = f(X.readFileState);
        // Check next sibling statement
        const nextSibling = varPath.getNextSibling();
        if (!nextSibling.node) continue;

        if (isReadFileStateClear(nextSibling.node, objectName)) {
          // Replace the ExpressionStatement with:
          // if (!(typeof __isModEnabled__ === "function" && __isModEnabled__("fix_file_cache"))) { ... }
          // The typeof guard prevents ReferenceError if mods_runtime wasn't applied first.
          const isEnabled = t.logicalExpression(
            "&&",
            t.binaryExpression(
              "===",
              t.unaryExpression("typeof", t.identifier("__isModEnabled__")),
              t.stringLiteral("function")
            ),
            t.callExpression(
              t.identifier("__isModEnabled__"),
              [t.stringLiteral(MOD_ID)]
            )
          );
          const guard = t.ifStatement(
            t.unaryExpression("!", isEnabled),
            t.blockStatement([nextSibling.node])
          );
          nextSibling.replaceWith(guard);
          wrapped += 1;
        }
      }
    },
  });

  return wrapped;
}

/** CLI wrapper */

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-fix-file-cache.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const ast = parser.parse(code, {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript"],
  });

  const wrappedCount = transform(ast);

  if (wrappedCount === 0) {
    console.error("No matching readFileState.clear() compaction calls found; nothing changed.");
  } else {
    console.error(`Wrapped ${wrappedCount} readFileState.clear() call(s) with __isModEnabled__ guard.`);
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

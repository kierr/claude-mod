#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

const TITLE_REPLACEMENTS = {
  "Plan Mode": "Plan",
  "Accept edits": "Accept",
  "Bypass Permissions": "Bypass",
  "Don't Ask": "DontAsk",
  "Auto mode": "Auto",
};

const MOD_ID = "display_short_mode_labels";

/**
 * Check if a node is an ObjectProperty with key "title" (Identifier) and
 * a StringLiteral value matching one of the known mode title strings.
 */
function isModeTitleProp(node) {
  return (
    t.isObjectProperty(node) &&
    !node.computed &&
    t.isIdentifier(node.key, { name: "title" }) &&
    t.isStringLiteral(node.value) &&
    node.value.value in TITLE_REPLACEMENTS
  );
}

/**
 * Main transform.
 *
 * @param {object} ast - Babel AST
 * @returns {number} Number of changes applied
 */
function transform(ast) {
  let titleChanges = 0;
  let hintRemovals = 0;

  // Pass 1: Shorten mode title strings with __isModEnabled__ guard
  traverse(ast, {
    ObjectProperty(propPath) {
      if (isModeTitleProp(propPath.node)) {
        const oldVal = propPath.node.value.value;
        // Guarded: use short label when mod enabled, original when disabled
        propPath.node.value = t.conditionalExpression(
          t.logicalExpression(
            "&&",
            t.binaryExpression("===", t.unaryExpression("typeof", t.identifier("__isModEnabled__")), t.stringLiteral("function")),
            t.callExpression(t.identifier("__isModEnabled__"), [t.stringLiteral(MOD_ID)])
          ),
          t.stringLiteral(TITLE_REPLACEMENTS[oldVal]),
          t.stringLiteral(oldVal)
        );
        titleChanges += 1;
      }
    },
  });

  // Pass 2: Guard " on" string literal with mod check.
  // When mod enabled, replace " on" with empty string (hides hint suffix).
  // When mod disabled, keep " on" unchanged.
  traverse(ast, {
    StringLiteral(litPath) {
      if (litPath.node.value !== " on") return;

      const callPath = litPath.parentPath;
      if (!callPath.isCallExpression()) return;

      // Verify parent is a createElement call (ink createElement or similar).
      const callee = callPath.node.callee;
      const isCreateElement =
        (t.isIdentifier(callee) && callee.name === "createElement") ||
        (t.isMemberExpression(callee) && t.isIdentifier(callee.property, { name: "createElement" }));
      if (!isCreateElement) return;

      const args = callPath.node.arguments;
      const idx = args.indexOf(litPath.node);
      if (idx === -1) return;

      // Replace " on" with guarded version: mod enabled → "" (empty), disabled → " on"
      args[idx] = t.conditionalExpression(
        t.logicalExpression(
          "&&",
          t.binaryExpression("===", t.unaryExpression("typeof", t.identifier("__isModEnabled__")), t.stringLiteral("function")),
          t.callExpression(t.identifier("__isModEnabled__"), [t.stringLiteral(MOD_ID)])
        ),
        t.stringLiteral(""),
        t.stringLiteral(" on")
      );
      hintRemovals += 1;

      // Also guard the next argument (chord hint) — null it out when mod enabled
      if (idx + 1 < args.length) {
        const nextArg = args[idx + 1];
        args[idx + 1] = t.conditionalExpression(
          t.logicalExpression(
            "&&",
            t.binaryExpression("===", t.unaryExpression("typeof", t.identifier("__isModEnabled__")), t.stringLiteral("function")),
            t.callExpression(t.identifier("__isModEnabled__"), [t.stringLiteral(MOD_ID)])
          ),
          t.nullLiteral(),
          nextArg
        );
        hintRemovals += 1;
      }
    },
  });

  // Idempotent: if all titles are already shortened and all " on" removed,
  // this is a no-op, not an error. The engine's status_tests handle detection.
  return titleChanges + hintRemovals;
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-display-short-mode-labels.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const ast = parser.parse(code, {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript"],
  });

  const count = transform(ast);
  console.error(`Shortened ${count} mode label(s).`);

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

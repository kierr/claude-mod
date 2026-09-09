#!/usr/bin/env node
// Enable the existing capabilities fetcher without bypassing unrelated traffic controls.

const fs = require("fs");
const path = require("path");

const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

const MOD_ID = "model_capabilities_refresh";

/**
 * Is `test` a bare 0-arg call guard — `id()` or `!id()` (where id is a 0-arg identifier call)?
 * This is the shape of the populator's `!pei()` and `ta()` guards. Returns the underlying
 * CallExpression so callers can inspect it, or null.
 */
function callGuardTest(test) {
  if (
    t.isCallExpression(test) &&
    test.arguments.length === 0 &&
    t.isIdentifier(test.callee)
  ) {
    return test;
  }
  if (
    t.isUnaryExpression(test, { operator: "!" }) &&
    t.isCallExpression(test.argument) &&
    test.argument.arguments.length === 0 &&
    t.isIdentifier(test.argument.callee)
  ) {
    return test.argument;
  }
  return null;
}

/**
 * Is `consequent` a bare `return;` — either a bare ReturnStatement or a single-statement
 * BlockStatement wrapping one (with no argument)? Matches both guard styles.
 */
function isBareReturnConsequent(consequent) {
  if (t.isReturnStatement(consequent) && consequent.argument == null) return true;
  if (
    t.isBlockStatement(consequent) &&
    consequent.body.length === 1 &&
    t.isReturnStatement(consequent.body[0]) &&
    consequent.body[0].argument == null
  ) {
    return true;
  }
  return false;
}

function buildModGuard() {
  return t.logicalExpression(
    "&&",
    t.binaryExpression(
      "===",
      t.unaryExpression("typeof", t.identifier("__isModEnabled__")),
      t.stringLiteral("function")
    ),
    t.callExpression(t.identifier("__isModEnabled__"), [t.stringLiteral(MOD_ID)])
  );
}

function transform(ast) {
  let populatorPath = null;

  // Locate the populator: the async FunctionDeclaration whose body contains a
  // `.models.list(` call (callee = MemberExpression .list on MemberExpression .models).
  traverse(ast, {
    FunctionDeclaration(p) {
      if (populatorPath) return;
      if (!p.node.async) return;
      let found = false;
      p.traverse({
        CallExpression(cp) {
          if (found) return;
          const callee = cp.node.callee;
          if (
            t.isMemberExpression(callee) &&
            t.isIdentifier(callee.property, { name: "list" }) &&
            t.isMemberExpression(callee.object) &&
            t.isIdentifier(callee.object.property, { name: "models" })
          ) {
            found = true;
          }
        },
      });
      if (found) populatorPath = p;
    },
  });

  if (!populatorPath) return 0;

  // Rewrite each LEADING bare-return call guard. Stop at the first statement that is not
  // an if-guard (the populator's `try { ... }` body follows the two guards).
  let count = 0;
  for (const stmt of populatorPath.node.body.body) {
    if (!t.isIfStatement(stmt)) break;
    if (!callGuardTest(stmt.test)) break;
    if (!isBareReturnConsequent(stmt.consequent)) break;

    stmt.test = t.logicalExpression("&&", stmt.test, t.unaryExpression("!", buildModGuard()));
    count += 1;
  }

  return count;
}

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-model-capabilities-refresh.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const ast = parser.parse(code, {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript"],
  });

  const total = transform(ast);

  if (total === 0) {
    console.error("No matching patterns found; nothing changed.");
  } else {
    console.error(`Model capabilities refresh: ${total} guard(s) mod-guarded`);
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

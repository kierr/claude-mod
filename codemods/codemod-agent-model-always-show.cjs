#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

const MOD_ID = "display_model_name";

/**
 * Check if a node is: someId.model (non-computed MemberExpression)
 */
function isQModel(node, expectedObj) {
  return (
    t.isMemberExpression(node) &&
    !node.computed &&
    t.isIdentifier(node.object, { name: expectedObj }) &&
    t.isIdentifier(node.property, { name: "model" })
  );
}

/**
 * Check if a node is a call: anyFn(anyId.model) — captures callee name.
 * Returns the callee identifier name, or null if no match.
 */
function matchConverterCall(node, expectedObj) {
  if (!t.isCallExpression(node) || node.arguments.length !== 1) return null;
  if (!isQModel(node.arguments[0], expectedObj)) return null;
  if (!t.isIdentifier(node.callee)) return null;
  return node.callee.name;
}

/**
 * Check if a node is a call: anyFn() — captures callee name.
 * Returns the callee identifier name, or null if no match.
 */
function matchNoArgCall(node) {
  if (!t.isCallExpression(node) || node.arguments.length !== 0) return null;
  if (!t.isIdentifier(node.callee)) return null;
  return node.callee.name;
}

/**
 * Find the display-model-name function and wrap the model display logic for runtime toggle.
 *
 * Matcher: a FunctionDeclaration with exactly 1 identifier param whose body
 * contains an if-statement testing `<param>.model`, with inner variable
 * declarations for a session model getter (no-arg call) and a model converter
 * call (<converter>(<param>.model)), and a nested if checking the two are !==.
 *
 * Wraps both the outer `if (<param>.model)` and inner `if (<converted> !== <session>)` with
 * __isModEnabled__ guards so the mod can be toggled at runtime.
 */
function transform(ast) {
  let changed = 0;

  traverse(ast, {
    FunctionDeclaration(funcPath) {
      // Match any FunctionDeclaration with exactly 1 identifier param — capture names dynamically
      if (!t.isIdentifier(funcPath.node.id)) return;
      if (funcPath.node.params.length !== 1 || !t.isIdentifier(funcPath.node.params[0])) return;
      const param = funcPath.node.params[0].name;

      const body = funcPath.node.body;
      if (!t.isBlockStatement(body)) return;

      const stmts = body.body;
      // Look for pattern: let X = []; if (param.model) { ... }
      if (stmts.length < 2) return;

      // Find the array declaration: let X = []
      let arrName = null;
      for (let i = 0; i < stmts.length; i++) {
        const s = stmts[i];
        if (
          t.isVariableDeclaration(s) && s.declarations.length === 1 &&
          t.isIdentifier(s.declarations[0].id) &&
          t.isArrayExpression(s.declarations[0].init) &&
          s.declarations[0].init.elements.length === 0
        ) {
          arrName = s.declarations[0].id.name;
          break;
        }
      }
      if (!arrName) return;

      // Find the if-statement that tests param.model
      // Handles both `if (param.model)` and `if (param.model && ...)` patterns
      let ifPath = null;
      for (let i = 0; i < stmts.length; i++) {
        const s = stmts[i];
        if (!t.isIfStatement(s)) continue;
        // Direct: if (param.model)
        if (isQModel(s.test, param)) {
          ifPath = funcPath.get("body").get("body")[i];
          break;
        }
        // LogicalExpression: if (param.model && ...)
        if (t.isLogicalExpression(s.test) && s.test.operator === "&&") {
          if (isQModel(s.test.left, param)) {
            ifPath = funcPath.get("body").get("body")[i];
            break;
          }
        }
      }
      if (!ifPath) return;

      const ifBody = ifPath.node.consequent;
      if (!t.isBlockStatement(ifBody) || ifBody.body.length !== 3) return;

      // Verify: let <sessionModelVar> = <sessionModelGetter>()
      const decl1 = ifBody.body[0];
      if (!t.isVariableDeclaration(decl1) || decl1.declarations.length !== 1) return;
      if (!t.isIdentifier(decl1.declarations[0].id)) return;
      const sessionModelVar = decl1.declarations[0].id.name;
      const decl1Init = decl1.declarations[0].init;
      const sessionModelGetter = matchNoArgCall(decl1Init);
      if (!sessionModelGetter) return;

      // Verify: let <convertedVar> = <modelConverter>(param.model)
      const decl2 = ifBody.body[1];
      if (!t.isVariableDeclaration(decl2) || decl2.declarations.length !== 1) return;
      if (!t.isIdentifier(decl2.declarations[0].id)) return;
      const convertedVar = decl2.declarations[0].id.name;
      const modelConverter = matchConverterCall(decl2.declarations[0].init, param);
      if (!modelConverter) return;

      // Verify: nested if (<convertedVar> !== <sessionModelVar>) { <arrName>.push(...) }
      const nestedIf = ifBody.body[2];
      if (!t.isIfStatement(nestedIf)) return;
      const nestedTest = nestedIf.test;
      if (!t.isBinaryExpression(nestedTest) || nestedTest.operator !== "!==") return;
      if (!t.isIdentifier(nestedTest.left, { name: convertedVar })) return;
      if (!t.isIdentifier(nestedTest.right, { name: sessionModelVar })) return;

      // Verify <arrName>.push in the nested if body
      const nestedBody = t.isBlockStatement(nestedIf.consequent)
        ? nestedIf.consequent.body
        : [nestedIf.consequent];
      if (nestedBody.length !== 1) return;
      const kPushStmt = nestedBody[0];
      if (!t.isExpressionStatement(kPushStmt)) return;
      if (!t.isCallExpression(kPushStmt.expression)) return;
      const pushCall = kPushStmt.expression;
      if (!t.isMemberExpression(pushCall.callee)) return;
      if (!t.isIdentifier(pushCall.callee.object, { name: arrName })) return;
      if (!t.isIdentifier(pushCall.callee.property, { name: "push" })) return;

      // Verify trailing shape: if (<arrName>.length === 0) { return null; }
      const hasEmptyReturn = stmts.some(s => {
        if (
          !t.isIfStatement(s) ||
          !t.isBinaryExpression(s.test, { operator: "===" }) ||
          !t.isMemberExpression(s.test.left) ||
          !t.isIdentifier(s.test.left.object, { name: arrName }) ||
          !t.isIdentifier(s.test.left.property, { name: "length" }) ||
          !t.isNumericLiteral(s.test.right, { value: 0 })
        ) return false;
        // Verify consequent is `return null`
        const conseq = t.isBlockStatement(s.consequent) ? s.consequent.body : [s.consequent];
        return conseq.length === 1 &&
          t.isReturnStatement(conseq[0]) &&
          t.isNullLiteral(conseq[0].argument);
      });
      if (!hasEmptyReturn) return;

      // 1. Wrap outer condition: <param>.model → (<param>.model || (typeof __isModEnabled__ === "function" && __isModEnabled__("agent_model_always_show")))
      // typeof guard prevents ReferenceError if mods_runtime wasn't applied first
      const outerModCheck = t.logicalExpression(
        "&&",
        t.binaryExpression(
          "===",
          t.unaryExpression("typeof", t.identifier("__isModEnabled__")),
          t.stringLiteral("function")
        ),
        t.callExpression(t.identifier("__isModEnabled__"), [t.stringLiteral(MOD_ID)])
      );
      ifPath.node.test = t.logicalExpression(
        "||",
        ifPath.node.test,
        outerModCheck
      );

      // 2. Replace <modelConverter>(param.model) with (param.model ? <modelConverter>(param.model) : <sessionModelVar>) for fallback
      const decl2Path = ifPath.get("consequent").get("body")[1];
      decl2Path.node.declarations[0].init = t.conditionalExpression(
        t.memberExpression(t.identifier(param), t.identifier("model")),
        t.callExpression(t.identifier(modelConverter), [
          t.memberExpression(t.identifier(param), t.identifier("model")),
        ]),
        t.identifier(sessionModelVar)
      );

      // 3. Wrap inner condition: <converted> !== <session> → ((typeof __isModEnabled__ === "function" && __isModEnabled__(...)) || <converted> !== <session>)
      // typeof guard prevents ReferenceError if mods_runtime wasn't applied first
      const innerModCheck = t.logicalExpression(
        "&&",
        t.binaryExpression(
          "===",
          t.unaryExpression("typeof", t.identifier("__isModEnabled__")),
          t.stringLiteral("function")
        ),
        t.callExpression(t.identifier("__isModEnabled__"), [t.stringLiteral(MOD_ID)])
      );
      const nestedIfPath = ifPath.get("consequent").get("body")[2];
      nestedIfPath.node.test = t.logicalExpression(
        "||",
        innerModCheck,
        nestedIfPath.node.test
      );

      changed += 1;
    },
  });

  if (changed !== 1) {
    // Skip when no standalone display resolver exists; inline-rendering layouts
    // need a different match.
    return 0;
  }

  return changed;
}

/** CLI wrapper */

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-agent-model-always-show.cjs <input.js> [output.js]");
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

  // transform() throws if it doesn't match exactly one display-model-name function
  transform(ast);
  console.error("Wrapped 1 display-model-name function with __isModEnabled__ guard.");

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

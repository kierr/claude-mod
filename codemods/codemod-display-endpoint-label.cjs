#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

const TARGET_STRING = "API Usage Billing";
const MOD_ID = "display_endpoint_label";

/**
 * Check if a node is a zero-argument CallExpression (any callee).
 * Matches patterns like: someFunc()
 */
function isZeroArgCall(node) {
  return t.isCallExpression(node) && node.arguments.length === 0;
}

/**
 * Build a fresh AST node for process.env.ANTHROPIC_BASE_URL.
 * Called from both buildReplacement() (ternary test) and buildUrlExtractorIIFE()
 * (URL constructor arg). Each call returns an independent AST subtree; the
 * shared function keeps the structure consistent across call sites.
 */
function buildBaseUrlRef() {
  return t.memberExpression(
    t.memberExpression(
      t.identifier("process"),
      t.identifier("env")
    ),
    t.identifier("ANTHROPIC_BASE_URL")
  );
}

/**
 * Build the IIFE that safely extracts hostname from ANTHROPIC_BASE_URL:
 *   () => { try { return new URL(process.env.ANTHROPIC_BASE_URL).host } catch(e) { return "API" } }
 */
function buildUrlExtractorIIFE() {
  const baseUrl = buildBaseUrlRef();

  // new URL(process.env.ANTHROPIC_BASE_URL)
  const newUrl = t.newExpression(
    t.identifier("URL"),
    [baseUrl]
  );

  // new URL(process.env.ANTHROPIC_BASE_URL).host
  const hostAccess = t.memberExpression(
    newUrl,
    t.identifier("host")
  );

  // return new URL(...).host
  const tryReturn = t.returnStatement(hostAccess);

  // catch(e) { return "API" }
  const catchReturn = t.returnStatement(t.stringLiteral("API"));
  const catchClause = t.catchClause(
    t.identifier("e"),
    t.blockStatement([catchReturn])
  );

  // try { return new URL(...).host } catch(e) { return "API" }
  const tryBlock = t.blockStatement([tryReturn]);
  const tryStatement = t.tryStatement(tryBlock, catchClause);

  // () => { try { ... } catch(e) { ... } }
  const arrowFn = t.arrowFunctionExpression(
    [],
    t.blockStatement([tryStatement])
  );

  return arrowFn;
}

/**
 * Build the typeof guard for __isModEnabled__.
 * Pattern: typeof __isModEnabled__ === "function" && __isModEnabled__(MOD_ID)
 */
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

/**
 * Build the full replacement alternate expression:
 *   (typeof __isModEnabled__ === "function" && __isModEnabled__("display_endpoint_label") && process.env.ANTHROPIC_BASE_URL)
 *     ? (() => { try { ... } catch(e) { ... } })()
 *     : "API Usage Billing"
 *
 * The mod guard wraps the entire replacement so the feature is a no-op when
 * toggled off via mods.json or the Mods TUI tab.
 */
function buildReplacement() {
  const baseUrlAccess = buildBaseUrlRef();

  // IIFE call: (() => { ... })()
  const iifeCall = t.callExpression(
    buildUrlExtractorIIFE(),
    []
  );

  // Fallback: "API Usage Billing"
  const fallback = t.stringLiteral(TARGET_STRING);

  // Combined test: mod guard && env var present
  const modGuard = buildModGuard();
  const combinedTest = t.logicalExpression("&&", modGuard, baseUrlAccess);

  return t.conditionalExpression(
    combinedTest,
    iifeCall,
    fallback
  );
}

/**
 * Check if a node is process.env.ANTHROPIC_BASE_URL (the replacement pattern's test).
 * Used for idempotency detection — if this exists in a ConditionalExpression's test,
 * the file has already been transformed.
 */
function isBaseUrlEnvRef(node) {
  return (
    t.isMemberExpression(node) &&
    !node.computed &&
    t.isIdentifier(node.property, { name: "ANTHROPIC_BASE_URL" }) &&
    t.isMemberExpression(node.object) &&
    !node.object.computed &&
    t.isIdentifier(node.object.property, { name: "env" }) &&
    t.isIdentifier(node.object.object, { name: "process" })
  );
}

/**
 * Check if a ConditionalExpression is our already-applied replacement pattern.
 * Accepts both the plain form (test = baseUrl ref) and the mod-guarded form
 * (test = LogicalExpression containing modGuard && baseUrl ref).
 */
function isAlreadyTransformed(node) {
  if (!t.isConditionalExpression(node)) return false;
  if (!t.isStringLiteral(node.alternate, { value: TARGET_STRING })) return false;

  // Plain form: test is direct baseUrl env ref
  if (isBaseUrlEnvRef(node.test)) return true;

  // Mod-guarded form: test is LogicalExpression containing both baseUrl ref and mod ID call
  if (t.isLogicalExpression(node.test, { operator: "&&" })) {
    const hasBaseUrl = (n) => {
      if (isBaseUrlEnvRef(n)) return true;
      if (t.isLogicalExpression(n, { operator: "&&" })) return hasBaseUrl(n.left) || hasBaseUrl(n.right);
      return false;
    };
    const hasModIdCall = (n) => {
      if (
        t.isCallExpression(n) &&
        t.isIdentifier(n.callee, { name: "__isModEnabled__" }) &&
        n.arguments.length === 1 &&
        t.isStringLiteral(n.arguments[0], { value: MOD_ID })
      ) return true;
      if (t.isLogicalExpression(n, { operator: "&&" })) return hasModIdCall(n.left) || hasModIdCall(n.right);
      return false;
    };
    return hasBaseUrl(node.test) && hasModIdCall(node.test);
  }

  return false;
}

/**
 * Main transform: find ConditionalExpression matching the billing display pattern
 * and replace the alternate with the URL hostname extractor.
 *
 * Match criteria (all structural — no minified name dependencies):
 *   1. test is a zero-arg CallExpression (OAuth check)
 *   2. consequent is a zero-arg CallExpression (tier getter)
 *   3. alternate is StringLiteral("API Usage Billing")
 *
 * Idempotent: if already transformed, returns 0 without error.
 * Fail-closed: throws if neither original nor transformed pattern found.
 */
function transform(ast) {
  let matched = 0;
  let alreadyApplied = 0;

  traverse(ast, {
    ConditionalExpression(condPath) {
      const { test, consequent, alternate } = condPath.node;

      // Check for already-applied pattern first (idempotency)
      if (isAlreadyTransformed(condPath.node)) {
        alreadyApplied += 1;
        return;
      }

      // test: zero-arg call (e.g. isOAuth())
      if (!isZeroArgCall(test)) return;
      // consequent: zero-arg call (e.g. getTierLabel())
      if (!isZeroArgCall(consequent)) return;
      // alternate: StringLiteral("API Usage Billing")
      if (!t.isStringLiteral(alternate, { value: TARGET_STRING })) return;

      condPath.node.alternate = buildReplacement();
      matched += 1;
    },
  });

  // Idempotent: already transformed is a no-op, not an error
  if (alreadyApplied > 0 && matched === 0) {
    return 0;
  }

  if (matched !== 1) {
    throw new Error(
      `Expected exactly 1 ConditionalExpression match (test=zero-arg call, consequent=zero-arg call, alternate="${TARGET_STRING}"), found ${matched}.`
    );
  }

  return matched;
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-display-endpoint-label.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const ast = parser.parse(code, {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript"],
  });

  // transform() throws if it doesn't match exactly one ConditionalExpression
  const count = transform(ast);
  console.error(`Replaced ${count} billing display alternate(s) with URL hostname extractor.`);

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

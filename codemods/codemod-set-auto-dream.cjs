#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

const MOD_ID = "set_auto_dream";
const ENV_HOURS = "CLAUDE_AUTO_DREAM_MIN_HOURS";
const ENV_SESSIONS = "CLAUDE_AUTO_DREAM_MIN_SESSIONS";

/**
 * Check if a node is a call expression with "tengu_onyx_plover" as first argument.
 */
function isTenguOnyxPloverCall(node) {
  if (!t.isCallExpression(node)) return false;
  const args = node.arguments;
  if (args.length < 1) return false;
  return t.isStringLiteral(args[0], { value: "tengu_onyx_plover" });
}

/**
 * Check if a ReturnStatement returns an object with minHours and minSessions properties.
 */
function isAutoDreamConfigReturn(node) {
  if (!t.isReturnStatement(node)) return false;
  const arg = node.argument;
  if (!t.isObjectExpression(arg)) return false;

  let hasMinHours = false;
  let hasMinSessions = false;

  for (const prop of arg.properties) {
    if (!t.isObjectProperty(prop) || prop.computed) continue;
    if (t.isIdentifier(prop.key, { name: "minHours" })) hasMinHours = true;
    if (t.isIdentifier(prop.key, { name: "minSessions" })) hasMinSessions = true;
  }

  return hasMinHours && hasMinSessions;
}

/**
 * Build an IIFE that checks mods.json → env var → GrowthBook → defaults for a
 * given threshold property.
 */
function buildThresholdIIFE(envVarName, propName, configKey, gbVarName, defaultsName) {
  const cfgDecl = t.variableDeclarator(
    t.identifier("cfg"),
    t.conditionalExpression(
      t.binaryExpression("===", t.unaryExpression("typeof", t.identifier("__getModConfig__")), t.stringLiteral("function")),
      t.callExpression(t.identifier("__getModConfig__"), [t.stringLiteral(MOD_ID), t.stringLiteral(configKey), t.nullLiteral()]),
      t.nullLiteral()
    )
  );

  const cfgCheck = t.ifStatement(
    t.binaryExpression("!=", t.identifier("cfg"), t.nullLiteral()),
    t.blockStatement([
      t.variableDeclaration("let", [
        t.variableDeclarator(t.identifier("n"), t.callExpression(t.identifier("Number"), [t.identifier("cfg")])),
      ]),
      t.ifStatement(
        t.logicalExpression(
          "&&",
          t.callExpression(t.memberExpression(t.identifier("Number"), t.identifier("isFinite")), [t.identifier("n")]),
          t.binaryExpression(">", t.identifier("n"), t.numericLiteral(0))
        ),
        t.blockStatement([t.returnStatement(t.identifier("n"))])
      ),
    ])
  );

  const envCheck = t.ifStatement(
    t.binaryExpression("!=", t.identifier(envVarName), t.nullLiteral()),
    t.blockStatement([
      t.variableDeclaration("let", [
        t.variableDeclarator(t.identifier("n"), t.callExpression(t.identifier("Number"), [t.identifier(envVarName)])),
      ]),
      t.ifStatement(
        t.logicalExpression(
          "&&",
          t.callExpression(t.memberExpression(t.identifier("Number"), t.identifier("isFinite")), [t.identifier("n")]),
          t.binaryExpression(">", t.identifier("n"), t.numericLiteral(0))
        ),
        t.blockStatement([t.returnStatement(t.identifier("n"))])
      ),
    ])
  );

  const gbCheck = t.ifStatement(
    t.logicalExpression(
      "&&",
      t.binaryExpression(
        "===",
        t.unaryExpression("typeof", t.optionalMemberExpression(t.identifier(gbVarName), t.identifier(propName), false, true)),
        t.stringLiteral("number")
      ),
      t.logicalExpression(
        "&&",
        t.callExpression(t.memberExpression(t.identifier("Number"), t.identifier("isFinite")), [
          t.memberExpression(t.identifier(gbVarName), t.identifier(propName)),
        ]),
        t.binaryExpression(">", t.memberExpression(t.identifier(gbVarName), t.identifier(propName)), t.numericLiteral(0))
      )
    ),
    t.blockStatement([t.returnStatement(t.memberExpression(t.identifier(gbVarName), t.identifier(propName)))])
  );

  const defaultsReturn = t.returnStatement(
    t.memberExpression(t.identifier(defaultsName), t.identifier(propName))
  );

  return t.callExpression(
    t.arrowFunctionExpression(
      [],
      t.blockStatement([
        t.variableDeclaration("let", [cfgDecl]),
        cfgCheck,
        envCheck,
        gbCheck,
        defaultsReturn,
      ])
    ),
    []
  );
}

/**
 * Extract the GB result var name and defaults object name from the original return.
 */
function extractVarNames(originalReturn) {
  const obj = originalReturn.argument;
  if (!t.isObjectExpression(obj)) return null;

  for (const prop of obj.properties) {
    if (!t.isObjectProperty(prop) || !t.isConditionalExpression(prop.value)) continue;
    const cond = prop.value;
    if (
      t.isMemberExpression(cond.consequent) &&
      t.isMemberExpression(cond.alternate) &&
      t.isIdentifier(cond.consequent.object) &&
      t.isIdentifier(cond.alternate.object)
    ) {
      return { gbVar: cond.consequent.object.name, defaultsName: cond.alternate.object.name };
    }
  }
  return null;
}

/**
 * Build the mod-guarded threshold override return.
 */
function buildThresholdOverrideReturn(originalReturn, gbVarName, defaultsName) {
  const originalObj = originalReturn.argument;

  const envHDecl = t.variableDeclarator(
    t.identifier("envH"),
    t.memberExpression(t.memberExpression(t.identifier("process"), t.identifier("env")), t.stringLiteral(ENV_HOURS), true)
  );
  const envSDecl = t.variableDeclarator(
    t.identifier("envS"),
    t.memberExpression(t.memberExpression(t.identifier("process"), t.identifier("env")), t.stringLiteral(ENV_SESSIONS), true)
  );

  const newProps = originalObj.properties.map((prop) => {
    if (!t.isObjectProperty(prop)) return prop;
    const keyName = t.isIdentifier(prop.key) ? prop.key.name : null;
    if (keyName === "minHours") {
      return t.objectProperty(t.identifier("minHours"), buildThresholdIIFE("envH", "minHours", "min_hours", gbVarName, defaultsName));
    }
    if (keyName === "minSessions") {
      return t.objectProperty(t.identifier("minSessions"), buildThresholdIIFE("envS", "minSessions", "min_sessions", gbVarName, defaultsName));
    }
    return prop;
  });

  const modGuard = t.logicalExpression(
    "&&",
    t.binaryExpression("===", t.unaryExpression("typeof", t.identifier("__isModEnabled__")), t.stringLiteral("function")),
    t.callExpression(t.identifier("__isModEnabled__"), [t.stringLiteral(MOD_ID)])
  );

  return t.ifStatement(
    modGuard,
    t.blockStatement([
      t.variableDeclaration("let", [envHDecl]),
      t.variableDeclaration("let", [envSDecl]),
      t.returnStatement(t.objectExpression(newProps)),
    ])
  );
}

/**
 * Check if a function is the auto-dream enable gate by inspecting only its
 * top-level body statements. The gate function looks like:
 *   function y5_() {
 *     if (!wt_()) { return false; }     // negated call guard
 *     ... autoDreamEnabled ...           // member access
 *   }
 *
 * We scope to top-level to avoid false positives from nested functions that
 * might independently contain a negated call or .autoDreamEnabled access.
 * The actual callee name (wt_) changes per release, so we match structurally.
 */
function isAutoDreamEnabledGate(fnPath) {
  const body = fnPath.get("body");
  if (!t.isBlockStatement(body.node)) return false;

  let hasNegatedCall = false;
  let hasAutoDreamEnabled = false;

  // Walk only the direct child nodes of the function body — skip nested functions
  const visitor = {
    enter(path) {
      // Skip nested functions entirely — we only want top-level statements
      if (t.isFunctionDeclaration(path.node) || t.isFunctionExpression(path.node) || t.isArrowFunctionExpression(path.node)) {
        path.skip();
        return;
      }
    },
    IfStatement(ifPath) {
      const test = ifPath.node.test;
      // Match: if (!someFunc()) — the pattern for `if (!wt_()) { return false; }`
      if (t.isUnaryExpression(test, { operator: "!" }) && t.isCallExpression(test.argument)) {
        hasNegatedCall = true;
      }
    },
    MemberExpression(memPath) {
      if (t.isIdentifier(memPath.node.property, { name: "autoDreamEnabled" })) {
        hasAutoDreamEnabled = true;
      }
    },
  };

  // Traverse from the body node so we can skip nested functions
  body.traverse(visitor);

  return hasNegatedCall && hasAutoDreamEnabled;
}

/**
 * Main transform: applies both patches (gate bypass + threshold override).
 *
 * Only matches FunctionDeclaration nodes (not arrow functions or function
 * expressions). webcrack consistently produces function declarations for
 * named functions in the CLI bundle, so this is safe. If upstream changes
 * to const/arrow form, this will throw "No matching functions found" rather
 * than silently producing broken output.
 */
function transform(ast) {
  let patched = 0;

  traverse(ast, {
    FunctionDeclaration(fnPath) {
      const body = fnPath.node.body;
      if (!t.isBlockStatement(body)) return;

      // Idempotency: skip if already patched
      let alreadyPatched = false;
      fnPath.traverse({
        CallExpression(callPath) {
          if (
            t.isIdentifier(callPath.node.callee, { name: "__isModEnabled__" }) &&
            callPath.node.arguments.length >= 1 &&
            t.isStringLiteral(callPath.node.arguments[0], { value: MOD_ID })
          ) {
            alreadyPatched = true;
          }
        },
      });
      if (alreadyPatched) return;

      // Patch 1: y5_() gate bypass
      // Find function with `if (!someCall()) { return false; }` AND `.autoDreamEnabled` access
      if (isAutoDreamEnabledGate(fnPath)) {
        // Insert early return at the top of the function body:
        // if (typeof __isModEnabled__ === "function" && __isModEnabled__("set_auto_dream")) return true;
        const guard = t.ifStatement(
          t.logicalExpression(
            "&&",
            t.binaryExpression("===", t.unaryExpression("typeof", t.identifier("__isModEnabled__")), t.stringLiteral("function")),
            t.callExpression(t.identifier("__isModEnabled__"), [t.stringLiteral(MOD_ID)])
          ),
          t.blockStatement([t.returnStatement(t.booleanLiteral(true))])
        );

        body.body.unshift(guard);
        patched += 1;
        return; // Don't try threshold patch on the same function
      }

      // Patch 2: NT5() threshold override
      let hasTenguCall = false;
      fnPath.traverse({
        CallExpression(callPath) {
          if (isTenguOnyxPloverCall(callPath.node)) hasTenguCall = true;
        },
      });
      if (!hasTenguCall) return;

      let targetReturnPath = null;
      fnPath.traverse({
        ReturnStatement(retPath) {
          if (!targetReturnPath && isAutoDreamConfigReturn(retPath.node)) {
            targetReturnPath = retPath;
          }
        },
      });
      if (!targetReturnPath) return;

      const varNames = extractVarNames(targetReturnPath.node);
      if (!varNames) {
        throw new Error(
          "Could not extract GrowthBook/defaults variable names from NT5 return. " +
          "The code structure may have changed."
        );
      }

      const modIf = buildThresholdOverrideReturn(targetReturnPath.node, varNames.gbVar, varNames.defaultsName);
      targetReturnPath.insertBefore(modIf);
      patched += 1;
    },
  });

  return patched;
}

/** CLI wrapper */

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-set-auto-dream.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const ast = parser.parse(code, {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript"],
  });

  const patchedCount = transform(ast);

  if (patchedCount === 0) {
    throw new Error(
      "No matching auto-dream functions found (gate or threshold). The target code structure may have changed."
    );
  }
  if (patchedCount === 1) {
    // Partial patch: only one of the two targets (gate bypass or threshold override) matched.
    // Write output so downstream status_tests can detect the incomplete state, but warn loudly.
    console.error(
      "WARNING: Only 1 of 2 auto-dream patches applied (gate bypass + threshold override). " +
      "The status_tests.applied regex will detect this as incomplete."
    );
  } else {
    console.error(`Patched ${patchedCount} auto-dream function(s).`);
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

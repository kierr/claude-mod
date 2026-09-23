#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

const MOD_ID = "unlock_models";

/**
 * Check if an IfStatement is the firstParty gate:
 *   if (<anything> !== "firstParty") { return false; }
 * Matches on the string literal "firstParty" + a return false body.
 */
function isFirstPartyGate(node) {
  if (!t.isIfStatement(node)) return false;
  if (!t.isBinaryExpression(node.test, { operator: "!==" })) return false;
  if (!t.isStringLiteral(node.test.right, { value: "firstParty" })) return false;
  if (!t.isBlockStatement(node.consequent)) return false;
  if (node.consequent.body.length !== 1) return false;
  const stmt = node.consequent.body[0];
  return t.isReturnStatement(stmt) && t.isBooleanLiteral(stmt.argument, { value: false });
}

/**
 * Check if a CallExpression is the model filter:
 *   .filter(J => /^(claude|anthropic)/i.test(J.id))
 * Matches on the RegExpLiteral with pattern "^(claude|anthropic)".
 */
function isModelIdFilter(node) {
  if (!t.isCallExpression(node)) return false;
  if (!t.isMemberExpression(node.callee)) return false;
  if (!t.isIdentifier(node.callee.property, { name: "filter" })) return false;
  if (node.arguments.length !== 1) return false;
  const arg = node.arguments[0];
  if (!t.isArrowFunctionExpression(arg) && !t.isFunctionExpression(arg)) return false;

  // Walk the function body to find a RegExpLiteral with the claude|anthropic pattern
  let found = false;
  const walk = (n) => {
    if (!n || typeof n !== "object" || found) return;
    if (n.type === "RegExpLiteral" && n.pattern === "^(claude|anthropic)") {
      found = true;
      return;
    }
    for (const key of Object.keys(n)) {
      if (key === "loc" || key === "start" || key === "end" || key === "type") continue;
      const child = n[key];
      if (Array.isArray(child)) {
        for (const item of child) walk(item);
      } else if (child && typeof child === "object") {
        walk(child);
      }
    }
  };
  walk(arg.body);
  return found;
}

function transform(ast) {
  let t1 = 0; // firstParty gate guarded
  let t2 = 0; // env-var gate guarded
  let t3 = 0; // model filter guarded
  let t4 = 0; // nonessential-traffic gate guarded

  // Phase 1: Guard both gates from the ZHK() function.
  // We find the function by its unique content (CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY),
  // then guard the `return false` statements instead of removing them.
  let gateFnPath = null;
  traverse(ast, {
    FunctionDeclaration(path) {
      if (gateFnPath) return;
      let hasGatewayFlag = false;
      path.traverse({
        MemberExpression(p) {
          if (t.isIdentifier(p.node.property, { name: "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY" })) {
            hasGatewayFlag = true;
          }
        },
      });
      if (hasGatewayFlag) {
        gateFnPath = path;
      }
    },
  });

  if (gateFnPath) {
    // Guard `return false;` in the firstParty and env-var gates.
    // Instead of removing the if-statement, change the return value to:
    //   return typeof __isModEnabled__ === "function" ? __isModEnabled__("unlock_models") : false;
    // When mod is enabled: returns truthy (gate bypassed). When disabled: returns false (original).
    const body = gateFnPath.node.body.body;
    for (let i = body.length - 1; i >= 0; i--) {
      const stmt = body[i];
      if (!t.isIfStatement(stmt)) continue;
      if (!t.isBlockStatement(stmt.consequent) || stmt.consequent.body.length !== 1) continue;
      const ret = stmt.consequent.body[0];
      if (!t.isReturnStatement(ret) || !t.isBooleanLiteral(ret.argument, { value: false })) continue;

      // Build the guarded return: typeof __isModEnabled__ === "function" ? __isModEnabled__("unlock_models") : false
      const guardedReturn = t.conditionalExpression(
        t.binaryExpression(
          "===",
          t.unaryExpression("typeof", t.identifier("__isModEnabled__")),
          t.stringLiteral("function")
        ),
        t.callExpression(t.identifier("__isModEnabled__"), [t.stringLiteral("unlock_models")]),
        t.booleanLiteral(false)
      );

      // Check if this is the firstParty gate: test is `X !== "firstParty"`
      if (
        t.isBinaryExpression(stmt.test, { operator: "!==" }) &&
        t.isStringLiteral(stmt.test.right, { value: "firstParty" })
      ) {
        ret.argument = guardedReturn;
        t1 += 1;
        continue;
      }

      // Check if this is the env-var gate: test is `!X(process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY)`
      if (t.isUnaryExpression(stmt.test, { operator: "!" })) {
        const callArg = stmt.test.argument;
        if (t.isCallExpression(callArg) && callArg.arguments.length === 1) {
          const arg = callArg.arguments[0];
          if (
            t.isMemberExpression(arg) &&
            t.isIdentifier(arg.property, { name: "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY" })
          ) {
            ret.argument = guardedReturn;
            t2 += 1;
            continue;
          }
        }
      }
    }
  }

  // Phase 2: Guard the claude|anthropic model ID filter
  // Instead of removing the filter, wrap in a mod check.
  // When enabled: pass all models through (void + receiver).
  // When disabled: original filter runs.
  traverse(ast, {
    CallExpression(path) {
      if (t3 > 0) return;
      if (!isModelIdFilter(path.node)) return;

      const receiver = path.node.callee.object;
      path.replaceWith(
        t.conditionalExpression(
          t.callExpression(t.identifier("__isModEnabled__"), [t.stringLiteral("unlock_models")]),
          t.sequenceExpression([
            t.unaryExpression("void", t.stringLiteral("__GMU__")),
            receiver,
          ]),
          // When mod is disabled, the original filter call is preserved
          path.node
        )
      );
      t3 += 1;
    },
  });

  // Phase 3: Guard the nonessential-traffic gate in the gateway-discovery fetcher.
  //
  // The async fetcher (separate from the gate fn above) reads process.env.ANTHROPIC_BASE_URL
  // and ANTHROPIC_AUTH_TOKEN and fetches /v1/models. Upstream guards it:  if (ta()) { return; }
  // where ta() === (privacyLevel === "essential-traffic") — true under CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
  // which silently kills the picker-fueling fetch even though the flag is kept on to suppress
  // background pings. We rewrite the test so the guard is skipped when unlock_models is enabled.
  // Anchor on the async function reading BOTH env vars (the only such function), then match the
  // `if (<id>()) { return; }` guard (bare 0-arg call + bare return) — never hardcode `ta`.
  let fetchFnPath = null;
  traverse(ast, {
    FunctionDeclaration(path) {
      if (fetchFnPath) return;
      if (!path.node.async) return;
      let hasBaseUrl = false;
      let hasAuthToken = false;
      path.traverse({
        MemberExpression(p) {
          if (t.isIdentifier(p.node.property, { name: "ANTHROPIC_BASE_URL" })) hasBaseUrl = true;
          if (t.isIdentifier(p.node.property, { name: "ANTHROPIC_AUTH_TOKEN" })) hasAuthToken = true;
        },
      });
      if (hasBaseUrl && hasAuthToken) {
        fetchFnPath = path;
      }
    },
  });

  if (fetchFnPath) {
    const body = fetchFnPath.node.body.body;
    for (const stmt of body) {
      if (t4 > 0) break;
      if (!t.isIfStatement(stmt)) continue;
      const test = stmt.test;
      // test must be a bare 0-arg call: ta()
      if (!t.isCallExpression(test) || test.arguments.length !== 0) continue;
      if (!t.isIdentifier(test.callee)) continue;
      // consequent must be a single bare return (no argument)
      if (!t.isBlockStatement(stmt.consequent) || stmt.consequent.body.length !== 1) continue;
      const ret = stmt.consequent.body[0];
      if (!t.isReturnStatement(ret) || ret.argument != null) continue;

      const modGuard = t.logicalExpression(
        "&&",
        t.binaryExpression(
          "===",
          t.unaryExpression("typeof", t.identifier("__isModEnabled__")),
          t.stringLiteral("function")
        ),
        t.callExpression(t.identifier("__isModEnabled__"), [t.stringLiteral("unlock_models")])
      );
      stmt.test = t.logicalExpression("&&", test, t.unaryExpression("!", modGuard));
      t4 += 1;
    }
  }

  const total = t1 + t2 + t3 + t4;
  // Patch engine contract: return numeric match count (0 = not applicable, >0 = applied)
  return total;
}

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-gateway-models-unfilter.cjs <input.js> [output.js]");
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
    console.error(`Gateway models unfilter: ${total} transform(s) applied`);
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

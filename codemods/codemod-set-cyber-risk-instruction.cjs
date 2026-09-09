#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

const MOD_ID = "set_cyber_risk_instruction";
const SECURITY_INSTRUCTION_PREFIX = "IMPORTANT: Assist with authorized security testing";

/**
 * Check if a StringLiteral is the security instruction (starts with the prefix).
 */
function isSecurityInstruction(node) {
  if (!t.isStringLiteral(node)) return false;
  return node.value.startsWith(SECURITY_INSTRUCTION_PREFIX);
}

/**
 * Build the typeof guard for __isModEnabled__.
 * Pattern: typeof __isModEnabled__ === "function" && __isModEnabled__("set_cyber_risk_instruction")
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
 * Build the env var fallback expression.
 * Pattern: process.env.CLAUDE_CYBER_RISK_INSTRUCTION || ORIGINAL_STRING
 */
function buildEnvFallback(originalString) {
  return t.logicalExpression(
    "||",
    t.memberExpression(
      t.memberExpression(t.identifier("process"), t.identifier("env")),
      t.identifier("CLAUDE_CYBER_RISK_INSTRUCTION"),
      false // computed=false generates process.env.CLAUDE_CYBER_RISK_INSTRUCTION (dot notation)
    ),
    t.stringLiteral(originalString)
  );
}

/**
 * Main transform: find VariableDeclarator with security instruction string
 * and wrap the initializer in a mod guard conditional.
 */
function transform(ast) {
  let wrapped = 0;

  traverse(ast, {
    VariableDeclarator(declaratorPath) {
      const { node, parent } = declaratorPath;

      // Only match var declarations (not let/const)
      if (!t.isVariableDeclaration(parent, { kind: "var" })) return;

      // Check if init is the security instruction string
      if (!isSecurityInstruction(node.init)) return;

      // Found: var JiK = "IMPORTANT: Assist with authorized security testing...";
      // Replace init with: __getModConfig__("set_cyber_risk_instruction","instruction") ?? original
      // Disabled -> undefined ?? original -> original; enabled+set -> value; enabled+"" -> "" (CLEAR).
      const originalString = node.init.value;
      node.init = t.logicalExpression("??",
        t.callExpression(t.identifier("__getModConfig__"), [t.stringLiteral(MOD_ID), t.stringLiteral("instruction")]),
        t.stringLiteral(originalString));

      wrapped += 1;
    },
  });

  return wrapped;
}

/** CLI wrapper */

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-set-cyber-risk-instruction.cjs <input.js> [output.js]");
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
    throw new Error("No matching security instruction string found; nothing changed.");
  } else {
    console.error(`Wrapped ${wrappedCount} security instruction variable(s) with __isModEnabled__ guard.`);
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

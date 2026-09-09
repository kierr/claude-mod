#!/usr/bin/env node
// Match each numeric limit by its surrounding operation; identical constants serve independent purposes.

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

/**
 * Build the replacement init: __getModConfig__("set_context_limit", key) ?? defaultValue.
 * Disabled -> undefined ?? defaultValue -> defaultValue (original); enabled+set -> value;
 * enabled+absent -> defaultValue (RESET). mods.json stores real numbers, so no parseInt.
 */
function buildCfg(key, defaultValue) {
  return t.logicalExpression("??",
    t.callExpression(t.identifier("__getModConfig__"), [t.stringLiteral("set_context_limit"), t.stringLiteral(key)]),
    t.numericLiteral(defaultValue)
  );
}

/**
 * Collect numeric values from sibling VariableDeclaration statements around
 * the target index in the parent body. Each `var X = value;` is its own
 * VariableDeclaration node with a single declarator in minified code.
 */
function siblingNumericValues(body, targetIndex) {
  const start = Math.max(0, targetIndex - 3);
  const end = Math.min(body.length, targetIndex + 4);
  const values = [];
  for (let i = start; i < end; i++) {
    if (i === targetIndex) continue;
    const stmt = body[i];
    if (
      t.isVariableDeclaration(stmt) &&
      stmt.declarations.length === 1 &&
      t.isIdentifier(stmt.declarations[0].id) &&
      t.isNumericLiteral(stmt.declarations[0].init)
    ) {
      values.push(stmt.declarations[0].init.value);
    }
  }
  return values;
}

/**
 * Check if a VariableDeclaration matches the target cluster by position.
 * Works for both unpatched (NumericLiteral init) and already-patched
 * (ConditionalExpression init) variables — used for discovery-only passes.
 */
function matchesCluster(varPath, targetValue, expectedNeighbors) {
  const decl = varPath.node.declarations[0];
  if (!t.isIdentifier(decl.id)) return false;

  // For unpatched vars, check the numeric value matches
  const isUnpatched = t.isNumericLiteral(decl.init) && decl.init.value === targetValue;
  // For already-patched vars, check the ??-expression has the right numeric default on the right
  const isPatched = t.isLogicalExpression(decl.init, { operator: "??" }) &&
    t.isNumericLiteral(decl.init.right) &&
    decl.init.right.value === targetValue;

  if (!isUnpatched && !isPatched) return false;

  const parent = varPath.parent;
  if (!parent || !Array.isArray(parent.body)) return false;

  const body = parent.body;
  const idx = body.indexOf(varPath.node);
  if (idx === -1) return false;

  const neighbors = siblingNumericValues(body, idx);
  return expectedNeighbors.every((v) => neighbors.includes(v));
}

/**
 * Find a single-declarator VariableDeclaration by cluster and return its
 * variable name. Checks both unpatched (NumericLiteral) and already-patched
 * (ConditionalExpression with matching default) states.
 * Returns the variable name or null.
 */
function discoverVarByCluster(ast, targetValue, expectedNeighbors) {
  let varName = null;

  traverse(ast, {
    VariableDeclaration(varPath) {
      if (varPath.node.declarations.length !== 1) return;
      if (matchesCluster(varPath, targetValue, expectedNeighbors)) {
        varName = varPath.node.declarations[0].id.name;
      }
    },
  });

  return varName;
}

/**
 * Generic transform: find a VariableDeclaration by cluster and replace its init.
 * Returns the variable name or null. Skips already-patched variables.
 */
function patchByCluster(ast, targetValue, expectedNeighbors, envVarName) {
  let varName = null;

  traverse(ast, {
    VariableDeclaration(varPath) {
      if (varPath.node.declarations.length !== 1) return;
      const decl = varPath.node.declarations[0];
      // Idempotency: skip already-patched vars (ConditionalExpression from prior run)
      // NumericLiteral check is separate — patched vars have ConditionalExpression init.
      if (t.isLogicalExpression(decl.init, { operator: "??" })) return;
      if (!t.isIdentifier(decl.id) || !t.isNumericLiteral(decl.init)) return;
      if (decl.init.value !== targetValue) return;

      const parent = varPath.parent;
      if (!parent || !Array.isArray(parent.body)) return;

      const body = parent.body;
      const idx = body.indexOf(varPath.node);
      if (idx === -1) return;

      const neighbors = siblingNumericValues(body, idx);
      if (expectedNeighbors.every((v) => neighbors.includes(v))) {
        varName = decl.id.name;
        varPath.node.declarations[0].init = buildEnvRead(envVarName, targetValue);
      }
    },
  });

  return varName;
}

/**
 * Transform 4: Replace hardcoded > 200000 comparison in the function that
 * contains .findLast with "assistant" string literal.
 * Replace the right-hand side with a reference to the context window variable.
 */
function transformHardcodedComparison(ast, contextWindowVarName) {
  if (!contextWindowVarName) return 0;

  let changed = 0;

  traverse(ast, {
    // Walk all functions looking for the one with findLast("assistant")
    FunctionDeclaration(funcPath) {
      let hasFindLastAssistant = false;

      funcPath.traverse({
        CallExpression(callPath) {
          const callee = callPath.node.callee;
          if (
            !t.isMemberExpression(callee) ||
            !t.isIdentifier(callee.property, { name: "findLast" })
          ) return;

          // Check if the callback contains a comparison with "assistant"
          const callback = callPath.node.arguments[0];
          if (!callback) return;

          // Look for "assistant" string literal anywhere in the callback
          let foundAssistant = false;
          callPath.traverse({
            StringLiteral(strPath) {
              if (strPath.node.value === "assistant") {
                foundAssistant = true;
              }
            },
          });

          if (foundAssistant) hasFindLastAssistant = true;
        },
      });

      if (!hasFindLastAssistant) return;

      // Now find the > 200000 comparison in this function
      funcPath.traverse({
        BinaryExpression(binPath) {
          if (binPath.node.operator !== ">") return;
          if (!t.isNumericLiteral(binPath.node.right, { value: 200000 })) return;

          binPath.node.right = t.identifier(contextWindowVarName);
          changed++;
        },
      });
    },
  });

  return changed;
}

function transform(ast) {
  // Pass 1: Discover + patch all cluster targets (single traversal)
  // Merges discoverVarByCluster + 3x patchByCluster into one VariableDeclaration walk.
  let contextWindowVar = null;
  let contextWindowPatched = 0;
  let toolBatch = 0;
  let memoryChunk = 0;

  traverse(ast, {
    VariableDeclaration(varPath) {
      if (varPath.node.declarations.length !== 1) return;
      const decl = varPath.node.declarations[0];
      if (!t.isIdentifier(decl.id)) return;

      // Discover context window var (both patched and unpatched)
      if (matchesCluster(varPath, 200000, [20000, 32000])) {
        contextWindowVar = decl.id.name;
        // Patch if still a bare NumericLiteral (idempotency)
        if (t.isNumericLiteral(decl.init) && decl.init.value === 200000) {
          decl.init = buildCfg("context_limit", 200000);
          contextWindowPatched = 1;
        }
        return; // Can't match other clusters — same target value but different neighbors
      }

      // Idempotency: skip already-patched vars
      if (t.isLogicalExpression(decl.init, { operator: "??" })) return;
      if (!t.isNumericLiteral(decl.init) || decl.init.value !== 200000) return;

      const parent = varPath.parent;
      if (!parent || !Array.isArray(parent.body)) return;
      const body = parent.body;
      const idx = body.indexOf(varPath.node);
      if (idx === -1) return;
      const neighbors = siblingNumericValues(body, idx);

      // Tool batch cluster: 200000 with neighbors [400000, 50]
      if ([400000, 50].every(v => neighbors.includes(v))) {
        decl.init = buildCfg("tool_batch_limit", 200000);
        toolBatch = 1;
        return;
      }

      // Memory chunk cluster: 200000 with neighbors [250000, 3]
      if ([250000, 3].every(v => neighbors.includes(v))) {
        decl.init = buildCfg("memory_chunk_limit", 200000);
        memoryChunk = 1;
        return;
      }
    },
  });

  // Pass 2: Replace hardcoded > 200000 comparison (depends on contextWindowVar)
  const comparison = transformHardcodedComparison(ast, contextWindowVar);

  // Aggregate match count for the engine contract (number or {changed: N}).
  const total = contextWindowPatched + toolBatch + memoryChunk + comparison;
  return total;
}

/** CLI wrapper */

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-set-context-limit.cjs <input.js> [output.js]");
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

  const results = transform(ast);

  if (results.contextWindowVar) {
    console.error(`Context window variable: ${results.contextWindowVar}`);
  } else {
    console.error("Warning: context window variable not found (pattern may have changed).");
  }

  if (results.toolBatch) {
    console.error(`Patched tool batch limit (${results.toolBatch} site(s)).`);
  } else {
    console.error("Warning: tool batch limit not found (may already be patched or pattern changed).");
  }

  if (results.memoryChunk) {
    console.error(`Patched memory chunk limit (${results.memoryChunk} site(s)).`);
  } else {
    console.error("Warning: memory chunk limit not found (may already be patched or pattern changed).");
  }

  if (results.comparison) {
    console.error(`Patched hardcoded comparison (now references ${results.contextWindowVar}).`);
  } else if (results.contextWindowVar) {
    console.error("Warning: hardcoded > 200000 comparison not found (may already be patched or pattern changed).");
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

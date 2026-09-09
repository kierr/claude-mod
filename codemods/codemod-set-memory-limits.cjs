#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

/**
 * Build AST node for: __getModConfig__("set_memory_limits", key) ?? defaultNode
 * Disabled -> undefined ?? defaultNode -> defaultNode (original); enabled+set -> value;
 * enabled+absent -> defaultNode (RESET); enabled+"" -> "" (CLEAR). mods.json stores real
 * numbers, so no parseInt.
 */
function buildCfg(key, defaultNode) {
  return t.logicalExpression("??",
    t.callExpression(t.identifier("__getModConfig__"), [t.stringLiteral("set_memory_limits"), t.stringLiteral(key)]),
    defaultNode
  );
}

/**
 * Check if a TemplateLiteral contains the given text fragments in its quasis.
 */
function templateLiteralContainsText(node, fragments) {
  if (!t.isTemplateLiteral(node)) return false;

  const quasiText = node.quasis.map(q => q.value.cooked || "").join(" ");
  return fragments.every(frag => quasiText.includes(frag));
}

/**
 * Build a line→character-offset lookup table from source code.
 * O(lines) once, enables O(1) offset lookups thereafter.
 */
function buildLineOffsetMap(sourceCode) {
  const map = [0];
  let offset = 0;
  for (let i = 0; i < sourceCode.length; i++) {
    if (sourceCode[i] === "\n") { offset = i + 1; map.push(offset); }
  }
  return map;
}

/**
 * Get character offset for a given line/column position using pre-built offset map.
 * O(1) instead of O(line_number) indexOf loop.
 */
function getOffset(line, column, lineMap) {
  const base = lineMap[line - 1] ?? 0; // Babel's loc.line is 1-indexed; map is 0-indexed
  return base + column;
}

/**
 * Check if the containing scope (nearest function or program root) for a path
 * contains text. Uses source-offset substring search on the raw source code
 * instead of generate(), avoiding the cost of code generation from the AST.
 */
function contextContainsText(path, searchText, sourceCode, lineMap) {
  let scopePath = path;
  while (scopePath) {
    if (scopePath.isFunctionParent() || scopePath.isProgram()) {
      break;
    }
    scopePath = scopePath.parentPath;
  }
  if (!scopePath || !scopePath.node.loc) return false;
  const start = scopePath.node.loc.start;
  const offset = getOffset(start.line, start.column, lineMap);
  // Search the next ~50KB of source from the scope start
  const window = sourceCode.substring(offset, Math.min(sourceCode.length, offset + 50000));
  return window.includes(searchText);
}

/**
 * Check if we're inside a function that contains the given text.
 * Uses raw source substring search instead of generate().
 */
function isInFunctionContainingText(path, searchText, sourceCode, lineMap) {
  let current = path;
  while (current) {
    if (current.isFunctionParent()) {
      if (current.node.loc) {
        const start = current.node.loc.start;
        const offset = getOffset(start.line, start.column, lineMap);
        const window = sourceCode.substring(offset, Math.min(sourceCode.length, offset + 50000));
        if (window.includes(searchText)) return true;
      }
      break;
    }
    current = current.parentPath;
  }
  return false;
}

/**
 * Check if this codemod has already been applied by scanning for our injected
 * __getModConfig__ marker. Avoids generating the entire ~600K-line AST to check.
 */
function isAlreadyApplied(sourceCode) {
  return sourceCode.includes('__getModConfig__("set_memory_limits"');
}

/**
 * Main transform: applies all 7 memory configuration transforms.
 */
function transform(ast, sourceCode) {
  // Idempotency check: if any of our env vars are already present, skip
  if (isAlreadyApplied(sourceCode)) {
    return 0;
  }

  let changes = 0;

  // Track processed declarations to avoid double-processing
  const processedDeclarations = new Set();

  const lineMap = buildLineOffsetMap(sourceCode);

  traverse(ast, {
    // Transform 1 & 2: Line and byte limits (200 and 4096)
    // Matcher: Find TemplateLiteral where quasis contain "first " and " lines"
    TemplateLiteral(path) {
      if (!templateLiteralContainsText(path.node, ["first ", " lines"])) return;

      // Find the expression between "first " and " lines" — that's the line limit variable
      const lineLimitExpr = path.node.expressions[0];
      if (t.isIdentifier(lineLimitExpr)) {
        const binding = path.scope.getBinding(lineLimitExpr.name);
        if (binding && binding.path.isVariableDeclarator()) {
          const decl = binding.path.node;
          if (decl.init && t.isNumericLiteral(decl.init) && decl.init.value === 200) {
            const declPath = binding.path;
            if (!processedDeclarations.has(declPath)) {
              decl.init = buildCfg("max_lines", t.numericLiteral(200));
              processedDeclarations.add(declPath);
              changes++;
            }
          }
        }
      }

      // In the same template, find byte limit: second expression
      if (path.node.expressions.length >= 2) {
        const byteLimitExpr = path.node.expressions[1];
        if (t.isIdentifier(byteLimitExpr)) {
          const binding = path.scope.getBinding(byteLimitExpr.name);
          if (binding && binding.path.isVariableDeclarator()) {
            const decl = binding.path.node;
            if (decl.init && t.isNumericLiteral(decl.init) && decl.init.value === 4096) {
              const declPath = binding.path;
              if (!processedDeclarations.has(declPath)) {
                decl.init = buildCfg("max_bytes", t.numericLiteral(4096));
                processedDeclarations.add(declPath);
                changes++;
              }
            }
          }
        }
      }
    },

    // Transform 3 & 5: File scan limits (200/500) and recall limit (5)
    // Both use .slice(0, ...) patterns
    CallExpression(path) {
      // Match .slice(0, ...)
      if (
        !t.isMemberExpression(path.node.callee) ||
        !t.isIdentifier(path.node.callee.property, { name: "slice" }) ||
        path.node.arguments.length !== 2 ||
        !t.isNumericLiteral(path.node.arguments[0], { value: 0 })
      ) {
        return;
      }

      const sliceArg = path.node.arguments[1];

      // Transform 3: File scan limits (200 and 500)
      // Matcher: Find .slice(0, X) or .slice(0, _ ? X : Y) in memory scanning context
      if (contextContainsText(path, "mtimeMs", sourceCode, lineMap)) {
        // Case A: direct identifier limit.
        if (t.isIdentifier(sliceArg)) {
          const binding = path.scope.getBinding(sliceArg.name);
          if (binding && binding.path.isVariableDeclarator()) {
            const decl = binding.path.node;
            if (decl.init && t.isNumericLiteral(decl.init)) {
              const val = decl.init.value;
              const declPath = binding.path;
              if (val === 200 && !processedDeclarations.has(declPath)) {
                decl.init = buildCfg("max_files", t.numericLiteral(200));
                processedDeclarations.add(declPath);
                changes++;
              }
            }
          }
        }

        // Case B: conditional identifier limit.
        if (t.isConditionalExpression(sliceArg)) {
          const consequent = sliceArg.consequent;
          const alternate = sliceArg.alternate;

          if (t.isIdentifier(consequent)) {
            const binding = path.scope.getBinding(consequent.name);
            if (binding && binding.path.isVariableDeclarator()) {
              const decl = binding.path.node;
              if (decl.init && t.isNumericLiteral(decl.init) && decl.init.value === 500) {
                const declPath = binding.path;
                if (!processedDeclarations.has(declPath)) {
                  decl.init = buildCfg("max_files_structured", t.numericLiteral(500));
                  processedDeclarations.add(declPath);
                  changes++;
                }
              }
            }
          }

          if (t.isIdentifier(alternate)) {
            const binding = path.scope.getBinding(alternate.name);
            if (binding && binding.path.isVariableDeclarator()) {
              const decl = binding.path.node;
              if (decl.init && t.isNumericLiteral(decl.init) && decl.init.value === 200) {
                const declPath = binding.path;
                if (!processedDeclarations.has(declPath)) {
                  decl.init = buildCfg("max_files", t.numericLiteral(200));
                  processedDeclarations.add(declPath);
                  changes++;
                }
              }
            }
          }
        }
      }

      // Transform 5: .slice(0, 5) recall limit
      // Matcher: Find .slice(0, 5) preceded by .filter in a chain containing .has
      if (t.isNumericLiteral(sliceArg, { value: 5 })) {
        if (contextContainsText(path, ".has(", sourceCode, lineMap)) {
          path.node.arguments[1] = buildCfg("max_recall", t.numericLiteral(5));
          changes++;
        }
      }
    },

    // Transform 4: "up to 5" prompt
    // Matcher: Find StringLiteral containing "up to 5"
    StringLiteral(path) {
      if (path.node.value.includes("up to 5")) {
        // Replace "up to 5" with "up to ${env || 5}" while preserving the rest of the string
        const value = path.node.value;
        const idx = value.indexOf("up to 5");
        const before = value.slice(0, idx);
        const after = value.slice(idx + 7); // length of "up to 5"

        // Replace first occurrence only, preserving the rest
        const newTemplate = t.templateLiteral(
          [
            t.templateElement({ raw: before + "up to ", cooked: before + "up to " }, false),
            t.templateElement({ raw: after, cooked: after }, true)
          ],
          [
            buildCfg("max_recall", t.stringLiteral("5"))
          ]
        );
        path.replaceWith(newTemplate);
        changes++;
      }
    },

    // Transform 6 & 7: Selector model and max_tokens
    // Both are in the same selector function context
    ObjectProperty(path) {
      // Check if we're in the selector function context
      // Look for "memories relevant to" which is in the prompt string
      if (!isInFunctionContainingText(path, "memories relevant to", sourceCode, lineMap)) {
        return;
      }

      // Transform 6: Selector model
      // Matcher: Find ObjectProperty with key "model" where value is a CallExpression (no arguments)
      if (
        t.isIdentifier(path.node.key, { name: "model" }) &&
        t.isCallExpression(path.node.value) &&
        path.node.value.arguments.length === 0
      ) {
        const originalCall = path.node.value;
        path.node.value = buildCfg("selector_model", originalCall);
        changes++;
      }

      // Transform 7: max_tokens: 256
      // Matcher: Find ObjectProperty with key "max_tokens" and value NumericLiteral(256)
      if (
        t.isIdentifier(path.node.key, { name: "max_tokens" }) &&
        t.isNumericLiteral(path.node.value, { value: 256 })
      ) {
        path.node.value = buildCfg("selector_max_tokens", t.numericLiteral(256));
        changes++;
      }
    }
  });

  return changes;
}

/** CLI wrapper */

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-set-memory-limits.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const ast = parser.parse(code, {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript"],
  });

  const changeCount = transform(ast, code);

  if (changeCount === 0) {
    console.error("No matching memory limit patterns found; nothing changed.");
  } else {
    console.error(`Applied ${changeCount} memory configuration change(s).`);
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

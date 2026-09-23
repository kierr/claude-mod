#!/usr/bin/env node

const MOD_ID = "unlock_models";

const fs = require("fs");
const path = require("path");

const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");


// Helpers


/**
 * Check if a node is a call to a memoized (() => h.object({...}).strip()) with
 * `id: h.string()` AND `max_tokens: h.number().optional()`.
 * This uniquely identifies the model capabilities schema.
 */
function isSchemaFactoryWithIdField(path) {
  const node = path.node;
  if (!t.isCallExpression(node) || node.arguments.length !== 1) return false;
  if (!t.isIdentifier(node.callee)) return false;

  // Argument must be an arrow function: () => h.object({...}).strip()
  const arg = node.arguments[0];
  if (!t.isArrowFunctionExpression(arg) || arg.params.length !== 0) return false;
  if (!t.isCallExpression(arg.body)) return false;

  // Unwrap possible .strip() chain: h.object({...}).strip()
  // arg.body is either h.object({...}) or h.object({...}).strip()
  let objCall = arg.body;
  if (
    t.isMemberExpression(objCall.callee) &&
    t.isIdentifier(objCall.callee.property, { name: "strip" })
  ) {
    objCall = objCall.callee.object;
  }

  // objCall must be h.object({...})
  if (!t.isCallExpression(objCall)) return false;
  if (!t.isMemberExpression(objCall.callee)) return false;
  if (!t.isIdentifier(objCall.callee.property, { name: "object" })) return false;
  if (objCall.arguments.length !== 1) return false;
  if (!t.isObjectExpression(objCall.arguments[0])) return false;

  // Must contain `id: h.string()` AND `max_tokens: h.number().optional()`
  const props = objCall.arguments[0].properties;
  const hasId = props.some(p =>
    t.isObjectProperty(p) &&
    !p.computed &&
    t.isIdentifier(p.key, { name: "id" }) &&
    t.isCallExpression(p.value) &&
    t.isMemberExpression(p.value.callee) &&
    t.isIdentifier(p.value.callee.property, { name: "string" })
  );
  const hasMaxTokens = props.some(p =>
    t.isObjectProperty(p) &&
    !p.computed &&
    t.isIdentifier(p.key, { name: "max_tokens" })
  );

  return hasId && hasMaxTokens;
}

/**
 * Check if a node is `process.env.ANTHROPIC_CUSTOM_MODEL_OPTION`
 * (non-computed MemberExpression chain).
 */
function isProcessEnvDot(node, name) {
  if (!t.isMemberExpression(node) || node.computed) return false;
  if (!t.isIdentifier(node.property, { name })) return false;
  const obj = node.object;
  if (!t.isMemberExpression(obj) || obj.computed) return false;
  if (!t.isIdentifier(obj.property, { name: "env" })) return false;
  return t.isIdentifier(obj.object, { name: "process" });
}

/**
 * Check if a function body contains both `process.env.ANTHROPIC_CUSTOM_MODEL_OPTION`
 * (non-computed member expression) and the identifier `additionalModelOptionsCache`.
 * Used to find the model picker function.
 */
function isModelPickerFunction(path) {
  let hasCustomModelOption = false;
  let hasAdditionalCache = false;

  path.traverse({
    MemberExpression(p) {
      if (isProcessEnvDot(p.node, "ANTHROPIC_CUSTOM_MODEL_OPTION")) {
        hasCustomModelOption = true;
      }
    },
    Identifier(p) {
      if (p.node.name === "additionalModelOptionsCache") {
        hasAdditionalCache = true;
      }
    },
  });

  return hasCustomModelOption && hasAdditionalCache;
}

/**
 * Check if a `return false` function is the model capabilities caching gate.
 * Heuristic: within 50 sibling statements, there's a function containing
 * the string "model-capabilities.json". This string is a stable literal in
 * the same module, not a minified name.
 *
 * Window of 50 (not 10) to tolerate minifier reordering of top-level
 * declarations across releases.
 */
function isModelCachingGate(path) {
  const parent = path.parent;
  if (!t.isProgram(parent)) return false;

  const siblings = parent.body;
  const idx = siblings.indexOf(path.node);
  if (idx === -1) return false;

  // Check ±50 siblings for a function containing "model-capabilities.json"
  const start = Math.max(0, idx - 50);
  const end = Math.min(siblings.length, idx + 51);
  for (let i = start; i < end; i++) {
    const sibling = siblings[i];
    if (sibling === path.node) continue;
    if (!t.isFunctionDeclaration(sibling)) continue;
    if (containsString(sibling, "model-capabilities.json")) return true;
  }

  return false;
}

/**
 * Simple recursive check if an AST node tree contains a StringLiteral with the
 * given value, or an Identifier with the given name.
 */
function containsString(node, value) {
  if (!node || typeof node !== "object") return false;
  if (node.type === "StringLiteral" && node.value === value) return true;
  if (node.type === "Identifier" && node.name === value) return true;
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "type") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (containsString(item, value)) return true;
      }
    } else if (child && typeof child === "object") {
      if (containsString(child, value)) return true;
    }
  }
  return false;
}


// Dynamic name discovery


/**
 * Discover the memoized cache reader function name and cache path function
 * name from the module containing the model capabilities logic.
 *
 * Strategy:
 * 1. Find the lazy-init wrapper block that contains both a schema factory (() => h.object({id:...}))
 *    and a memoized reader assignment -- uniquely identifies the model capabilities module.
 * 2. Extract memoizedReaderName from the wrapper block.
 * 3. Find cachePathFnName from module scope — the function containing "model-capabilities.json".
 *
 * Returns { cachePathFnName: string, memoizedReaderName: string } or null.
 */
function discoverCacheFunctionNames(ast) {
  let result = null;

  // Phase 1: Find memoizedReaderName from the lazy-init wrapper block that contains
  // a safeParse call (unique to the model capabilities module).
  // The wrapper block assigns: <memoized_reader> = <memoize_fn>(q => { ... safeParse ... }, q => q)
  let memoizedReaderName = null;

  traverse(ast, {
    CallExpression(path) {
      if (memoizedReaderName) return;
      if (!t.isIdentifier(path.node.callee)) return;
      if (path.node.arguments.length !== 1) return;
      const arg = path.node.arguments[0];
      if (!t.isArrowFunctionExpression(arg)) return;
      if (!t.isBlockStatement(arg.body)) return;

      // Check this wrapper block contains both "safeParse" AND the schema factory
      // (has id + max_tokens). safeParse alone is too broad for the CLI bundle.
      if (!containsString(arg.body, "safeParse")) return;
      let hasSchemaFactory = false;
      path.traverse({
        CallExpression(innerPath) {
          if (isSchemaFactoryWithIdField(innerPath)) {
            hasSchemaFactory = true;
            innerPath.stop();
          }
        },
      });
      if (!hasSchemaFactory) return;

      // Find the memoized reader assignment: <id> = <memoize_fn>(<arrow_fn>, <id>)
      // It's an ExpressionStatement with an AssignmentExpression whose RHS is a
      // CallExpression with 2 arguments (the reader arrow fn and the cache key fn)
      for (const stmt of arg.body.body) {
        if (!t.isExpressionStatement(stmt)) continue;
        const expr = stmt.expression;
        if (!t.isAssignmentExpression(expr)) continue;
        if (!t.isIdentifier(expr.left)) continue;
        const rhs = expr.right;
        // Memoized reader: RHS is a call with 2 arrow-fn args (reader + cache key)
        if (t.isCallExpression(rhs) && rhs.arguments.length === 2) {
          if (t.isArrowFunctionExpression(rhs.arguments[0]) && t.isArrowFunctionExpression(rhs.arguments[1])) {
            memoizedReaderName = expr.left.name;
            break;
          }
        }
      }
    },
  });

  if (!memoizedReaderName) return null;

  // Phase 2: Find cachePathFnName from module scope.
  // Look for a function whose body contains "model-capabilities.json".
  // The structure is: function <name>() { return <join>(..., "model-capabilities.json"); }
  let cachePathFnName = null;

  traverse(ast, {
    FunctionDeclaration(path) {
      if (cachePathFnName) return;
      if (!containsString(path.node, "model-capabilities.json")) return;
      if (t.isIdentifier(path.node.id)) {
        cachePathFnName = path.node.id.name;
      }
    },
  });

  if (cachePathFnName && memoizedReaderName) {
    result = { cachePathFnName, memoizedReaderName };
  }

  return result;
}


// AST builders


/**
 * Append cached API models without replacing existing picker entries.
 * Cache-read failures must leave the original model list usable.
 * @param {string} memoizedReaderName - discovered cache reader
 * @param {string} cachePathFnName - discovered cache-path resolver
 * @param {Identifier} modelListId - picker-array AST identifier
 */
function buildApiModelsBlock(memoizedReaderName, cachePathFnName, modelListId) {
  return t.tryStatement(
    // try body
    t.blockStatement([
      // let _apiModels = <memoizedReaderName>(<cachePathFnName>());
      t.variableDeclaration("let", [
        t.variableDeclarator(
          t.identifier("_apiModels"),
          t.callExpression(
            t.identifier(memoizedReaderName),
            [t.callExpression(t.identifier(cachePathFnName), [])]
          )
        ),
      ]),
      // if (_apiModels && _apiModels.length > 0)
      t.ifStatement(
        t.logicalExpression(
          "&&",
          t.identifier("_apiModels"),
          t.binaryExpression(
            ">",
            t.memberExpression(t.identifier("_apiModels"), t.identifier("length")),
            t.numericLiteral(0)
          )
        ),
        t.blockStatement([
          // for (let _am of _apiModels)
          t.forOfStatement(
            t.variableDeclaration("let", [
              t.variableDeclarator(t.identifier("_am"), null),
            ]),
            t.identifier("_apiModels"),
            t.blockStatement([
              // if (!<modelListId>.some(function(_x) { return _x.value === _am.id; }))
              t.ifStatement(
                t.unaryExpression(
                  "!",
                  t.callExpression(
                    t.memberExpression(t.cloneNode(modelListId), t.identifier("some")),
                    [
                      t.functionExpression(
                        null,
                        [t.identifier("_x")],
                        t.blockStatement([
                          t.returnStatement(
                            t.binaryExpression(
                              "===",
                              t.memberExpression(t.identifier("_x"), t.identifier("value")),
                              t.memberExpression(t.identifier("_am"), t.identifier("id"))
                            )
                          ),
                        ])
                      ),
                    ]
                  )
                ),
                // <modelListId>.push({ value, label, description })
                t.blockStatement([
                  t.expressionStatement(
                    t.callExpression(
                      t.memberExpression(t.cloneNode(modelListId), t.identifier("push")),
                      [
                        t.objectExpression([
                          t.objectProperty(
                            t.identifier("value"),
                            t.memberExpression(t.identifier("_am"), t.identifier("id"))
                          ),
                          t.objectProperty(
                            t.identifier("label"),
                            t.logicalExpression(
                              "||",
                              t.memberExpression(t.identifier("_am"), t.identifier("display_name")),
                              t.memberExpression(t.identifier("_am"), t.identifier("id"))
                            )
                          ),
                          t.objectProperty(
                            t.identifier("description"),
                            t.logicalExpression(
                              "||",
                              t.memberExpression(t.identifier("_am"), t.identifier("display_name")),
                              t.memberExpression(t.identifier("_am"), t.identifier("id"))
                            )
                          ),
                        ])
                      ]
                    )
                  ),
                ])
              ),
            ])
          ),
        ])
      ),
    ]),
    // catch: empty block
    t.catchClause(t.identifier("_e"), t.blockStatement([]))
  );
}

/**
 * Build the `display_name: <schemaLib>.string().optional()` property AST node.
 *
 * `schemaLib` is the captured schema-library identifier name (e.g. "h", "z",
 * "Ix9") discovered at the call site. It MUST NOT be hardcoded — webcrack
 * renames it every release, and a stale literal produces output that parses
 * and passes status_tests but throws ReferenceError at runtime when the
 * renamed identifier is referenced.
 */
function buildDisplayNameProperty(schemaLib) {
  return t.objectProperty(
    t.identifier("display_name"),
    t.callExpression(
      t.memberExpression(
        t.callExpression(
          t.memberExpression(t.identifier(schemaLib), t.identifier("string")),
          []
        ),
        t.identifier("optional")
      ),
      []
    )
  );
}


// Transform


function transform(ast) {
  let t1 = 0; // caching gate: return false → return true
  let t2 = 0; // schema extended
  let t3 = 0; // API models appended in picker function

  // Discover dynamic function names before traversal
  const cacheNames = discoverCacheFunctionNames(ast);
  if (!cacheNames) {
    throw new Error("Could not discover cache function names from the model-capabilities wrapper.");
  }

  traverse(ast, {
    // Transform 1 & 3: both target FunctionDeclaration nodes
    FunctionDeclaration(path) {
      const node = path.node;
      if (!t.isIdentifier(node.id)) return;

      // Transform 1: caching gate returns false → returns mod guard
      if (
        t.isBlockStatement(node.body) &&
        node.body.body.length === 1 &&
        t.isReturnStatement(node.body.body[0]) &&
        t.isBooleanLiteral(node.body.body[0].argument, { value: false }) &&
        isModelCachingGate(path)
      ) {
        // typeof __isModEnabled__ === "function" && __isModEnabled__("model_full_list")
        node.body.body[0].argument = t.logicalExpression(
          "&&",
          t.binaryExpression(
            "===",
            t.unaryExpression("typeof", t.identifier("__isModEnabled__")),
            t.stringLiteral("function")
          ),
          t.callExpression(t.identifier("__isModEnabled__"), [t.stringLiteral(MOD_ID)])
        );
        t1 += 1;
        return;
      }

      // Transform 3: Append API models in picker function
      if (t3 > 0) return;
      if (!isModelPickerFunction(path)) return;

      const body = path.node.body;
      if (!t.isBlockStatement(body)) return;

      // Find the picker array identifier by matching the .push({value, label, description})
      // operation already present in the function (same semantic pattern as add-multi-custom-models).
      // This is more reliable than positional "first call-initialized local" heuristics.
      let modelListId = null;
      path.traverse({
        CallExpression(pushPath) {
          if (modelListId) return;
          const callNode = pushPath.node;
          if (!t.isMemberExpression(callNode.callee)) return;
          if (!t.isIdentifier(callNode.callee.property, { name: "push" })) return;
          if (!t.isIdentifier(callNode.callee.object)) return;
          if (callNode.arguments.length === 0) return;
          if (!t.isObjectExpression(callNode.arguments[0])) return;
          const props = callNode.arguments[0].properties;
          if (props.length !== 3) return;
          const propNames = props
            .filter(p => t.isObjectProperty(p) && t.isIdentifier(p.key))
            .map(p => p.key.name);
          if (propNames.length !== 3) return;
          if (!propNames.includes("value") || !propNames.includes("label") || !propNames.includes("description")) return;

          modelListId = callNode.callee.object;
        },
      });
      if (!modelListId) return;

      // Insert after the picker array declaration (first VariableDeclarator whose init is a CallExpression)
      let insertIdx = -1;
      for (let i = 0; i < body.body.length; i++) {
        const stmt = body.body[i];
        if (t.isVariableDeclaration(stmt) && stmt.declarations.length === 1) {
          const decl = stmt.declarations[0];
          if (t.isIdentifier(decl.id) && decl.id.name === modelListId.name) {
            insertIdx = i + 1;
            break;
          }
        }
      }
      if (insertIdx === -1) return;

      // Don't double-apply: check if the next statement is our mod-guarded try/catch.
      // Current form: IfStatement → BlockStatement → TryStatement → _apiModels
      // Legacy form: bare TryStatement → _apiModels (pre-mod-wrap)
      if (insertIdx < body.body.length) {
        let next = body.body[insertIdx];
        // Unwrap if-statement wrapper (current mod-guarded form)
        if (t.isIfStatement(next) && t.isBlockStatement(next.consequent) && next.consequent.body.length === 1) {
          next = next.consequent.body[0];
        }
        if (t.isTryStatement(next)) {
          const tryBody = next.block;
          if (t.isBlockStatement(tryBody) && tryBody.body.length >= 1) {
            const firstStmt = tryBody.body[0];
            if (
              t.isVariableDeclaration(firstStmt) &&
              firstStmt.declarations.length === 1 &&
              t.isIdentifier(firstStmt.declarations[0].id, { name: "_apiModels" })
            ) {
              return; // already applied
            }
          }
        }
      }

      // Insert the try/catch block wrapped in a mod guard
      const apiModelsBlock = buildApiModelsBlock(cacheNames.memoizedReaderName, cacheNames.cachePathFnName, modelListId);
      const modGuard = t.ifStatement(
        t.logicalExpression(
          "&&",
          t.binaryExpression(
            "===",
            t.unaryExpression("typeof", t.identifier("__isModEnabled__")),
            t.stringLiteral("function")
          ),
          t.callExpression(t.identifier("__isModEnabled__"), [t.stringLiteral(MOD_ID)])
        ),
        t.blockStatement([apiModelsBlock])
      );
      body.body.splice(insertIdx, 0, modGuard);
      t3 += 1;
    },

    // Transform 2: Extend model capabilities schema with display_name
    CallExpression(path) {
      if (t2 > 0) return; // only once
      if (!isSchemaFactoryWithIdField(path)) return;

      // Verify this is inside a lazy-init wrapper call (any callee, 1 arrow-fn arg with safeParse body)
      // that also contains the memoized reader -- confirms it's the model capabilities module.
      let foundLWrapper = false;
      let parentPath = path.parentPath;
      while (parentPath) {
        const pNode = parentPath.node;
        if (
          t.isCallExpression(pNode) &&
          pNode.arguments.length === 1 &&
          t.isIdentifier(pNode.callee) &&
          t.isArrowFunctionExpression(pNode.arguments[0]) &&
          t.isBlockStatement(pNode.arguments[0].body) &&
          containsString(pNode.arguments[0].body, "safeParse")
        ) {
          foundLWrapper = true;
          break;
        }
        // Don't go past true function boundaries. NOTE: arrow functions are
        // intentionally NOT a boundary here — the lazy-init wrapper itself is
        // `b(() => {...})`, an arrow-fn arg, and the schema factory lives in
        // that arrow's body. Breaking on arrows prevents reaching the wrapping
        // CallExpression (silent no-op of transform 2 across all 2.1.x releases).
        if (t.isFunctionDeclaration(pNode) || t.isFunctionExpression(pNode)) break;
        parentPath = parentPath.parentPath;
      }
      if (!foundLWrapper) return;

      // Insert display_name after the `id: <schemaLib>.string()` property.
      // Capture the schema-library identifier (e.g. "h", "z") from the call
      // site so we generate `<schemaLib>.string()` rather than hardcoding "h"
      // — webcrack renames it every release.
      let arrowBody = path.node.arguments[0].body;
      let objCall = arrowBody;
      if (
        t.isMemberExpression(arrowBody.callee) &&
        t.isIdentifier(arrowBody.callee.property, { name: "strip" })
      ) {
        objCall = arrowBody.callee.object;
      }
      // objCall is `<schemaLib>.object({...})` — extract the lib name.
      if (
        !t.isMemberExpression(objCall.callee) ||
        !t.isIdentifier(objCall.callee.object)
      ) {
        return;
      }
      const schemaLib = objCall.callee.object.name;
      const objExpr = objCall.arguments[0];
      const props = objExpr.properties;

      // Find the `id` property index
      let idIdx = -1;
      for (let i = 0; i < props.length; i++) {
        if (
          t.isObjectProperty(props[i]) &&
          t.isIdentifier(props[i].key, { name: "id" })
        ) {
          idIdx = i;
          break;
        }
      }
      if (idIdx === -1) return;

      // Don't double-apply
      const alreadyHasDisplayName = props.some(
        p => t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "display_name" })
      );
      if (alreadyHasDisplayName) return;

      props.splice(idIdx + 1, 0, buildDisplayNameProperty(schemaLib));
      t2 += 1;
    },
  });

  return { t1, t2, t3 };
}





function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-model-full-list.cjs <input.js> [output.js]");
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

  const { t1, t2, t3 } = transform(ast);

  if (t1 === 0 && t2 === 0 && t3 === 0) {
    console.error("No matching patterns found; nothing changed.");
    process.exit(1);
  }

  console.error(`Transform 1 (enable caching): ${t1} match(es)`);
  console.error(`Transform 2 (extend schema): ${t2} match(es)`);
  console.error(`Transform 3 (append API models): ${t3} match(es)`);

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

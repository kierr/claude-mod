#!/usr/bin/env node

const MOD_ID = "add_multi_custom_models";

const fs = require("fs");
const path = require("path");

const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");


// Shared helpers


/**
 * Build a typeof guard for __isModEnabled__.
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
 * Build a guarded loop that appends configured models without duplicates.
 * @param {string} pickerArrayName - discovered picker-array binding
 */
function buildPickerLoop(pickerArrayName) {
  return t.forStatement(
    // init: let _i = 1
    t.variableDeclaration("let", [
      t.variableDeclarator(t.identifier("_i"), t.numericLiteral(1)),
    ]),
    // test: _i <= 20
    t.binaryExpression("<=", t.identifier("_i"), t.numericLiteral(20)),
    // update: _i++
    t.updateExpression("++", t.identifier("_i"), false),
    // body
    t.blockStatement([
      // let _envKey = "ANTHROPIC_CUSTOM_MODEL_OPTION_" + _i;
      t.variableDeclaration("let", [
        t.variableDeclarator(
          t.identifier("_envKey"),
          t.binaryExpression(
            "+",
            t.stringLiteral("ANTHROPIC_CUSTOM_MODEL_OPTION_"),
            t.identifier("_i"),
          ),
        ),
      ]),
      // let _modelId = process.env[_envKey];
      t.variableDeclaration("let", [
        t.variableDeclarator(
          t.identifier("_modelId"),
          t.memberExpression(
            t.memberExpression(
              t.identifier("process"),
              t.identifier("env"),
            ),
            t.identifier("_envKey"),
            true, // computed
          ),
        ),
      ]),
      // if (_modelId && !<pickerArrayName>.some(_A => _A.value === _modelId))
      t.ifStatement(
        t.logicalExpression(
          "&&",
          t.identifier("_modelId"),
          t.unaryExpression(
            "!",
            t.callExpression(
              t.memberExpression(t.identifier(pickerArrayName), t.identifier("some")),
              [
                t.arrowFunctionExpression(
                  [t.identifier("_A")],
                  t.binaryExpression(
                    "===",
                    t.memberExpression(
                      t.identifier("_A"),
                      t.identifier("value"),
                    ),
                    t.identifier("_modelId"),
                  ),
                ),
              ],
            ),
          ),
        ),
        // then: <pickerArrayName>.push({ ... })
        t.blockStatement([
          t.expressionStatement(
            t.callExpression(
              t.memberExpression(t.identifier(pickerArrayName), t.identifier("push")),
              [
                t.objectExpression([
                  t.objectProperty(
                    t.identifier("value"),
                    t.identifier("_modelId"),
                  ),
                  t.objectProperty(
                    t.identifier("label"),
                    t.logicalExpression(
                      "??",
                      t.memberExpression(
                        t.memberExpression(
                          t.identifier("process"),
                          t.identifier("env"),
                        ),
                        t.binaryExpression(
                          "+",
                          t.identifier("_envKey"),
                          t.stringLiteral("_NAME"),
                        ),
                        true,
                      ),
                      t.identifier("_modelId"),
                    ),
                  ),
                  t.objectProperty(
                    t.identifier("description"),
                    t.logicalExpression(
                      "??",
                      t.memberExpression(
                        t.memberExpression(
                          t.identifier("process"),
                          t.identifier("env"),
                        ),
                        t.binaryExpression(
                          "+",
                          t.identifier("_envKey"),
                          t.stringLiteral("_DESCRIPTION"),
                        ),
                        true,
                      ),
                      t.binaryExpression(
                        "+",
                        t.stringLiteral("Custom model ("),
                        t.binaryExpression(
                          "+",
                          t.identifier("_modelId"),
                          t.stringLiteral(")"),
                        ),
                      ),
                    ),
                  ),
                ]),
              ]),
            ),
        ]),
      ),
    ]),
  );
}

/**
 * Build the for-loop AST for the model validator transform.
 *
 * Produces:
 *   for (let _i = 1; _i <= 20; _i++) {
 *     let _envKey = "ANTHROPIC_CUSTOM_MODEL_OPTION_" + _i;
 *     if (<modelVarName> === process.env[_envKey]) {
 *       return { valid: true };
 *     }
 *   }
 *
 * @param {string} modelVarName - dynamically discovered model identifier variable name
 */
function buildValidatorLoop(modelVarName) {
  return t.forStatement(
    // init: let _i = 1
    t.variableDeclaration("let", [
      t.variableDeclarator(t.identifier("_i"), t.numericLiteral(1)),
    ]),
    // test: _i <= 20
    t.binaryExpression("<=", t.identifier("_i"), t.numericLiteral(20)),
    // update: _i++
    t.updateExpression("++", t.identifier("_i"), false),
    // body
    t.blockStatement([
      // let _envKey = "ANTHROPIC_CUSTOM_MODEL_OPTION_" + _i;
      t.variableDeclaration("let", [
        t.variableDeclarator(
          t.identifier("_envKey"),
          t.binaryExpression(
            "+",
            t.stringLiteral("ANTHROPIC_CUSTOM_MODEL_OPTION_"),
            t.identifier("_i"),
          ),
        ),
      ]),
      // if (<modelVarName> === process.env[_envKey])
      t.ifStatement(
        t.binaryExpression(
          "===",
          t.identifier(modelVarName),
          t.memberExpression(
            t.memberExpression(
              t.identifier("process"),
              t.identifier("env"),
            ),
            t.identifier("_envKey"),
            true, // computed
          ),
        ),
        // then: return { valid: true }
        t.blockStatement([
          t.returnStatement(
            t.objectExpression([
              t.objectProperty(
                t.identifier("valid"),
                t.booleanLiteral(true),
              ),
            ]),
          ),
        ]),
      ),
    ]),
  );
}


// Matchers


/**
 * Check if a node is `process.env.SOME_NAME` (non-computed member expression chain).
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
 * Match the picker if-block.
 *
 * Pattern:
 *   let _ = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION;  // preceding sibling
 *   if (_ && !<pickerArrayName>.some(_A => _A.value === _)) {
 *     <pickerArrayName>.push({ value: _, label: ..., description: ... });
 *   }
 *
 * Returns { matched: true, pickerArrayName } or null.
 * Captures the picker array variable name dynamically from the .push() callee.
 */
function isPickerIfBlock(path) {
  const node = path.node;
  if (!t.isIfStatement(node)) return null;

  // Test must be: X && !Y.some(Z => Z.value === X)
  const test = node.test;
  if (!t.isLogicalExpression(test, { operator: "&&" })) return null;
  if (!t.isIdentifier(test.left)) return null;

  // Right must be unary ! with a .some() call
  if (!t.isUnaryExpression(test.right, { operator: "!" })) return null;
  const someCall = test.right.argument;
  if (!t.isCallExpression(someCall)) return null;
  if (!t.isMemberExpression(someCall.callee)) return null;
  if (!t.isIdentifier(someCall.callee.property, { name: "some" })) return null;

  // .some() callee object must be an identifier (name verified after pickerArrayName capture below)
  if (!t.isIdentifier(someCall.callee.object)) return null;

  // Consequent must contain <pickerArray>.push({value, label, description})
  // Capture the picker array name from the .push() callee object
  const conseq = node.consequent;
  if (!t.isBlockStatement(conseq) || conseq.body.length !== 1) return null;
  const stmt = conseq.body[0];
  if (!t.isExpressionStatement(stmt)) return null;
  if (!t.isCallExpression(stmt.expression)) return null;
  const call = stmt.expression;
  if (!t.isMemberExpression(call.callee)) return null;
  if (!t.isIdentifier(call.callee.property, { name: "push" })) return null;
  if (!t.isIdentifier(call.callee.object)) return null;
  const pickerArrayName = call.callee.object.name;

  // .some() must operate on the same array as .push()
  if (someCall.callee.object.name !== pickerArrayName) return null;

  // .some() callback must be: X => X.value === <test.left>
  if (someCall.arguments.length !== 1) return null;
  const someCallback = someCall.arguments[0];
  const testLeftName = test.left.name;
  let somePredicateValid = false;
  if (t.isArrowFunctionExpression(someCallback) && someCallback.params.length === 1) {
    const cbParam = someCallback.params[0];
    if (t.isIdentifier(cbParam)) {
      const cbBody = t.isBlockStatement(someCallback.body)
        ? someCallback.body.body
        : null;
      // Arrow with expression body: X => X.value === <testLeftName>
      if (!cbBody && t.isBinaryExpression(someCallback.body, { operator: "===" })) {
        const bin = someCallback.body;
        if (
          t.isMemberExpression(bin.left) && !bin.left.computed &&
          t.isIdentifier(bin.left.object, { name: cbParam.name }) &&
          t.isIdentifier(bin.left.property, { name: "value" }) &&
          t.isIdentifier(bin.right, { name: testLeftName })
        ) {
          somePredicateValid = true;
        }
      }
    }
  }
  if (!somePredicateValid) return null;

  if (call.arguments.length === 0) return null;
  if (!t.isObjectExpression(call.arguments[0])) return null;
  const props = call.arguments[0].properties;
  if (props.length !== 3) return null;
  const propNames = props
    .filter(p => t.isObjectProperty(p) && t.isIdentifier(p.key))
    .map(p => p.key.name);
  if (propNames.length !== 3) return null;
  if (!propNames.includes("value") || !propNames.includes("label") || !propNames.includes("description")) return null;

  // The pushed `value` property must reference test.left
  const valueProp = props.find(p => t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "value" }));
  if (!valueProp || !t.isIdentifier(valueProp.value, { name: testLeftName })) return null;

  // Walk backward through siblings for the env var declaration (not necessarily immediately preceding).
  // Minifiers may insert statements between the let-binding and the if-block.
  const parent = path.parent;
  if (!t.isBlockStatement(parent)) return null;
  const siblings = parent.body;
  const idx = siblings.indexOf(node);
  if (idx < 1) return null;
  let foundEnvDecl = false;
  for (let i = idx - 1; i >= 0; i--) {
    const s = siblings[i];
    if (!t.isVariableDeclaration(s) || s.declarations.length !== 1) continue;
    const decl = s.declarations[0];
    if (!t.isIdentifier(decl.id)) continue;
    if (decl.id.name !== testLeftName) continue;
    if (isProcessEnvDot(decl.init, "ANTHROPIC_CUSTOM_MODEL_OPTION")) {
      foundEnvDecl = true;
      break;
    }
  }
  if (!foundEnvDecl) return null;

  return { matched: true, pickerArrayName };
}

/**
 * Match the validator if-block.
 *
 * Pattern:
 *   if (<modelVarName> === process.env.ANTHROPIC_CUSTOM_MODEL_OPTION) {
 *     return { valid: true };
 *   }
 *
 * Returns { matched: true, modelVarName } or null.
 * Captures the model identifier variable name dynamically from the === left side.
 */
function isValidatorIfBlock(path) {
  const node = path.node;
  if (!t.isIfStatement(node)) return null;

  const test = node.test;
  if (!t.isBinaryExpression(test, { operator: "===" })) return null;
  if (!t.isIdentifier(test.left)) return null;
  const modelVarName = test.left.name;
  // Require exact pattern: <modelVarName> === process.env.ANTHROPIC_CUSTOM_MODEL_OPTION (non-computed)
  if (!isProcessEnvDot(test.right, "ANTHROPIC_CUSTOM_MODEL_OPTION")) return null;

  // Verify consequent returns { valid: true }
  const consequent = node.consequent;
  if (!t.isBlockStatement(consequent)) return null;
  if (consequent.body.length !== 1) return null;
  const ret = consequent.body[0];
  if (!t.isReturnStatement(ret)) return null;
  if (!t.isObjectExpression(ret.argument)) return null;
  if (ret.argument.properties.length !== 1) return null;
  const prop = ret.argument.properties[0];
  if (!t.isObjectProperty(prop) || prop.computed) return null;
  if (!t.isIdentifier(prop.key, { name: "valid" })) return null;
  if (!t.isBooleanLiteral(prop.value, { value: true })) return null;

  return { matched: true, modelVarName };
}


// Main transform


/**
 * Check if the next sibling statement is already our injected mod-guarded block.
 * Prevents double-application. Matches both the current form (if-wrapped for-loop)
 * and the legacy form (bare for-loop from before mod wrapping).
 */
function nextSiblingIsOurLoop(path) {
  const parent = path.parent;
  if (!t.isBlockStatement(parent)) return false;
  const siblings = parent.body;
  const idx = siblings.indexOf(path.node);
  if (idx < 0 || idx + 1 >= siblings.length) return false;
  const next = siblings[idx + 1];

  // Current form: if (typeof __isModEnabled__ ...) { for (...) { ... } }
  if (t.isIfStatement(next)) {
    const test = next.test;
    if (!t.isLogicalExpression(test, { operator: "&&" })) return false;
    if (!t.isBinaryExpression(test.left, { operator: "===" })) return false;
    // Check for typeof __isModEnabled__ === "function"
    if (!t.isUnaryExpression(test.left.left, { operator: "typeof" })) return false;
    if (!t.isIdentifier(test.left.left.argument, { name: "__isModEnabled__" })) return false;
    return true;
  }

  // Legacy form: bare for-loop (from before mod wrapping)
  if (!t.isForStatement(next)) return false;
  // Check init: let _i = 1
  if (!t.isVariableDeclaration(next.init)) return false;
  if (next.init.declarations.length === 0) return false;
  const decl = next.init.declarations[0];
  if (!t.isIdentifier(decl.id, { name: "_i" })) return false;
  if (!t.isNumericLiteral(decl.init, { value: 1 })) return false;
  return true;
}

function transform(ast) {
  let changed = 0;

  traverse(ast, {
    IfStatement(path) {
      const pickerResult = isPickerIfBlock(path);
      if (pickerResult && !nextSiblingIsOurLoop(path)) {
        // Wrap for-loop in mod guard: if (__isModEnabled__(...)) { for (...) { ... } }
        const pickerGuard = t.ifStatement(
          buildModGuard(),
          t.blockStatement([buildPickerLoop(pickerResult.pickerArrayName)])
        );
        path.insertAfter(pickerGuard);
        changed += 1;
      } else {
        const validatorResult = isValidatorIfBlock(path);
        if (validatorResult && !nextSiblingIsOurLoop(path)) {
          // Wrap for-loop in mod guard: if (__isModEnabled__(...)) { for (...) { ... } }
          const validatorGuard = t.ifStatement(
            buildModGuard(),
            t.blockStatement([buildValidatorLoop(validatorResult.modelVarName)])
          );
          path.insertAfter(validatorGuard);
          changed += 1;
        }
      }
    },
  });

  return changed;
}





function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-add-multi-custom-models.cjs <input.js> [output.js]");
    console.error("If output.js is omitted, writes to stdout.");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);

  // Validate input file exists
  if (!fs.existsSync(inputPath)) {
    console.error(`Error: Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const code = fs.readFileSync(inputPath, "utf8");

  let ast;
  try {
    ast = parser.parse(code, {
      sourceType: "unambiguous",
      plugins: [
        "jsx",
        "typescript",
      ],
    });
  } catch (err) {
    console.error(`Error: Failed to parse input file: ${err.message}`);
    process.exit(1);
  }

  const changedCount = transform(ast);

  if (changedCount === 0) {
    console.error("No matching custom model option patterns found; nothing changed.");
  } else {
    console.error(`Patched ${changedCount} custom model option location(s).`);
  }

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

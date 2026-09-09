#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

const MOD_ID = "display_model_name";

/**
 * Inject model badge into the KDK teammate row component.
 *
 * Strategy: find the createElement call for the daO subcomponent (identifiable
 * by its props: teammate, allIdle, pastTenseVerb, displayTime). Then find the
 * tool-use-count createElement immediately after it (contains "tool " and "uses"
 * string children). Insert a new model badge element between them.
 *
 * The injected element: H.model && createElement(N, { dimColor: true }, " · ", H.model)
 * — conditional rendering via logical AND, dimmed, with a middot separator.
 */
function transform(ast) {
  let changed = 0;

  // Step 1: Find KDK by its unique destructured prop set
  let kdkDestructurePath = null;
  let teammateAlias = null;
  let createElementVar = null;
  let textCompVar = null;

  traverse(ast, {
    FunctionDeclaration(funcPath) {
      if (kdkDestructurePath) return;

      const params = funcPath.node.params;
      if (params.length !== 1) return;
      const param = params[0];
      if (!t.isObjectPattern(param)) return;

      // Check for all six props: teammate, isLast, isSelected, isForegrounded, allIdle, showPreview
      const propNames = new Set();
      for (const prop of param.properties) {
        if (t.isObjectProperty(prop) && t.isIdentifier(prop.key)) {
          propNames.add(prop.key.name);
        }
      }

      const required = ["teammate", "isLast", "isSelected", "isForegrounded", "allIdle", "showPreview"];
      if (!required.every(name => propNames.has(name))) return;

      // Find the teammate alias (e.g., teammate: H)
      for (const prop of param.properties) {
        if (t.isObjectProperty(prop) && t.isIdentifier(prop.key, { name: "teammate" }) && t.isIdentifier(prop.value)) {
          teammateAlias = prop.value.name;
        }
      }

      if (!teammateAlias) return;

      // Idempotency: skip if already patched
      const funcCode = generate(funcPath.node).code;
      if (funcCode.includes('__isModEnabled__("display_model_name")') && funcCode.includes(`${teammateAlias}.model`)) return;

      kdkDestructurePath = funcPath;
      funcPath.stop();
    },
  });

  if (!kdkDestructurePath) return changed;

  // Step 2: Extract createElement and Text component names from the function body
  kdkDestructurePath.traverse({
    CallExpression(callPath) {
      if (createElementVar && textCompVar) return;

      const callee = callPath.node.callee;
      if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.property, { name: "createElement" })) return;
      if (!t.isIdentifier(callee.object)) return;

      if (!createElementVar) createElementVar = callee.object.name;

      // Find the Text component: used in dimColor elements
      for (let i = 0; i < callPath.node.arguments.length; i++) {
        const arg = callPath.node.arguments[i];
        if (!t.isIdentifier(arg)) continue;
        const nextArg = callPath.node.arguments[i + 1];
        if (!t.isObjectExpression(nextArg)) continue;

        const hasDimColor = nextArg.properties.some(p =>
          t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "dimColor" })
        );
        if (hasDimColor && !textCompVar) {
          textCompVar = arg.name;
          break;
        }
      }
    },
  });

  if (!createElementVar || !textCompVar) return changed;

  // Step 3: Find the daO createElement call and inject model badge after it
  kdkDestructurePath.traverse({
    CallExpression(callPath) {
      if (changed > 0) return;

      // Match: createElement(daO, { teammate, allIdle, pastTenseVerb, displayTime, ... })
      const callee = callPath.node.callee;
      if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.property, { name: "createElement" })) return;
      if (callPath.node.arguments.length < 2) return;

      const propsArg = callPath.node.arguments[1];
      if (!t.isObjectExpression(propsArg)) return;

      // Check for the unique daO prop set
      const hasTeammate = propsArg.properties.some(p =>
        t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "teammate" })
      );
      const hasPastTenseVerb = propsArg.properties.some(p =>
        t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "pastTenseVerb" })
      );
      const hasDisplayTime = propsArg.properties.some(p =>
        t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "displayTime" })
      );
      const hasActivityText = propsArg.properties.some(p =>
        t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "activityText" })
      );

      if (!hasTeammate || !hasPastTenseVerb || !hasDisplayTime || !hasActivityText) return;

      // This is the daO call. Find its parent createElement (the row Box).
      // The daO call is a child of the row Box createElement. We need to insert
      // our model element after it in the children array.
      const parentCall = callPath.parentPath;
      if (!t.isCallExpression(parentCall.node)) return;

      // Verify parent is a createElement call
      const parentCallee = parentCall.node.callee;
      if (!t.isMemberExpression(parentCallee) || !t.isIdentifier(parentCallee.property, { name: "createElement" })) return;

      // Find the index of the daO call in the parent's arguments
      const parentArgs = parentCall.node.arguments;
      let daoIdx = -1;
      for (let i = 0; i < parentArgs.length; i++) {
        if (parentArgs[i] === callPath.node) {
          daoIdx = i;
          break;
        }
      }

      if (daoIdx === -1) return;

      // Build the model badge element:
      // typeof __isModEnabled__ === "function" && __isModEnabled__("display_model_name")
      //   ? (H.model && createElement(N, { dimColor: true }, " · ", H.model))
      //   : undefined
      const modCheck = t.logicalExpression(
        "&&",
        t.binaryExpression(
          "===",
          t.unaryExpression("typeof", t.identifier("__isModEnabled__")),
          t.stringLiteral("function")
        ),
        t.callExpression(t.identifier("__isModEnabled__"), [t.stringLiteral(MOD_ID)])
      );

      const modelEl = t.conditionalExpression(
        modCheck,
        t.logicalExpression(
          "&&",
          t.memberExpression(t.identifier(teammateAlias), t.identifier("model")),
          t.callExpression(
            t.memberExpression(t.identifier(createElementVar), t.identifier("createElement")),
            [
              t.identifier(textCompVar),
              t.objectExpression([
                t.objectProperty(t.identifier("dimColor"), t.booleanLiteral(true)),
              ]),
              t.stringLiteral(" · "),
              t.memberExpression(t.identifier(teammateAlias), t.identifier("model")),
            ]
          )
        ),
        t.identifier("undefined")
      );

      // Insert after daO call
      parentArgs.splice(daoIdx + 1, 0, modelEl);
      changed++;
    },
  });

  return changed;
}

/** CLI wrapper */

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-teammate-list-show-model.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const ast = parser.parse(code, {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript"],
  });

  const n = transform(ast);

  if (n === 0) {
    console.error("No matching patterns found; nothing changed.");
  } else {
    console.error(`Injected model badge into ${n} teammate row component(s).`);
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

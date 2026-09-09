#!/usr/bin/env node
// Place helpers inside the CommonJS wrapper so its require binding is available.
// Cache configuration briefly to avoid filesystem reads on every runtime guard.

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

// The runtime helper to inject. Uses var (not const/let) for broad compat.
// 2-second TTL cache keeps toggles responsive without excessive file reads.
const HELPER_CODE = `
var __mods_cache__ = null;
var __mods_cache_time__ = 0;
function __modsLoad__() {
  var fs = __REQUIRE_FN__("fs");
  var path = __REQUIRE_FN__("path");
  var os = __REQUIRE_FN__("os");
  var now = Date.now();
  if (__mods_cache__ && (now - __mods_cache_time__) < 2000) {
    return __mods_cache__;
  }
  try {
    var configPath = path.join(
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
      "mods.json"
    );
    var data = JSON.parse(fs.readFileSync(configPath, "utf8"));
    __mods_cache__ = data;
    __mods_cache_time__ = now;
    return data;
  } catch (e) {
    __mods_cache__ = {};
    __mods_cache_time__ = now;
    return __mods_cache__;
  }
}
function __isModEnabled__(id) {
  return __modsLoad__()[id] === true;
}
function __getModConfig__(id, key, fallback) {
  var config = __modsLoad__();
  if (config[id] !== true) return undefined;
  var val = config[id + "_" + key];
  return val !== undefined ? val : fallback;
}
`;

/**
 * Inject into the CommonJS wrapper body, where require is available as a parameter.
 */
function getInjectionTarget(ast) {
  // CJS wrapper — (function(exports, require, module, __filename, __dirname) { ... })
  // Handles: bare FunctionExpression, IIFE CallExpression, unary-wrapped IIFEs.
  // Tolerates leading Directive nodes (e.g. "use strict").
  const firstExpr = ast.program.body.find(n =>
    t.isExpressionStatement(n) && !t.isDirective(n)
  );
  if (firstExpr) {
    let fnExpr = firstExpr.expression;
    // Unwrap: CallExpression.arguments[0] (IIFE), UnaryExpression.argument
    for (let i = 0; i < 3 && fnExpr && !t.isFunctionExpression(fnExpr); i++) {
      if (t.isCallExpression(fnExpr) && fnExpr.arguments.length > 0) {
        fnExpr = fnExpr.arguments[0];
      } else if (t.isUnaryExpression(fnExpr)) {
        fnExpr = fnExpr.argument;
      } else {
        break;
      }
    }
    if (t.isFunctionExpression(fnExpr)) {
      const hasRequireParam = fnExpr.params.some(param =>
        t.isIdentifier(param, { name: "require" })
      );
      if (hasRequireParam) {
        return { body: fnExpr.body.body, requireFnName: "require", insertIndex: 0 };
      }
    }
  }

  return null;
}

// Return codes for transform():
//   1  = injection performed
//   0  = idempotent skip (helpers already present)
//   -1 = no injection target found (bundle shape unsupported)
const RC_INJECTED = 1;
const RC_ALREADY_PRESENT = 0;
const RC_NO_TARGET = -1;

function transform(ast) {
  // Idempotency: if __modsLoad__ already exists, skip injection
  let alreadyPresent = false;
  traverse(ast, {
    FunctionDeclaration(fnPath) {
      if (t.isIdentifier(fnPath.node.id, { name: "__modsLoad__" })) {
        alreadyPresent = true;
      }
    },
  });
  if (alreadyPresent) return RC_ALREADY_PRESENT;

  const target = getInjectionTarget(ast);
  if (!target) {
    // No injection target found — no CJS wrapper parameter.
    // Return a distinct code so callers can distinguish "already present" from
    // "unsupported bundle shape" while still allowing the patch engine to continue.
    console.error("Warning: could not find injection target (no CJS wrapper); skipping mods runtime injection.");
    return RC_NO_TARGET;
  }

  // Substitute __REQUIRE_FN__ with the discovered require function variable
  const resolvedHelper = HELPER_CODE.replace(/__REQUIRE_FN__/g, target.requireFnName);

  // Parse the helper code into statements
  const helperAst = parser.parse(resolvedHelper, {
    sourceType: "script",
  });

  // Insert each statement at the correct position
  const helperStmts = helperAst.program.body;
  for (let i = helperStmts.length - 1; i >= 0; i--) {
    target.body.splice(target.insertIndex, 0, helperStmts[i]);
  }

  return RC_INJECTED;
}

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-inject-mods-runtime.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const ast = parser.parse(code, {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript"],
  });

  const changedCount = transform(ast);

  if (changedCount === RC_ALREADY_PRESENT) {
    console.error("Mods runtime helpers already present; skipping injection.");
  } else if (changedCount === RC_NO_TARGET) {
    // Warning already emitted by transform() — don't duplicate here.
    // Fall through to generate/write so the file is still produced.
  } else {
    console.error("Injected __isModEnabled__() and __getModConfig__() runtime helpers.");
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

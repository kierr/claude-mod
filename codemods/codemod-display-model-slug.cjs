#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");


// Constants


const MOD_ID = "display_model_slug";

// Model prefixes to match (what appears before " · " in the description)
const MODEL_PREFIXES = {
  sonnet: "Sonnet 4.6 · ",
  opus: "Opus 4.6 · ",
  opus47: "Opus 4.7 · ",
  opus48: "Opus 4.8 · ",
  haiku: "Haiku 4.5 · ",
};

// Slug argument for each model (passed to the resolver function or used as object key)
const MODEL_SLUG_ARGS = {
  sonnet: "sonnet",
  opus: "opus",
  opus47: "opus",
  opus48: "opus",
  haiku: "haiku",
};

// Short names that must exist in a slug map (all three required)
const REQUIRED_MODEL_KEYS = ["opus", "sonnet", "haiku"];


// Phase 1: Find slug resolver


/**
 * Try to find an object literal slug map: a variable whose value is an
 * ObjectExpression mapping short model names to "claude-*" API slugs.
 *
 * Example target:
 *   const eO7 = { opus: "claude-opus-4-6", sonnet: "claude-sonnet-4-6", haiku: "claude-haiku-4-5" };
 *
 * Returns { type: "object", name: "eO7" } or null.
 */
function findObjectLiteralSlugMap(ast) {
  let result = null;

  // Check an ObjectExpression for slug map properties
  function checkObjectExpression(objExpr, name) {
    const props = objExpr.properties;
    const slugEntries = {};
    for (const prop of props) {
      if (!t.isObjectProperty(prop)) continue;
      if (prop.computed) continue;
      if (!t.isIdentifier(prop.key) && !t.isStringLiteral(prop.key)) continue;

      const keyStr = t.isIdentifier(prop.key) ? prop.key.name : prop.key.value;
      if (!t.isStringLiteral(prop.value)) continue;

      if (/^claude-/.test(prop.value.value)) {
        slugEntries[keyStr] = prop.value.value;
      }
    }
    if (REQUIRED_MODEL_KEYS.every(k => k in slugEntries)) {
      return { type: "object", name };
    }
    return null;
  }

  // Strategy A: VariableDeclarator with inline ObjectExpression init
  // e.g. const eO7 = { opus: "claude-opus-4-6", sonnet: "claude-sonnet-4-6", haiku: "claude-haiku-4-5" };
  traverse(ast, {
    VariableDeclarator(varPath) {
      if (result) return;
      const node = varPath.node;
      if (!t.isIdentifier(node.id)) return;
      if (!t.isObjectExpression(node.init)) return;

      const match = checkObjectExpression(node.init, node.id.name);
      if (match) {
        // Accept top-level declarations and declarations inside a CommonJS wrapper.
        const scope = varPath.scope;
        const isProgramScope = scope.block.type === "Program";
        const isCJSWrapper = scope.block.type === "FunctionExpression" &&
          scope.parent && scope.parent.block.type === "Program";
        if (isProgramScope || isCJSWrapper) {
          result = match;
          varPath.stop();
        }
      }
    },
  });
  if (result) return result;

  // Strategy B: AssignmentExpression — var declared separately, assigned later
  // e.g. var vP8; ... Z(() => { vP8 = { opus: "claude-opus-4-7", ... }; });
  // The var declaration is at Program or CJS wrapper scope; the assignment happens
  // inside a lazy-init IIFE. We verify the binding exists at the correct scope level.
  traverse(ast, {
    AssignmentExpression(assignPath) {
      if (result) return;
      const node = assignPath.node;
      if (!t.isIdentifier(node.left)) return;
      if (!t.isObjectExpression(node.right)) return;

      const match = checkObjectExpression(node.right, node.left.name);
      if (match) {
        // Verify the variable is bound at Program or CJS wrapper scope.
        // getBinding() walks up scope chain; we accept if the binding's scope
        // is Program (ESM) or the CJS wrapper FunctionExpression.
        const binding = assignPath.scope.getBinding(node.left.name);
        if (binding) {
          const scopeType = binding.scope.block.type;
          const isProgramScope = scopeType === "Program";
          const isCJSWrapper = scopeType === "FunctionExpression" &&
            binding.scope.parent && binding.scope.parent.block.type === "Program";
          if (isProgramScope || isCJSWrapper) {
            result = match;
            assignPath.stop();
          }
        }
      }
    },
  });

  return result;
}

/**
 * Try to find a switch-in-function slug resolver: a function containing a
 * SwitchStatement with "opus", "sonnet", "haiku" cases whose return values
 * are strings matching /^claude-/ (not display descriptions like "Sonnet 4.6 · ...").
 *
 * This filters out description-returning functions (e.g., $5() which returns
 * "Sonnet 4.6 · Best for everyday tasks") that happen to have matching switch cases.
 *
 * Returns { type: "function", name: "resolverFunc" } or null.
 */
function findSwitchSlugResolver(ast) {
  let result = null;

  traverse(ast, {
    SwitchStatement(switchPath) {
      const caseValues = switchPath.node.cases
        .map(c => c.test)
        .filter(n => t.isStringLiteral(n))
        .map(n => n.value);

      const hasAll = REQUIRED_MODEL_KEYS.every(k => caseValues.includes(k));
      if (!hasAll) return;

      // Validate return values: must be claude-* slugs, not descriptions
      const cases = switchPath.node.cases;
      let allReturnSlugs = true;
      for (const c of cases) {
        for (const stmt of c.consequent) {
          if (t.isReturnStatement(stmt) && t.isStringLiteral(stmt.argument)) {
            const val = stmt.argument.value;
            // c.test is null for default: cases — skip those
            if (c.test && REQUIRED_MODEL_KEYS.includes(c.test.value) && !/^claude-/.test(val)) {
              allReturnSlugs = false;
              break;
            }
          }
        }
        if (!allReturnSlugs) break;
      }

      if (!allReturnSlugs) return;

      const funcPath = switchPath.getFunctionParent();
      if (funcPath && funcPath.node.id && t.isIdentifier(funcPath.node.id)) {
        // Accept top-level functions and functions inside a CommonJS wrapper.
        const parent = funcPath.parentPath;
        const isProgramScope = parent && parent.node.type === "Program";
        // CJS wrapper: slugResolver is nested inside (function(req,module,exports){...})
        // Its immediate parent is BlockStatement of the wrapper; the wrapper itself
        // is an ExpressionStatement at Program scope (or CallExpression for IIFE).
        const isCJSWrapper = parent && parent.node.type === "BlockStatement" &&
          parent.parentPath && t.isFunctionExpression(parent.parentPath.node) &&
          !parent.parentPath.node.id;
        if (isProgramScope || isCJSWrapper) {
          result = { type: "function", name: funcPath.node.id.name };
          switchPath.stop();
        }
      }
    },
  });

  return result;
}

/**
 * Find the slug resolver using the best available strategy.
 * Tries object literal first (newer versions), falls back to switch-in-function.
 */
function findSlugResolver(ast) {
  // Strategy 1: object-literal slug map.
  const objResult = findObjectLiteralSlugMap(ast);
  if (objResult) {
    console.error(`Found slug resolver object: ${objResult.name}`);
    return objResult;
  }

  // Strategy 2: Switch-in-function slug resolver (older versions)
  const funcResult = findSwitchSlugResolver(ast);
  if (funcResult) {
    console.error(`Found slug resolver function: ${funcResult.name}()`);
    return funcResult;
  }

  throw new Error(
    "Could not find slug resolver. Neither object literal map nor switch-in-function with 'opus', 'sonnet', 'haiku' claude-* cases found."
  );
}


// Phase 2: Transform descriptions


/**
 * Check if a node's parent is an ObjectProperty with key "description".
 */
function isDescriptionValue(path) {
  const parent = path.parent;
  if (!t.isObjectProperty(parent) || parent.computed) return false;
  if (!t.isIdentifier(parent.key)) return false;
  return parent.key.name === "description";
}

/**
 * Check if a string starts with one of our model prefixes.
 * Returns the model key or null.
 */
function getModelKey(text) {
  for (const [key, prefix] of Object.entries(MODEL_PREFIXES)) {
    if (text.startsWith(prefix)) {
      return key;
    }
  }
  return null;
}

/**
 * Build the slug expression based on resolver type, wrapped in mod guard:
 *   (typeof __isModEnabled__ === "function" && __isModEnabled__("display_model_slug")
 *     ? " (" + <rawSlug> + ")" : "")
 *
 * When mod is disabled, the expression evaluates to "" — original text is preserved.
 * When mod is enabled, " (" + slug + ")" is concatenated into the description.
 */
function buildSlugExpression(resolver, modelKey) {
  // Build the raw slug access (resolver-specific)
  // Use optional chaining for object resolvers: the slug map variable may be
  // initialized lazily (var vP8; ... Z(() => { vP8 = {...} })) and the
  // template literal referencing it may evaluate before the lazy init runs.
  let rawSlug;
  if (resolver.type === "object") {
    // resolver?.["sonnet"] ?? "" — the nullish coalescing prevents " (undefined)"
    // when the lazy slug map hasn't been initialized yet
    rawSlug = t.logicalExpression(
      "??",
      t.optionalMemberExpression(
        t.identifier(resolver.name),
        t.stringLiteral(MODEL_SLUG_ARGS[modelKey]),
        true, // computed
        true  // optional: resolver?.["sonnet"]
      ),
      t.stringLiteral("")
    );
  } else {
    // function type
    rawSlug = t.callExpression(t.identifier(resolver.name), [
      t.stringLiteral(MODEL_SLUG_ARGS[modelKey]),
    ]);
  }

  // typeof __isModEnabled__ === "function"
  const modGuard = t.logicalExpression(
    "&&",
    t.binaryExpression(
      "===",
      t.unaryExpression("typeof", t.identifier("__isModEnabled__")),
      t.stringLiteral("function")
    ),
    t.callExpression(t.identifier("__isModEnabled__"), [t.stringLiteral(MOD_ID)])
  );

  // " (" + rawSlug + ")"
  const slugWithParens = t.binaryExpression(
    "+",
    t.binaryExpression("+", t.stringLiteral(" ("), rawSlug),
    t.stringLiteral(")")
  );

  // modGuard ? slugWithParens : ""
  return t.conditionalExpression(modGuard, slugWithParens, t.stringLiteral(""));
}

/**
 * Transform a TemplateLiteral node.
 *
 * Structure transformation:
 *   `prefix · restText ${expr0} ... ${exprN} ${tail}`
 *   →
 *   `labelText${modGuardedSlug} · restText ${expr0} ... ${exprN} ${tail}`
 *
 * where modGuardedSlug = (typeof __isModEnabled__ ... ? " (" + slug + ")" : "")
 *
 * For N original expressions, we need N+2 quasis in the output:
 *   - quasis[0]: labelText (e.g. "Sonnet 4.6")
 *   - quasis[1]: " · " + restText
 *   - quasis[2..N+1]: original quasis[1..N]
 *   - expressions[0]: modGuardedSlug (conditional expression)
 *   - expressions[1..N+1]: original expressions
 */
function transformTemplateLiteral(path, resolver) {
  const node = path.node;
  if (node.quasis.length === 0) return false;

  const firstQuasi = node.quasis[0];
  const text = firstQuasi.value.cooked;

  const modelKey = getModelKey(text);
  if (!modelKey) return false;

  // Guard: replaceWith triggers re-visitation of the new node within the same
  // traversal. After transform the first quasi becomes "labelText" (without " · ")
  // which no longer starts with the prefix, so getModelKey returns null and we
  // skip. Also check for the pre-mod-wrapped form "labelText (" for cross-run
  // idempotency with older codemod output.
  const prefix = MODEL_PREFIXES[modelKey];
  const labelText = prefix.slice(0, -3); // drop trailing " · " to get model name
  if (text === labelText) return false; // already transformed (current form)
  if (text.startsWith(labelText + " (")) return false; // legacy form (pre-mod-wrap)
  const restText = text.slice(prefix.length);

  // Build the mod-guarded slug expression
  const slugExpr = buildSlugExpression(resolver, modelKey);

  // Build new quasis and expressions
  const newQuasis = [];
  const newExpressions = [];

  // First quasi: "ModelName" — mod-guarded slug inserted after this
  newQuasis.push(
    t.templateElement({ raw: labelText, cooked: labelText }, false)
  );

  // Second quasi: " · " + rest of first quasi
  newQuasis.push(
    t.templateElement({ raw: " · " + restText, cooked: " · " + restText }, false)
  );

  // Remaining quasis (1 to end): follow the expressions
  for (let i = 1; i < node.quasis.length; i++) {
    newQuasis.push(node.quasis[i]);
  }

  // New expressions: modGuardedSlug + all original expressions
  newExpressions.push(slugExpr);
  for (const expr of node.expressions) {
    newExpressions.push(expr);
  }

  path.replaceWith(t.templateLiteral(newQuasis, newExpressions));
  return true;
}

/**
 * Transform a StringLiteral node.
 * Converts to a TemplateLiteral containing the mod-guarded slug expression.
 *
 * Structure transformation:
 *   "prefix · rest"
 *   →
 *   `labelText${modGuardedSlug} · rest`
 *
 * where modGuardedSlug = (typeof __isModEnabled__ ... ? " (" + slug + ")" : "")
 */
function transformStringLiteral(path, resolver) {
  const node = path.node;
  const text = node.value;

  const modelKey = getModelKey(text);
  if (!modelKey) return false;

  const prefix = MODEL_PREFIXES[modelKey];
  const labelText = prefix.slice(0, -3); // drop trailing " · " to get model name
  const restText = text.slice(prefix.length);

  // Build the mod-guarded slug expression
  const slugExpr = buildSlugExpression(resolver, modelKey);

  // Convert to TemplateLiteral: `ModelName${modGuardedSlug} · rest`
  path.replaceWith(
    t.templateLiteral(
      [
        t.templateElement(
          { raw: labelText, cooked: labelText },
          false
        ),
        t.templateElement(
          { raw: " · " + restText, cooked: " · " + restText },
          true
        ),
      ],
      [slugExpr]
    )
  );
  return true;
}


// Already-applied detection


/**
 * Check if the codemod was already applied by scanning for the transformed
 * pattern in description template quasis.
 *
 * Current form (mod-wrapped): first quasi is just "Sonnet 4.6" (no " · ")
 *   `Sonnet 4.6${modGuard} · Best for...`
 *
 * Legacy form (pre-mod-wrap): first quasi has paren after name
 *   `Sonnet 4.6 (${slug}) · Best for...`
 *
 * Original (unpatched): first quasi starts with full prefix
 *   `Sonnet 4.6 · Best for...`
 *
 * Returns true if all three model prefixes appear in a transformed form.
 */
function isAlreadyApplied(ast) {
  const transformedPrefixes = new Set();

  traverse(ast, {
    TemplateLiteral(path) {
      if (!isDescriptionValue(path)) return;
      const firstQuasi = path.node.quasis[0];
      if (!firstQuasi) return;
      const text = firstQuasi.value.cooked;
      if (!text) return;

      for (const [key, prefix] of Object.entries(MODEL_PREFIXES)) {
        const labelText = prefix.slice(0, -3);
        // Current form: quasi is exactly the label text (e.g. "Sonnet 4.6")
        if (text === labelText) {
          transformedPrefixes.add(key);
        }
        // Legacy form: quasi starts with "Sonnet 4.6 ("
        if (text.startsWith(labelText + " (")) {
          transformedPrefixes.add(key);
        }
      }
    },
    StringLiteral(path) {
      if (!isDescriptionValue(path)) return;
      const text = path.node.value;

      for (const [key, prefix] of Object.entries(MODEL_PREFIXES)) {
        const labelText = prefix.slice(0, -3);
        if (text === labelText || text.startsWith(labelText + " (")) {
          transformedPrefixes.add(key);
        }
      }
    },
  });

  // Minimum 3 models (sonnet, opus, haiku always present; opus47 only in newer versions)
  return transformedPrefixes.size >= 3;
}


// Main transform


function transform(ast) {
  // Phase 1: Find slug resolver (tries object literal first, then switch)
  const resolver = findSlugResolver(ast);

  let changed = 0;
  const modelsFound = new Set();

  // Phase 2: Transform descriptions
  traverse(ast, {
    TemplateLiteral(path) {
      if (!isDescriptionValue(path)) return;

      const firstQuasi = path.node.quasis[0];
      if (!firstQuasi) return;
      const text = firstQuasi.value.cooked;
      const modelKey = getModelKey(text);
      if (!modelKey) return;

      if (transformTemplateLiteral(path, resolver)) {
        modelsFound.add(modelKey);
        changed += 1;
      }
    },
    StringLiteral(path) {
      if (!isDescriptionValue(path)) return;

      const text = path.node.value;
      const modelKey = getModelKey(text);
      if (!modelKey) return;

      if (transformStringLiteral(path, resolver)) {
        modelsFound.add(modelKey);
        changed += 1;
      }
    },
  });

  // Idempotency check: if no transformations occurred, check if already transformed
  // vs. genuinely missing models. Already-transformed code has quasis starting with
  // "ModelName (" which causes getModelKey() to return null, so no transformation occurs.
  if (modelsFound.size === 0) {
    if (isAlreadyApplied(ast)) {
      console.error("No model descriptions transformed — patch already applied (idempotent no-op).");
      return 0;
    }
    throw new Error(
      "No matching model descriptions found and patch does not appear already applied. " +
      "The target code structure may have changed."
    );
  }

  // Allow partial reruns when some model entries were already transformed.
  if (modelsFound.size < 3) {
    console.error(
      `Note: transformed ${modelsFound.size} model description(s) (expected >= 3). ` +
      `Models found: ${[...modelsFound].join(", ") || "none"}. ` +
      `Partial success — may indicate a rerun on partially-patched code.`
    );
  }

  return changed;
}





function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-display-model-slug.cjs <input.js> [output.js]");
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
      plugins: ["jsx", "typescript"],
    });
  } catch (err) {
    console.error(`Error: Failed to parse input file: ${err.message}`);
    process.exit(1);
  }

  const changedCount = transform(ast);

  if (changedCount === 0) {
    // transform() returns 0 only when already applied (idempotent no-op).
    // Genuine no-match now throws inside transform() — fail-closed behavior.
    console.error("Patch already applied — no changes needed (idempotent no-op).");
  } else {
    console.error(`Patched ${changedCount} model description(s).`);
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

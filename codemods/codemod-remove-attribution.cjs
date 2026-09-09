#!/usr/bin/env node
// Use AST matching for injection sites and string insertion for the large prompt prefix to avoid deep AST cloning.

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

const MOD_ID = "remove_attribution";

// The undercover prefix instruction text, injected via regex post-processing
// to avoid Babel cloneNode stack overflow on deeply nested template literals.
// PLACEHOLDER is replaced with the actual text in Phase 2.
const UNDERCOVER_PREFIX = `# UNDERCOVER MODE ACTIVE

You are in **undercover mode**. Do NOT reveal:
- Your model name, codename, or version (e.g. "claude-opus-4-6", "Sonnet")
- Anthropic-internal identifiers, repo names, or URLs (e.g. "anthropics/claude-code")
- That output was AI-generated or AI-assisted

In git commits: omit all Co-Authored-By lines. Use only the human author.
In PR descriptions: omit all "Generated with Claude Code" attribution and reviewer flags.
In code comments: do not mention Claude, Anthropic, or AI assistance.
If asked about your identity: respond as a generic coding assistant.

`;

// Regex-safe version of the prefix for Phase 2 injection.
// JSON.stringify handles all JS string literal escaping (backslashes, quotes,
// newlines, control chars) — more robust than manual replace chains.
const UNDERCOVER_PREFIX_ESCAPED = JSON.stringify(UNDERCOVER_PREFIX).slice(1, -1);

// Unique markers injected by Phase 1 AST transforms, replaced by Phase 2 regex.
const PREFIX_MARKER_COMMIT = "__UNDERCOVER_PREFIX_COMMIT__";
const PREFIX_MARKER_PUSH = "__UNDERCOVER_PREFIX_PUSH__";

// Helpers

/**
 * Build a mod guard condition:
 *   typeof __isModEnabled__ === "function" && __isModEnabled__("remove_attribution")
 */
function buildModCondition() {
  return t.logicalExpression(
    "&&",
    t.binaryExpression(
      "===",
      t.unaryExpression("typeof", t.identifier("__isModEnabled__")),
      t.stringLiteral("function")
    ),
    t.callExpression(
      t.identifier("__isModEnabled__"),
      [t.stringLiteral(MOD_ID)]
    )
  );
}

// functionContainsString removed — replaced by nodeContainsString(fnPath.node, ...) below

/**
 * Check if a function already has our mod guard (idempotency check).
 */
function isAlreadyPatched(fnPath) {
  let patched = false;
  fnPath.traverse({
    CallExpression(callPath) {
      if (
        t.isIdentifier(callPath.node.callee, { name: "__isModEnabled__" }) &&
        callPath.node.arguments.length >= 1 &&
        t.isStringLiteral(callPath.node.arguments[0], { value: MOD_ID })
      ) {
        patched = true;
      }
    },
  });
  return patched;
}

/**
 * Check if T3's specific mutation is already present: an if-statement
 * with __isModEnabled__("remove_attribution") guard that returns empty
 * attribution object, inserted after the first if-statement.
 *
 * Unlike isAlreadyPatched (which matches any __isModEnabled__ call),
 * this only detects T3's own pattern so T6 can run first without
 * blocking T3 from also targeting the same function.
 */
function isT3AlreadyPatched(fnPath) {
  const body = fnPath.node.body;
  if (!t.isBlockStatement(body) || body.body.length < 2) return false;

  // Find the first if-statement
  let firstIfIdx = -1;
  for (let i = 0; i < body.body.length; i++) {
    if (t.isIfStatement(body.body[i])) {
      firstIfIdx = i;
      break;
    }
  }
  if (firstIfIdx === -1 || firstIfIdx + 1 >= body.body.length) return false;

  // Check if the statement right after the first if is T3's guard
  const nextStmt = body.body[firstIfIdx + 1];
  if (!t.isIfStatement(nextStmt)) return false;

  // Test must be the buildModCondition() pattern:
  //   typeof __isModEnabled__ === "function" && __isModEnabled__("remove_attribution")
  // which is a LogicalExpression(&&), or in rare cases just the CallExpression.
  const isModCall = (node) =>
    t.isCallExpression(node) &&
    t.isIdentifier(node.callee, { name: "__isModEnabled__" }) &&
    node.arguments.length >= 1 &&
    t.isStringLiteral(node.arguments[0], { value: MOD_ID });

  let testIsModCall = false;
  if (isModCall(nextStmt.test)) {
    testIsModCall = true;
  } else if (
    t.isLogicalExpression(nextStmt.test, { operator: "&&" }) &&
    isModCall(nextStmt.test.right)
  ) {
    testIsModCall = true;
  }
  if (!testIsModCall) return false;

  // Consequent must be a block returning { commit: "", pr: "" }
  if (!t.isBlockStatement(nextStmt.consequent)) return false;
  const stmts = nextStmt.consequent.body;
  if (stmts.length !== 1 || !t.isReturnStatement(stmts[0])) return false;
  const retArg = stmts[0].argument;
  if (!t.isObjectExpression(retArg)) return false;

  const hasEmptyCommit = retArg.properties.some(p =>
    t.isObjectProperty(p) &&
    ((t.isIdentifier(p.key) && p.key.name === "commit") ||
     (t.isStringLiteral(p.key) && p.key.value === "commit")) &&
    t.isStringLiteral(p.value, { value: "" })
  );
  const hasEmptyPR = retArg.properties.some(p =>
    t.isObjectProperty(p) &&
    ((t.isIdentifier(p.key) && p.key.name === "pr") ||
     (t.isStringLiteral(p.key) && p.key.value === "pr")) &&
    t.isStringLiteral(p.value, { value: "" })
  );

  return hasEmptyCommit && hasEmptyPR;
}

/**
 * Build a Set of all string values in an AST node (StringLiteral values and
 * TemplateElement cooked/raw strings). Single O(n) traversal replaces repeated
 * nodeContainsString() calls which each did their own O(n) traversal.
 */
function collectStringsInNode(node) {
  const strings = new Set();
  if (t.isStringLiteral(node)) strings.add(node.value);
  if (t.isTemplateElement(node)) {
    const v = node.value;
    if (v && v.cooked) strings.add(v.cooked);
    if (v && v.raw) strings.add(v.raw);
  }
  // noScope is required because we traverse detached AST nodes (e.g. decl.init,
  // stmts[nextIdx]) that lack a parent Program/File scope. Without it, Babel
  // throws "You must pass a scope and parentPath unless traversing a Program.";
  // we don't use scope bindings here, so disabling is safe.
  traverse(node, { noScope: true,
    StringLiteral(p) { strings.add(p.node.value); },
    TemplateElement(p) {
      const v = p.node.value;
      if (v && v.cooked) strings.add(v.cooked);
      if (v && v.raw) strings.add(v.raw);
    },
  });
  return strings;
}

/**
 * Check if any string in the pre-built index contains the search string as a
 * substring. Equivalent to nodeContainsString(node, X) for fnPath.node-level
 * checks but operates on the collected string Set instead of re-traversing AST.
 * ~100 strings in a Set vs ~thousands of AST nodes — much faster.
 */
function stringsContains(strings, searchString) {
  for (const s of strings) {
    if (s.includes(searchString)) return true;
  }
  return false;
}

/**
 * Check if any descendant of an AST node contains a specific string
 * in either a StringLiteral value or a TemplateElement (cooked/raw).
 * Used for sub-node checks (stmts[i], decl.init) where the subtree is small.
 * For full-function checks, use the pre-built string index instead.
 */
function nodeContainsString(node, searchString) {
  if (t.isStringLiteral(node) && node.value.includes(searchString)) return true;
  if (t.isTemplateElement(node)) {
    const v = node.value;
    if ((v && v.cooked && v.cooked.includes(searchString)) ||
        (v && v.raw && v.raw.includes(searchString))) return true;
  }

  let found = false;
  traverse(node, { noScope: true, StringLiteral(p) {
      if (p.node.value.includes(searchString)) found = true;
    },
    TemplateElement(p) {
      const v = p.node.value;
      if ((v && v.cooked && v.cooked.includes(searchString)) ||
          (v && v.raw && v.raw.includes(searchString))) found = true;
    },
  });
  return found;
}

/**
 * Find a VariableDeclaration in a function body where any declarator is
 * initialized with a specific literal value (string "" or null).
 * Returns { varName, stmtIndex, stmtPath } or null.
 *
 * Iterates all declarators in each statement (not just [0]) so that
 * multi-declarator forms like `let A = 1, Y = "";` are handled correctly.
 */
function findVarInit(fnBodyStmts, fnBodyPaths, initValue) {
  for (let i = 0; i < fnBodyStmts.length; i++) {
    const stmt = fnBodyStmts[i];
    if (!t.isVariableDeclaration(stmt)) continue;

    for (const decl of stmt.declarations) {
      if (!t.isIdentifier(decl.id)) continue;

      if (initValue === "" && t.isStringLiteral(decl.init, { value: "" })) {
        return { varName: decl.id.name, stmtIndex: i, stmtPath: fnBodyPaths[i] };
      }
      if (initValue === null && t.isNullLiteral(decl.init)) {
        return { varName: decl.id.name, stmtIndex: i, stmtPath: fnBodyPaths[i] };
      }
    }
  }
  return null;
}

// Match 1: computeEnvInfo (Y initialized to "")

/**
 * Single-function matcher for Transform 1.
 * Returns 1 if patched, 0 if skipped.
 */
function matchComputeEnvInfo(fnPath, strings) {
  if (isAlreadyPatched(fnPath)) return 0;

  // Must contain "You are powered by the model"
  if (!stringsContains(strings, "You are powered by the model")) return 0;

  const body = fnPath.node.body;
  if (!t.isBlockStatement(body)) return 0;

  const stmts = body.body;
  const bodyPaths = fnPath.get("body").get("body");

  // Find variable initialized to ""
  const varInfo = findVarInit(stmts, bodyPaths, "");
  if (!varInfo) return 0;

  // Find the later statement containing the target string; intervening statements are allowed.
  let targetStmtIdx = -1;
  for (let i = varInfo.stmtIndex + 1; i < stmts.length; i++) {
    if (nodeContainsString(stmts[i], "You are powered by the model")) {
      targetStmtIdx = i;
      break;
    }
  }
  if (targetStmtIdx === -1) return 0;

  // Insert after the statement: if (__isModEnabled__(...)) { Y = ""; }
  const guard = t.ifStatement(
    buildModCondition(),
    t.blockStatement([
      t.expressionStatement(
        t.assignmentExpression(
          "=",
          t.identifier(varInfo.varName),
          t.stringLiteral("")
        )
      ),
    ])
  );

  bodyPaths[targetStmtIdx].insertAfter(guard);
  return 1;
}

// Match 2: computeSimpleEnvInfo (Y initialized to null)

/**
 * Single-function matcher for Transform 2. Same as Match 1 but init null.
 * Returns 1 if patched, 0 if skipped.
 */
function matchComputeSimpleEnvInfo(fnPath, strings) {
  if (isAlreadyPatched(fnPath)) return 0;

  // Must contain "You are powered by the model"
  if (!stringsContains(strings, "You are powered by the model")) return 0;

  const body = fnPath.node.body;
  if (!t.isBlockStatement(body)) return 0;

  const stmts = body.body;
  const bodyPaths = fnPath.get("body").get("body");

  // Find variable initialized to null
  const varInfo = findVarInit(stmts, bodyPaths, null);
  if (!varInfo) return 0;

  // Find the later statement containing the target string; intervening statements are allowed.
  let targetStmtIdx = -1;
  for (let i = varInfo.stmtIndex + 1; i < stmts.length; i++) {
    if (nodeContainsString(stmts[i], "You are powered by the model")) {
      targetStmtIdx = i;
      break;
    }
  }
  if (targetStmtIdx === -1) return 0;

  // Insert: if (__isModEnabled__(...)) { Y = ""; }
  const guard = t.ifStatement(
    buildModCondition(),
    t.blockStatement([
      t.expressionStatement(
        t.assignmentExpression(
          "=",
          t.identifier(varInfo.varName),
          t.stringLiteral("")
        )
      ),
    ])
  );

  bodyPaths[targetStmtIdx].insertAfter(guard);
  return 1;
}

// Match 3: getAttributionTexts (noreply@anthropic.com)

/**
 * Single-function matcher for Transform 3.
 * Returns 1 if patched, 0 if skipped.
 */
function matchGetAttributionTexts(fnPath, strings) {
  // Must contain "noreply@anthropic.com"
  if (!stringsContains(strings, "noreply@anthropic.com")) return 0;

  // This function may already contain another attribution injection. Detect this
  // transform's own mutation rather than treating any mod guard as an idempotency marker.
  const isT6Target = stringsContains(strings, "Co-Authored-By");
  if (isT6Target ? isT3AlreadyPatched(fnPath) : isAlreadyPatched(fnPath)) return 0;

  const body = fnPath.node.body;
  if (!t.isBlockStatement(body)) return 0;
  if (body.body.length < 1) return 0;

  // Find the first if-statement (remote session check)
  const bodyPaths = fnPath.get("body").get("body");
  let firstIfIdx = -1;
  for (let i = 0; i < body.body.length; i++) {
    if (t.isIfStatement(body.body[i])) {
      firstIfIdx = i;
      break;
    }
  }
  if (firstIfIdx === -1) return 0;

  // Insert after the first if-statement:
  // if (typeof __isModEnabled__ === "function" && __isModEnabled__("remove_attribution")) { return { commit: "", pr: "" }; }
  const guard = t.ifStatement(
    buildModCondition(),
    t.blockStatement([
      t.returnStatement(
        t.objectExpression([
          t.objectProperty(t.identifier("commit"), t.stringLiteral("")),
          t.objectProperty(t.identifier("pr"), t.stringLiteral("")),
        ])
      ),
    ])
  );

  bodyPaths[firstIfIdx].insertAfter(guard);
  return 1;
}

// Match 4: Enhanced PR attribution (-shotted by)

/**
 * Single-function matcher for Transform 4.
 * Returns 1 if patched, 0 if skipped.
 */
function matchEnhancedPRAttribution(fnPath, strings) {
  if (isAlreadyPatched(fnPath)) return 0;

  // Must contain "-shotted by"
  if (!stringsContains(strings, "-shotted by")) return 0;

  const body = fnPath.node.body;
  if (!t.isBlockStatement(body)) return 0;
  if (body.body.length < 1) return 0;

  // Insert at function entry:
  // if (typeof __isModEnabled__ === "function" && __isModEnabled__("remove_attribution")) return "";
  const guard = t.ifStatement(
    buildModCondition(),
    t.blockStatement([
      t.returnStatement(t.stringLiteral("")),
    ])
  );

  const bodyPaths = fnPath.get("body").get("body");
  bodyPaths[0].insertBefore(guard);
  return 1;
}

// Match 5: /commit prompt (Committing changes with git)

/**
 * Single-function matcher for Transform 5.
 * Returns 1 if patched, 0 if skipped.
 */
function matchCommitPrompt(fnPath, strings) {
  if (isAlreadyPatched(fnPath)) return 0;

  // Must contain "Committing changes with git"
  if (!stringsContains(strings, "Committing changes with git")) return 0;

  const body = fnPath.node.body;
  if (!t.isBlockStatement(body)) return 0;

  // Find the first return statement containing the "Committing changes" text.
  // Scoped traverse within this function only — not a full-AST walk.
  let targetReturnPath = null;
  fnPath.traverse({
    ReturnStatement(retPath) {
      if (!targetReturnPath && nodeContainsString(retPath.node, "Committing changes with git")) {
        targetReturnPath = retPath;
      }
    },
  });

  if (!targetReturnPath) return 0;

  // Build: let __uc_result = <return-value>;
  // if (typeof __isModEnabled__ === "function" && __isModEnabled__("remove_attribution")) {
  //   __uc_result = "__UNDERCOVER_PREFIX_COMMIT__" + __uc_result;
  // }
  // return __uc_result;
  const resultId = t.identifier("__uc_result");

  const varDecl = t.variableDeclaration("let", [
    t.variableDeclarator(resultId, targetReturnPath.node.argument),
  ]);

  const prefixConcat = t.assignmentExpression(
    "=",
    t.identifier("__uc_result"),
    t.binaryExpression(
      "+",
      t.stringLiteral(PREFIX_MARKER_COMMIT),
      t.identifier("__uc_result")
    )
  );

  const guard = t.ifStatement(
    buildModCondition(),
    t.blockStatement([
      t.expressionStatement(prefixConcat),
    ])
  );

  const newReturn = t.returnStatement(t.identifier("__uc_result"));

  // Replace the return statement with: varDecl, guard, newReturn
  targetReturnPath.replaceWithMultiple([varDecl, guard, newReturn]);
  return 1;
}

// Match 6: commit-push-pr prompt (anthropics/claude-code)

/**
 * Single-function matcher for Transform 6.
 * Two-part match (atomic — both parts must match for any mutation):
 *   Part A: After the target variable declarations, insert a guard that
 *     nullifies reviewer/add-reviewer strings when undercover is enabled.
 *   Part B: Find the return statement and wrap it to prepend the
 *     UNDERCOVER_PREFIX (via marker, replaced in Phase 2 regex).
 * Gathers all info first, then applies mutations — prevents half-transforms.
 *
 * Returns 1 if patched, 0 if skipped.
 */
function matchCommitPushPRPrompt(fnPath, strings) {
  if (isAlreadyPatched(fnPath)) return 0;

  // Must contain "anthropics/claude-code" OR "Co-Authored-By" — primary anchor.
  const hasAnchor = stringsContains(strings, "anthropics/claude-code") ||
                     stringsContains(strings, "Co-Authored-By");
  if (!hasAnchor) return 0;

  // Discriminator: must contain "Co-Authored-By" OR "--reviewer" to distinguish
  // the commit-push-pr prompt from other functions referencing "anthropics/claude-code"
  const hasCoAuthoredBy = stringsContains(strings, "Co-Authored-By");
  const hasReviewer = stringsContains(strings, "--reviewer");
  if (!hasCoAuthoredBy && !hasReviewer) return 0;

  const body = fnPath.node.body;
  if (!t.isBlockStatement(body)) return 0;
  if (body.body.length < 1) return 0;

  const bodyPaths = fnPath.get("body").get("body");
  const stmts = body.body;

  // ── Phase 1: Gather all information before mutating (atomicity) ──
  const nullifyVars = [];

  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];
    if (!t.isVariableDeclaration(stmt)) continue;

    for (const decl of stmt.declarations) {
      if (!t.isIdentifier(decl.id)) continue;
      if (!decl.init) continue;

      const hasAnthropics = nodeContainsString(decl.init, "anthropics/claude-code");
      const hasReviewerInit = nodeContainsString(decl.init, "--reviewer");
      const hasAddReviewerInit = nodeContainsString(decl.init, "--add-reviewer");

      if (hasAnthropics || hasReviewerInit || hasAddReviewerInit) {
        nullifyVars.push(decl.id.name);
      }
    }
  }

  const hasVarDecl = stmts.some(t.isVariableDeclaration);
  const hasDiscriminator = nullifyVars.length > 0 || (hasCoAuthoredBy && hasVarDecl);
  if (!hasDiscriminator) return 0;

  let targetReturnPath = null;
  let lastReturnIdx = -1;
  for (let i = stmts.length - 1; i >= 0; i--) {
    if (t.isReturnStatement(stmts[i]) && stmts[i].argument) {
      targetReturnPath = bodyPaths[i];
      lastReturnIdx = i;
      break;
    }
  }

  if (!targetReturnPath) return 0;

  // ── Phase 2: Apply all mutations atomically ──

  // Part A: Insert nullify guard for all collected variables
  {
    const guardBody = nullifyVars.map(varName =>
      t.expressionStatement(
        t.assignmentExpression(
          "=",
          t.identifier(varName),
          t.stringLiteral("")
        )
      )
    );

    const nullifyGuard = t.ifStatement(
      buildModCondition(),
      t.blockStatement(guardBody)
    );

    let lastTargetDeclIdx = 0;
    for (let i = 0; i < stmts.length; i++) {
      const stmt = stmts[i];
      if (!t.isVariableDeclaration(stmt)) continue;

      if (nodeContainsString(stmt, "anthropics/claude-code") ||
          nodeContainsString(stmt, "--reviewer") ||
          nodeContainsString(stmt, "--add-reviewer")) {
        lastTargetDeclIdx = i;
      }
    }

    bodyPaths[lastTargetDeclIdx].insertAfter(nullifyGuard);
  }

  // Part B: Wrap the return statement to prepend UNDERCOVER_PREFIX
  const resultId = t.identifier("__uc_pr_result");

  const varDecl = t.variableDeclaration("let", [
    t.variableDeclarator(resultId, targetReturnPath.node.argument),
  ]);

  const prefixConcat = t.assignmentExpression(
    "=",
    t.identifier("__uc_pr_result"),
    t.binaryExpression(
      "+",
      t.stringLiteral(PREFIX_MARKER_PUSH),
      t.identifier("__uc_pr_result")
    )
  );

  const guard = t.ifStatement(
    buildModCondition(),
    t.blockStatement([t.expressionStatement(prefixConcat)])
  );

  const newReturn = t.returnStatement(t.identifier("__uc_pr_result"));

  targetReturnPath.replaceWithMultiple([varDecl, guard, newReturn]);
  return 1;
}

// Phase 2: Regex Post-Processing

/**
 * Replace marker strings with the actual UNDERCOVER_PREFIX text.
 * This avoids Babel cloneNode stack overflow on deeply nested template literals.
 * Warns if a marker wasn't found — indicates Babel output format changed.
 */
function postProcessWithPrefix(code) {
  let output = code;

  // Replace both markers with the escaped prefix text
  const commitRe = new RegExp(`"${escapeRegex(PREFIX_MARKER_COMMIT)}"`, "g");
  const pushRe = new RegExp(`"${escapeRegex(PREFIX_MARKER_PUSH)}"`, "g");

  const commitMatches = (output.match(commitRe) || []).length;
  output = output.replace(commitRe, `"${UNDERCOVER_PREFIX_ESCAPED}"`);

  const pushMatches = (output.match(pushRe) || []).length;
  output = output.replace(pushRe, `"${UNDERCOVER_PREFIX_ESCAPED}"`);

  // Verify markers were found — silent failure means Babel output format changed
  if (commitMatches === 0) {
    console.error(`Warning: COMMIT marker not found in generated code. Phase 2 prefix injection skipped for Transform 5.`);
  }
  if (pushMatches === 0) {
    console.error(`Warning: PUSH marker not found in generated code. Phase 2 prefix injection skipped for Transform 6.`);
  }

  return output;
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Main Transform Orchestrator

/**
 * Apply all 6 transforms in a single AST traversal.
 *
 * Each FunctionDeclaration is visited once. All 6 matchers run against it
 * in the visitor body, preserving the T6-before-T3 ordering constraint
 * (T6 target contains "noreply@anthropic.com" which T3 also matches).
 *
 * This replaces 6 separate full-AST traversals with 1, cutting the
 * traversal cost by ~6x for this codemod.
 */
function transform(ast) {
  let t1 = 0, t2 = 0, t3 = 0, t4 = 0, t5 = 0, t6 = 0;

  traverse(ast, {
    FunctionDeclaration(fnPath) {
      // Pre-build string index for this function — single O(n) traversal
      // replaces ~9 separate O(n) nodeContainsString(fnPath.node, ...) calls.
      const strings = collectStringsInNode(fnPath.node);

      // T4 first: simple early-return, no ordering dependencies
      t4 += matchEnhancedPRAttribution(fnPath, strings);
      // T6 before T3: T6 target contains "noreply@anthropic.com" which T3 also matches.
      // If T3 runs first, it injects __isModEnabled__("remove_attribution") into the target,
      // causing T6's isAlreadyPatched guard to skip it.
      t6 += matchCommitPushPRPrompt(fnPath, strings);
      t3 += matchGetAttributionTexts(fnPath, strings);
      // T1 and T2 target different functions (init "" vs null) but share the
      // same anchor string "You are powered by the model". isAlreadyPatched
      // ensures each function is patched at most once.
      t1 += matchComputeEnvInfo(fnPath, strings);
      t2 += matchComputeSimpleEnvInfo(fnPath, strings);
      // T5 has a scoped fnPath.traverse() for return-statement search —
      // not a full-AST walk, so it's cheap.
      t5 += matchCommitPrompt(fnPath, strings);
    },
  });

  const total = t1 + t2 + t3 + t4 + t5 + t6;

  if (total !== 6) {
    throw new Error(
      `Undercover mode: expected 6 transforms, got ${total} (T1=${t1} T2=${t2} T3=${t3} T4=${t4} T5=${t5} T6=${t6}). ` +
      `The target code structure may have changed.`
    );
  }

  return total;
}

// CLI Entry Point

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-remove-attribution.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  // Phase 1: Babel AST transforms
  const ast = parser.parse(code, {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript"],
  });

  const patchedCount = transform(ast);
  console.error(`Applied ${patchedCount} undercover mode transforms (AST phase).`);

  // Generate code from modified AST
  let output = generate(ast, { retainLines: false }, code).code;

  // Phase 2: Regex post-processing — inject UNDERCOVER_PREFIX text
  output = postProcessWithPrefix(output);
  console.error("Injected UNDERCOVER_PREFIX text (regex phase).");

  if (outputFile) {
    fs.writeFileSync(path.resolve(outputFile), output, "utf8");
  } else {
    process.stdout.write(output);
  }
}

module.exports = { transform, postProcess: postProcessWithPrefix };

if (require.main === module) {
  main();
}

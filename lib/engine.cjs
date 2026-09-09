/**
 * Apply the ordered patch set and verify in memory before writing.
 * Failures leave the input unchanged; callers handle CLI output and exits.
 */

const fs = require("fs");
const path = require("path");
const { parseYAML, patternExistsIn, countMatchesIn } = require("./utils.cjs");

const CODEMODS_DIR = path.join(__dirname, "..", "codemods");
const PATCHES_DIR = path.join(__dirname, "..", "patches");

// Protect $1–$9 replacement backreferences across parsing and generation.
// Restore the original strings before verification and writing.
const CODEGEN_SENTINEL = "__BabelDollar__";
const CODEGEN_BUGGY_PATTERN = /(\.replace\(\w+,\s*")\$(\d)("\))/g;

// Babel imports — resolve via codemods/ workspace first, fall back to plain require.
// Bun workspaces may install into codemods/node_modules/ (symlinks) or hoist to root
// node_modules/ depending on the Bun version and install context (CI vs local).
function babelRequire(pkg) {
  const codemodsPath = path.join(CODEMODS_DIR, "node_modules", "@babel", pkg);
  try { return require(codemodsPath); } catch { return require("@babel/" + pkg); }
}
const parser = babelRequire("parser");
const generate = babelRequire("generator").default;

/**
 * Load by YAML filename stem, which can differ from the mod ID, and resolve the codemod.
 * @param {string} name - YAML filename without extension
 * @param {string} patchesDir - definitions directory
 * @param {string} codemodsDir - transforms directory
 * @returns {object} Resolved metadata or loading error
 */
function loadPatch(name, patchesDir, codemodsDir) {
  const yamlPath = path.join(patchesDir, `${name}.yaml`);
  if (!fs.existsSync(yamlPath)) {
    return {
      id: name,
      order: 50,
      engine: "babel",
      statusTests: {},
      codemod: { transform: () => {} },
      error: new Error(`Patch not found: ${name}`),
    };
  }

  const patch = parseYAML(fs.readFileSync(yamlPath, "utf8"));

  if (!patch.codemod || !patch.codemod.script) {
    return {
      id: name,
      order: patch.order != null ? Number(patch.order) : 50,
      engine: patch.codemod ? (patch.codemod.engine || "babel") : "babel",
      statusTests: patch.status_tests || {},
      codemod: { transform: () => {} },
      error: new Error(`No codemod script defined in patch: ${name}`),
    };
  }

  const engine = patch.codemod.engine || "babel";
  // Script paths in YAML are relative to project root (e.g. "codemods/codemod-foo.cjs").
  // Resolve relative to the parent of codemodsDir (which IS the project root).
  const projectRoot = path.dirname(codemodsDir);
  const scriptPath = path.join(projectRoot, patch.codemod.script);
  if (!fs.existsSync(scriptPath)) {
    return {
      id: name,
      order: patch.order != null ? Number(patch.order) : 50,
      engine,
      statusTests: patch.status_tests || {},
      codemod: { transform: () => {} },
      error: new Error(`Codemod script not found: ${scriptPath}`),
    };
  }

  const codemod = require(scriptPath);

  return {
    id: name,
    order: patch.order != null ? Number(patch.order) : 50,
    engine,
    statusTests: patch.status_tests || {},
    codemod,
    error: null,
  };
}

/**
 * Apply an ordered set of patches to a file.
 *
 * @param {object} options
 * @param {string} options.filePath - Absolute path to the deobfuscated file
 * @param {string[]} options.patchNames - Ordered list of patch IDs to apply
 * @param {boolean} [options.verbose=false] - Log progress to stderr
 * @param {boolean} [options.dryRun=false] - Classify only, don't write
 * @param {string} [options.patchesDir] - Override patches directory (for tests)
 * @param {string} [options.codemodsDir] - Override codemods directory (for tests)
 * @returns {object} Result with structure:
 *   {
 *     applied: number,        // patches that verified successfully
 *     skipped: number,        // already-applied + not-applicable
 *     failed: number,         // patches that errored or failed verification
 *     patches: {              // per-patch details keyed by patch ID
 *       [id]: {
 *         status: "applied" | "already_applied" | "not_applicable" | "error" | "verification_failed",
 *         matches?: number,   // count of applied pattern matches (for applied/already_applied)
 *         error?: Error,      // for error/verification_failed status
 *         skip?: string,      // reason for skip ("already_applied" | "not_applicable")
 *       }
 *     },
 *     output?: string,        // final output string (always present for dry-run; present on success otherwise)
 *   }
 */
function applyPatches(options) {
  const {
    filePath,
    patchNames,
    verbose = false,
    dryRun = false,
    patchesDir = PATCHES_DIR,
    codemodsDir = CODEMODS_DIR,
    timeout = 0,
  } = options;

  /**
   * Measure elapsed time for a synchronous transform.
   * Cannot interrupt Babel traverse (synchronous) — timeout is post-hoc only.
   */
  function measureElapsed(fn) {
    const start = Date.now();
    try {
      const result = fn();
      return { result, elapsedMs: Date.now() - start };
    } catch (e) {
      return { result: e, elapsedMs: Date.now() - start };
    }
  }

  const result = {
    applied: 0,
    skipped: 0,
    failed: 0,
    patches: {},
  };

  // Step 1: Load all patches, sorted by order then by id alphabetically
  const loaded = patchNames
    .map(name => loadPatch(name, patchesDir, codemodsDir))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  // Step 2: Read the input file exactly once
  let inputCode = fs.readFileSync(filePath, "utf8");

  // Sanity check: if the input file looks like it was already patched (baseline corruption),
  // warn loudly. Injected markers like __modsLoad__ should never be in the input.
  const injectedMarkers = ["__modsLoad__", "__isModEnabled__", "__getModConfig__"];
  const foundMarkers = injectedMarkers.filter(m => inputCode.includes(m));
  if (foundMarkers.length > 0) {
    console.error(`WARNING: Input file contains injected markers: ${foundMarkers.join(", ")}.`);
    console.error("  The baseline may be corrupted (patched output written back to baseline).");
    console.error("  Run `mise run clean <version>` and re-patch to restore a clean baseline.");
  }

  // Step 3: Classify patches against in-memory content
  const active = [];
  for (const patch of loaded) {
    // If loadPatch itself found an error (missing YAML, missing script), record it
    if (patch.error) {
      result.patches[patch.id] = {
        status: "error",
        error: patch.error,
      };
      result.failed++;
      continue;
    }

    const { applied: appliedTest, applicable: applicableTest } = patch.statusTests;

    if (appliedTest && patternExistsIn(inputCode, appliedTest)) {
      result.patches[patch.id] = {
        status: "already_applied",
        skip: "already_applied",
        matches: countMatchesIn(inputCode, appliedTest),
      };
      result.skipped++;
      if (verbose) console.error(`  ◌ ${patch.id}  already applied`);
      continue;
    }

    if (applicableTest && !patternExistsIn(inputCode, applicableTest)) {
      result.patches[patch.id] = {
        status: "not_applicable",
        skip: "not_applicable",
      };
      result.skipped++;
      if (verbose) console.error(`  ◌ ${patch.id}  not applicable`);
      continue;
    }

    // Active — needs to be applied
    active.push(patch);
  }

  // If no active patches, return early
  if (active.length === 0) {
    return result;
  }

  // If dry-run, return classification only (no transformations)
  if (dryRun) {
    // Mark all active patches as "would apply" — they haven't been transformed yet
    for (const patch of active) {
      result.patches[patch.id] = {
        status: "applied",
        matches: 0,
      };
      result.applied++;
    }
    result.output = inputCode;
    return result;
  }

  // Step 4: Parse AST once (only if any active patch uses Babel)
  const activeBabel = active.filter(p => p.engine === "babel");
  const activeRegex = active.filter(p => p.engine === "regex");

  let ast;
  if (activeBabel.length > 0) {
    inputCode = inputCode.replace(/[·΅∙⋅]/g, "_");
    // Protect "$N" in .replace() calls from Babel codegen corruption
    // Wrap: .replace(X, "$1") → .replace(X, "__BabelDollar__1")
    inputCode = inputCode.replace(CODEGEN_BUGGY_PATTERN, `$1${CODEGEN_SENTINEL}$2$3`);
    if (verbose) console.error(`\nParsing (${(inputCode.length / 1024).toFixed(0)} KB)...`);
    ast = parser.parse(inputCode, {
      sourceType: "unambiguous",
      plugins: ["jsx", "typescript"],
      errorRecovery: true,
    });
  }

  // Step 5: Babel transforms (sequential, in-place AST mutations)
  const timeoutMs = timeout > 0 ? timeout * 1000 : 0;
  for (const patch of activeBabel) {
    if (verbose) console.error(`  Babel: ${patch.id}`);
    const { result: transformResult, elapsedMs } = measureElapsed(
      () => patch.codemod.transform(ast, inputCode)
    );
    if (timeout && elapsedMs >= timeoutMs) {
      console.error(`  ⏱ ${patch.id}  TIMEOUT after ${(elapsedMs / 1000).toFixed(1)}s`);
      result.patches[patch.id] = { status: "timeout", elapsedMs, error: new Error(`Timed out after ${timeout}s`) };
      result.failed++;
      continue;
    }
    if (transformResult instanceof Error) {
      console.error(`  ✗ ${patch.id}  codemod failed: ${transformResult.message}`);
      patch._errored = true;
      result.patches[patch.id] = {
        status: "error",
        error: transformResult,
        elapsedMs,
      };
      result.failed++;
    } else {
      // Zero or { changed: 0 } means no target matched; skip rather than verifying
      // an injection that was not attempted.
      if (!transformResult || (typeof transformResult === "object" && transformResult.changed === 0)) {
        result.patches[patch.id] = {
          status: "not_applicable",
          skip: "not_applicable",
          elapsedMs,
        };
        result.skipped++;
        continue;
      }
      patch._errored = false;
      // Store elapsed time on the patch for later reporting
      patch._elapsedMs = elapsedMs;
    }
  }

  // Step 6: Generate once from AST
  let output;
  if (activeBabel.length > 0) {
    if (verbose) console.error(`\nGenerating...`);
    output = generate(ast, { retainLines: false }, inputCode).code;
    // Restore "$N" from sentinel after Babel generate
    // __BabelDollar__1 → $1, __BabelDollar__2 → $2, etc.
    // $$ in replacement produces literal $ (no capture groups in pattern)
    output = output.replace(new RegExp(CODEGEN_SENTINEL, "g"), "$$");
  } else {
    output = inputCode;
  }

  // Step 7: Regex transforms (sequential on string)
  for (const patch of activeRegex) {
    if (verbose) console.error(`  Regex: ${patch.id}`);
    const preSize = output.length;
    const { result: transformResult, elapsedMs } = measureElapsed(
      () => {
        const res = patch.codemod.transform(output);
        if (res.changed) output = res.code;
        return res;
      }
    );
    if (transformResult instanceof Error) {
      console.error(`  ✗ ${patch.id}  codemod failed: ${transformResult.message}`);
      patch._errored = true;
      result.patches[patch.id] = { status: "error", error: transformResult, elapsedMs };
      result.failed++;
    } else if (!transformResult || transformResult.changed === 0) {
      // Regex codemods returning { changed: 0 } — no matching target found.
      // Treat as skipped to avoid verification failure on unchanged output.
      // Symmetric with the Babel { changed: 0 } path above.
      result.patches[patch.id] = {
        status: "not_applicable",
        skip: "not_applicable",
        elapsedMs,
      };
      result.skipped++;
      if (verbose) console.error(`  ◌ ${patch.id}  regex returned changed: 0`);
      continue;
    } else {
      patch._errored = false;
      patch._elapsedMs = elapsedMs;
      // Reject shrinkage over 10%: a broad regex can consume a large source region.
      // Classify it as an error so the transaction cannot write.
      const postSize = output.length;
      const shrinkage = preSize - postSize;
      if (shrinkage > preSize * 0.1) {
        const shrinkErr = new Error(
          `Regex over-match: ${patch.id} shrunk output by ${Math.round(shrinkage / 1024)} KB (${((shrinkage / preSize) * 100).toFixed(1)}%). ` +
          `Pre: ${preSize} chars, Post: ${postSize} chars.`
        );
        console.error(`  ✗ ${patch.id}  ${shrinkErr.message}`);
        patch._errored = true;
        result.patches[patch.id] = { status: "error", error: shrinkErr, elapsedMs };
        result.failed++;
      }
    }
  }

  // Step 8: Post-processing for codemods that export postProcess
  // (e.g. injecting large text blocks that would overflow Babel's cloneNode)
  for (const patch of active) {
    if (patch._errored) continue;
    if (typeof patch.codemod.postProcess !== "function") continue;
    if (verbose) console.error(`  Regex post-process: ${patch.id}`);
    const { result: postResult, elapsedMs } = measureElapsed(
      () => patch.codemod.postProcess(output)
    );
    if (postResult instanceof Error) {
      console.error(`  ✗ ${patch.id}  post-process failed: ${postResult.message}`);
      patch._errored = true;
      result.patches[patch.id] = { status: "error", error: postResult, elapsedMs };
      result.failed++;
    } else {
      output = postResult;
      patch._elapsedMs = (patch._elapsedMs || 0) + elapsedMs;
    }
  }

  // Step 9: Verify all active (non-errored) patches against the final in-memory output string
  let verificationFailures = 0;
  for (const patch of active) {
    if (patch._errored) continue; // Already recorded
    if (result.patches[patch.id]) continue; // Already recorded (e.g. regex error)

    const { applied: appliedTest } = patch.statusTests;
    if (appliedTest && !patternExistsIn(output, appliedTest)) {
      result.patches[patch.id] = {
        status: "verification_failed",
        error: new Error(`Verification failed: applied pattern not found in output`),
        elapsedMs: patch._elapsedMs || 0,
      };
      result.failed++;
      verificationFailures++;
      console.error(`  ✗ ${patch.id}  verification failed`);
    }
  }

  // Step 10: Emit structured markers for CI extraction.
  // SKIPPED_PATCHES: lists patches that are not_applicable (code changed upstream).
  // FAILED_PATCHES: lists patches that errored or failed verification.
  const skippedIds = Object.entries(result.patches)
    .filter(([, v]) => v.status === "not_applicable")
    .map(([id]) => id);
  if (skippedIds.length > 0) {
    console.error(`SKIPPED_PATCHES:${skippedIds.join(",")}`);
  }

  // All-or-nothing write (ENG-07):
  // If ANY active patch failed (verification, codemod error, or regex shrinkage),
  // do NOT write to disk. The original file on disk is left untouched.
  if (verificationFailures > 0 || result.failed > 0) {
    const failedIds = Object.entries(result.patches)
      .filter(([, v]) => v.status === "error" || v.status === "verification_failed" || v.status === "timeout")
      .map(([id]) => id);
    if (failedIds.length > 0) {
      console.error(`FAILED_PATCHES:${failedIds.join(",")}`);
    }
    return result;
  }

  // Write the verified output to disk
  fs.writeFileSync(filePath, output, "utf8");

  // Step 11: Build final per-patch details for successful patches
  for (const patch of active) {
    if (patch._errored) continue;
    if (result.patches[patch.id]) continue; // Already recorded

    const { applied: appliedTest } = patch.statusTests;
    const matches = appliedTest ? countMatchesIn(output, appliedTest) : 0;

    result.patches[patch.id] = {
      status: "applied",
      matches,
      elapsedMs: patch._elapsedMs || 0,
    };
    result.applied++;
  }

  result.output = output;
  return result;
}

module.exports = { applyPatches };

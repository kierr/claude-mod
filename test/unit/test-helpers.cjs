/**
 * Shared test helpers for codemod tests.
 *
 * Provides utilities for:
 * - Running codemods against fixture code
 * - Verifying patch YAML status_test regexes against codemod output
 * - Loading patch definitions for test assertions
 *
 * Usage in test files:
 *   const { runCodemod, assertAppliedRegex, assertNotApplicable } = require("./test-helpers.cjs");
 */

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PATCHES_DIR = path.join(REPO_ROOT, "patches");
const { parseYAML } = require("../../lib/utils.cjs");

/**
 * Run a codemod script against input code and return the transformed output.
 *
 * @param {string} codemodPath - Absolute path to the codemod .cjs script
 * @param {string} inputCode - JavaScript source code to transform
 * @returns {string} Transformed output code
 */
function runCodemod(codemodPath, inputCode) {
  const fixturesDir = path.join(REPO_ROOT, "test", "fixtures");
  const tempInput = path.join(fixturesDir, `temp-input-${randomUUID()}.js`);
  const tempOutput = path.join(fixturesDir, `temp-output-${randomUUID()}.js`);

  fs.mkdirSync(fixturesDir, { recursive: true });
  fs.writeFileSync(tempInput, inputCode);

  function cleanup() {
    for (const p of [tempInput, tempOutput]) {
      try { fs.rmSync(p, { force: true }); } catch { /* ignore cleanup failure */ }
    }
  }

  try {
    const { execSync } = require("child_process");
    execSync(`node "${codemodPath}" "${tempInput}" "${tempOutput}"`, {
      stdio: "pipe",
      cwd: REPO_ROOT,
    });

    const output = fs.readFileSync(tempOutput, "utf8");
    cleanup();
    return output;
  } catch (error) {
    cleanup();
    throw error;
  }
}

/**
 * Load and parse a patch YAML definition.
 *
 * @param {string} patchId - Patch ID (filename without .yaml extension)
 * @returns {object} Parsed patch definition
 */
function loadPatchYaml(patchId) {
  const yamlPath = path.join(PATCHES_DIR, `${patchId}.yaml`);
  if (!fs.existsSync(yamlPath)) {
    throw new Error(`Patch YAML not found: ${yamlPath}`);
  }
  return parseYAML(fs.readFileSync(yamlPath, "utf8"));
}

/**
 * Get the `applied` regex from a patch's status_tests.
 *
 * @param {string} patchId - Patch ID
 * @returns {RegExp|null} The compiled applied regex, or null if not defined
 */
function getAppliedRegex(patchId) {
  const patch = loadPatchYaml(patchId);
  if (!patch.status_tests || !patch.status_tests.applied) return null;
  return new RegExp(patch.status_tests.applied);
}

/**
 * Get the `applicable` regex from a patch's status_tests.
 *
 * @param {string} patchId - Patch ID
 * @returns {RegExp|null} The compiled applicable regex, or null if not defined
 */
function getApplicableRegex(patchId) {
  const patch = loadPatchYaml(patchId);
  if (!patch.status_tests || !patch.status_tests.applicable) return null;
  return new RegExp(patch.status_tests.applicable);
}

/**
 * Assert that the `applied` regex from the patch YAML matches the codemod output.
 * Throws with a descriptive message if the regex doesn't match.
 *
 * @param {string} patchId - Patch ID
 * @param {string} output - Codemod output to test against
 * @returns {boolean} true if the assertion passes
 */
function assertAppliedRegex(patchId, output) {
  const regex = getAppliedRegex(patchId);
  if (!regex) {
    throw new Error(`Patch "${patchId}" has no applied regex defined`);
  }
  if (!regex.test(output)) {
    throw new Error(
      `applied regex for "${patchId}" did not match codemod output.\n` +
      `  Pattern: ${regex}\n` +
      `  Output preview: ${output.substring(0, 200)}...`
    );
  }
  return true;
}

/**
 * Assert that the `applicable` regex from the patch YAML does NOT match the
 * codemod output (i.e., the codemod transformed the code so the original pattern
 * no longer appears).
 *
 * @param {string} patchId - Patch ID
 * @param {string} output - Codemod output to test against
 * @returns {boolean} true if the assertion passes
 */
function assertNotApplicable(patchId, output) {
  const regex = getApplicableRegex(patchId);
  if (!regex) return true; // No applicable regex defined — nothing to check
  if (regex.test(output)) {
    throw new Error(
      `applicable regex for "${patchId}" still matches codemod output — transform may not have applied.\n` +
      `  Pattern: ${regex}\n` +
      `  Output preview: ${output.substring(0, 200)}...`
    );
  }
  return true;
}

module.exports = {
  runCodemod,
  loadPatchYaml,
  getAppliedRegex,
  getApplicableRegex,
  assertAppliedRegex,
  assertNotApplicable,
};

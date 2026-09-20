#!/usr/bin/env node
/**
 * Codemod: Agent View Force Enable
 *
 * Forces the agent view (third-party provider UI) to be always available,
 * bypassing both the disable flag gate and the GrowthBook/fleet feature flag gate.
 *
 * All function/variable names use \w+ since they are minifier artifacts.
 */

const fs = require("fs");
const path = require("path");

const MOD_ID = "unlock_agent_view";

/**
 * Wrap a matched function body with a mod guard.
 * Extracts original body from the match, prepends an early-return guard,
 * and preserves the original body for when the mod is disabled.
 *
 * @param {string} fullMatch - The full regex match including function signature
 * @param {string} indent - Leading whitespace for the function
 * @param {string} fnName - Function name to preserve
 * @param {object} opts
 * @param {string} opts.returnValue - Value to return when mod is enabled ("null", "false", "true")
 * @param {string} opts.marker - Idempotency marker comment
 * @returns {string} The wrapped function replacement
 */
function wrapFunctionBody(fullMatch, indent, fnName, { returnValue, marker }) {
  const bodyStart = fullMatch.indexOf("{") + 1;
  const bodyEnd = fullMatch.lastIndexOf("}");
  const originalBody = fullMatch.substring(bodyStart, bodyEnd).trim();
  return (
    indent + "function " + fnName + "() {\n" +
    indent + "    if(typeof __isModEnabled__===\"function\"&&__isModEnabled__(\"" + MOD_ID + "\"))return " + returnValue + "; " + marker + "\n" +
    indent + "    " + originalBody.replace(/\n/g, "\n" + indent + "    ") + "\n" +
    indent + "  }"
  );
}

/**
 * Patch A: Replace the disable-check function body
 *
 * Variant 1 (<= 2.1.143): single-line return A || B [|| C]
 * Variant 2 (>= 2.1.144): multi-line if/if/return null with reason strings
 *
 * Stable anchors: CLAUDE_CODE_DISABLE_AGENT_VIEW, disableAgentView
 */
function patchA(code) {
  // Code-split (2.1.277+): direct property access instead of FN(process.env.X)
  // if (a.CLAUDE_CODE_DISABLE_AGENT_VIEW) {
  const PATTERN_CODESPLIT = new RegExp(
    "([ \\t]*)function\\s+([\\w$]+)\\(\\)\\s*\\{\\s*\\n" +
    "\\s*if\\s*\\(\\s*a\\.CLAUDE_CODE_DISABLE_AGENT_VIEW\\s*\\)\\s*\\{\\s*\\n" +
    '\\s*return\\s+"is disabled by CLAUDE_CODE_DISABLE_AGENT_VIEW"\\s*;\\s*\\n' +
    "\\s*\\}\\s*\\n" +
    "\\s*if\\s*\\(\\s*[\\w$]+\\(\\)\\s*\\?\\.settings\\.disableAgentView\\s*===\\s*true\\s*\\)\\s*\\{\\s*\\n" +
    '\\s*return\\s+"is disabled by the \'disableAgentView\' setting"\\s*;\\s*\\n' +
    "\\s*\\}\\s*\\n" +
    "\\s*return\\s+null\\s*;\\s*\\n" +
    "\\s*\\}"
  );

  let match = PATTERN_CODESPLIT.exec(code);
  if (match) {
    const m0 = match;
    const replaced = code.replace(PATTERN_CODESPLIT, () =>
      wrapFunctionBody(m0[0], m0[1], m0[2], { returnValue: "null", marker: "/* __AVFE__ */" })
    );
    return { code: replaced, changed: 1 };
  }

  // Variant 2 (>= 2.1.144): multi-line if/return with reason strings.
  // Built with new RegExp(string) to handle the single quote in the setting string.
  const PATTERN_V2 = new RegExp(
    "([ \\t]*)function\\s+([\\w$]+)\\(\\)\\s*\\{\\s*\\n" +
    "\\s*if\\s*\\(\\s*[\\w$]+\\(\\s*process\\.env\\.CLAUDE_CODE_DISABLE_AGENT_VIEW\\s*\\)\\s*\\)\\s*\\{\\s*\\n" +
    '\\s*return\\s+"is disabled by CLAUDE_CODE_DISABLE_AGENT_VIEW"\\s*;\\s*\\n' +
    "\\s*\\}\\s*\\n" +
    "\\s*if\\s*\\(\\s*[\\w$]+\\(\\)\\s*\\?\\.settings\\.disableAgentView\\s*===\\s*true\\s*\\)\\s*\\{\\s*\\n" +
    '\\s*return\\s+"is disabled by the \'disableAgentView\' setting"\\s*;\\s*\\n' +
    "\\s*\\}\\s*\\n" +
    "\\s*return\\s+null\\s*;\\s*\\n" +
    "\\s*\\}"
  );

  match = PATTERN_V2.exec(code);
  if (match) {
    const m1 = match;
    const replaced = code.replace(PATTERN_V2, () =>
      wrapFunctionBody(m1[0], m1[1], m1[2], { returnValue: "null", marker: "/* __AVFE__ */" })
    );
    return { code: replaced, changed: 1 };
  }

  // Variant 1 (<= 2.1.143): single-line return with || chain.
  const PATTERN_V1 =
    /([ \t]*)function\s+([\w$]+)\(\)\s*\{\s*\n\s*return\s+[\w$]+\(\s*process\.env\.CLAUDE_CODE_DISABLE_AGENT_VIEW\s*\)\s*\|\|\s*[\w$]+\(\s*\)\s*\?\.settings\.disableAgentView\s*===\s*true(?:\s*\|\|\s*[\w$]+\(\s*\))?\s*;\s*\n\s*\}/;

  match = PATTERN_V1.exec(code);
  if (match) {
    const m2 = match;
    const replaced = code.replace(PATTERN_V1, () =>
      wrapFunctionBody(m2[0], m2[1], m2[2], { returnValue: "false", marker: "/* __AVFE__ */" })
    );
    return { code: replaced, changed: 1 };
  }

  return { code, changed: 0 };
}

/**
 * Patch B: Replace the agent view availability function body with return true
 *
 * Stable anchor: tengu_slate_meadow (string literal unique to this gate)
 */
function patchB(code) {
  const PATTERN =
    /([ \t]*)function\s+([\w$]+)\(\)\s*{\s*\n\s*return\s+![\w$]+\(\)\s*&&\s*\(\s*[\w$]+\(\)\s*\|\|\s*[\w$]+\(\s*"tengu_slate_meadow"\s*,\s*false\s*\)\s*\)\s*;\s*\n\s*\}/;

  const match = PATTERN.exec(code);
  if (!match) return { code, changed: 0 };

  const replaced = code.replace(PATTERN, () =>
    wrapFunctionBody(match[0], match[1], match[2], { returnValue: "true", marker: "/* __AVFE__ */" })
  );
  return { code: replaced, changed: 1 };
}

function transform(code) {
  // L2: Explicit idempotency check — avoid re-matching already-patched code
  // that might contain partial patterns (e.g., the original if-clauses could
  // re-match if the replacement isn't exact).
  if (code.includes("__AVFE__")) {
    return { code, changed: 0 };
  }

  let result = patchA(code);
  const changedA = result.changed;
  result = patchB(result.code);
  const changedB = result.changed;
  return { code: result.code, changed: changedA + changedB };
}

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-unlock-agent-view.cjs <input.js> [output.js]");
    process.exit(1);
  }
  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");
  const { code: output, changed: changedCount } = transform(code);
  if (changedCount === 0) {
    if (code.includes("__AVFE__")) {
      console.error("Agent view gates already patched; skipping.");
    } else {
      throw new Error("No matching agent view gate patterns found — bundle may have drifted.");
    }
  } else {
    console.error("Patched " + changedCount + " agent view gate(s).");
  }
  if (outputFile) {
    fs.writeFileSync(path.resolve(outputFile), output, "utf8");
  } else {
    process.stdout.write(output);
  }
}

if (require.main === module) {
  main();
}

module.exports = { transform };

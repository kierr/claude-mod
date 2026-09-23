#!/usr/bin/env node
// Preserve native-mode paths needed by search under standalone Bun.
// The companion spawn_script_path patch supplies the script argument that native-mode worker spawning omits.
// Do not remove this override without verifying both search and worker startup.

const REQUIRED_CHANGES = 2;

const fs = require("fs");
const path = require("path");

/**
 * Patch A: force the Fz()/EA() native-binary check to true (mod-guarded, default ON).
 *
 * Matching: the unique string `Array.isArray(Bun.embeddedFiles) && Bun.embeddedFiles.length > 0`
 * inside a `return` statement.
 */
function patchFz(code) {
  const anchor = "Array.isArray(Bun.embeddedFiles) && Bun.embeddedFiles.length > 0";
  const idx = code.indexOf(anchor);
  if (idx === -1) {
    return { code, changed: 0 };
  }

  const lineStart = code.lastIndexOf("\n", idx) + 1;
  const lineEnd = code.indexOf("\n", idx);
  const line = code.substring(lineStart, lineEnd).trim();

  if (!line.startsWith("return ") || !line.endsWith(";")) {
    return { code, changed: 0 };
  }

  code = code.substring(0, lineStart) + "    return (typeof __isModEnabled__ === \"function\" && __isModEnabled__(\"native_binary_compat\")) || Array.isArray(Bun.embeddedFiles) && Bun.embeddedFiles.length > 0;\n" + code.substring(lineEnd);
  return { code, changed: 1 };
}

/**
 * Patch B: Change `return "missing"` to `return "loading"` in the auth status useState.
 *
 * Matching: find `skipRetrievingKeyFromApiKeyHelper` inside a `useState` callback,
 * then locate `return "missing"` within a bounded window after it.
 */
function patchAuthStatus(code) {
  let searchFrom = 0;

  while (true) {
    const suIdx = code.indexOf("useState(", searchFrom);
    if (suIdx === -1) break;

    const window = code.substring(suIdx, Math.min(code.length, suIdx + 1000));
    if (!window.includes("skipRetrievingKeyFromApiKeyHelper")) {
      searchFrom = suIdx + 1;
      continue;
    }

    const skipIdx = window.indexOf("skipRetrievingKeyFromApiKeyHelper");
    const afterSkip = window.substring(skipIdx);
    const missingMatch = afterSkip.match(/return "missing"/);
    if (!missingMatch) {
      searchFrom = suIdx + 1;
      continue;
    }

    const absolutePos = suIdx + skipIdx + missingMatch.index;
    code = code.substring(0, absolutePos) + 'return (typeof __isModEnabled__ === "function" && __isModEnabled__("native_binary_compat")) ? "loading" : "missing"' + code.substring(absolutePos + 'return "missing"'.length);
    return { code, changed: 1 };
  }

  return { code, changed: 0 };
}

function transform(code) {
  let totalChanged = 0;

  if (code.includes("__nbc_patched__")) {
    return { code, changed: 0 };
  }

  const a = patchFz(code);
  code = a.code;
  totalChanged += a.changed;

  const b = patchAuthStatus(code);
  code = b.code;
  totalChanged += b.changed;

  if (totalChanged >= REQUIRED_CHANGES) {
    const marker = "\nvar __nbc_patched__ = true;\n";
    const firstFunc = code.indexOf("function ");
    if (firstFunc > 0) {
      const secondFunc = code.indexOf("function ", firstFunc + 1);
      if (secondFunc > 0) {
        const insertPoint = code.lastIndexOf("\n", secondFunc) + 1;
        code = code.substring(0, insertPoint) + marker + code.substring(insertPoint);
      }
    }
  }

  return { code, changed: totalChanged };
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-native-binary-compat.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const { code: output, changed } = transform(code);

  if (changed === 0) {
    if (code.includes("__nbc_patched__")) {
      console.error("Native binary compat already applied; skipping.");
    } else {
      throw new Error("No matching Fz()/auth-status targets found — bundle may have drifted.");
    }
  } else {
    console.error(`Patched ${changed} target(s): Fz() native check + auth status.`);
  }

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

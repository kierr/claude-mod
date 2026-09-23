#!/usr/bin/env node
// Guard cache clearing rather than removing it: disabled behavior and the preceding state snapshot must remain intact.

const fs = require("fs");
const path = require("path");

const MOD_ID = "fix_file_cache";

/**
 * Find patterns like:
 *   let v = ANYFUNC(X.readFileState);
 *   X.readFileState.clear();
 *   X.loadedNestedMemoryPaths?.clear();
 *
 * And wrap the clear() + optional loadedNestedMemoryPaths?.clear() in a mod guard:
 *   if (!(typeof __isModEnabled__ === "function" && __isModEnabled__("fix_file_cache"))) {
 *     X.readFileState.clear();
 *     X.loadedNestedMemoryPaths?.clear();
 *   }
 *
 * Anchors on the stable property name "readFileState" — discovers the object
 * identifier (X) and the callee name (ANYFUNC) from context.
 */
function transform(code) {
  // Idempotency
  if (code.includes(`__isModEnabled__("${MOD_ID}")`)) {
    return { code, changed: 0 };
  }

  const modGuard = `typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}")`;

  // Match: let/const/var v = ANYFUNC(X.readFileState);
  // X is the object identifier we need to discover
  const snapshotPattern = /(?:let|const|var)\s+([\w$]+)\s*=\s*([\w$]+)\(([\w$]+)\.readFileState\)\s*;/g;

  let match;
  let count = 0;
  // Collect all matches first to avoid mutating while iterating
  const replacements = [];

  while ((match = snapshotPattern.exec(code)) !== null) {
    const objectName = match[3];

    // Now find the next line(s): X.readFileState.clear(); and optionally X.loadedNestedMemoryPaths?.clear();
    const afterSnapshot = match.index + match[0].length;

    // Build the expected clear() pattern
    const clearPattern = new RegExp(
      `(${objectName}\\.readFileState\\.clear\\(\\)\\s*;\\s*(?:${objectName}\\.loadedNestedMemoryPaths\\?\\.clear\\(\\)\\s*;\\s*)?)`
    );

    const clearMatch = code.substring(afterSnapshot).match(clearPattern);
    if (!clearMatch) continue;

    const clearStart = afterSnapshot + clearMatch.index;
    const clearEnd = clearStart + clearMatch[0].length;

    // Don't wrap if it's inside a finally block (preserve finally clears)
    // Check if there's a "finally" keyword between the last try and this point
    const precedingCode = code.substring(0, clearStart);
    const lastFinally = precedingCode.lastIndexOf("finally");
    const lastTry = precedingCode.lastIndexOf("try");
    if (lastFinally > lastTry && lastFinally > match.index) continue;

    replacements.push({ clearStart, clearEnd, clearCode: clearMatch[0], objectName });
  }

  // Apply replacements in reverse order to maintain offsets
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i];
    const guarded = `if (!(${modGuard})) {\n    ${r.clearCode.trimEnd()}\n  }`;
    code = code.substring(0, r.clearStart) + guarded + code.substring(r.clearEnd);
    count++;
  }

  if (count === 0) return { code, changed: 0 };

  return { code, changed: count };
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-fix-file-cache.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const { code: output, changed } = transform(code);

  if (changed === 0) {
    console.error("No matching readFileState.clear() compaction calls found; nothing changed.");
  } else {
    console.error(`Wrapped ${changed} readFileState.clear() call(s) with __isModEnabled__ guard.`);
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

#!/usr/bin/env node

/** Marker left in the output; doubles as the patch's `applied` status anchor. */
const MARKER = "__MODEL_RESTORE_OK__";

/**
 * Drop the "unknown_family" ternary branch from the restore classifier,
 * leaving a __MODEL_RESTORE_OK__ marker comment.
 *
 * @param {string} code - Full deobfuscated bundle source.
 * @returns {{ code: string, changed: number }}
 */
function transform(code) {
  // Idempotency: already patched.
  if (code.includes(MARKER)) {
    return { code, changed: 0 };
  }

  // Match the classifier statement:
  //   let $ = <unknown_family-cond> ? "unknown_family" : <tail> ;
  // head = declaration (`let $ = `), cond = the unknown_family condition, tail =
  // the not_allowed/retired/undefined remainder (shape varies by version).
  const pattern = /((?:let|const|var)\s+[\w$]+\s*=\s*)([^;\n]*?)\?\s*"unknown_family"\s*:\s*([^;\n]*?);/;

  if (!pattern.test(code)) {
    return { code, changed: 0 };
  }

  // Guard the condition instead of dropping the branch (per user policy: every
  // patch toggleable). When the mod is enabled the condition is forced false, so
  // the unknown_family branch is skipped and the stored model is restored as-is;
  // when disabled, the original classifier runs unchanged. Keeping the branch
  // structurally is safe — the engine checks the `applied` marker first, so the
  // `applicable` regex matching patched output does not cause re-application.
  code = code.replace(
    pattern,
    (_match, head, cond, tail) =>
      `${head}(typeof __isModEnabled__ === "function" && __isModEnabled__("unlock_model_restore") ? false : (${cond.trim()})) ? "unknown_family" : ${tail}; /*${MARKER}*/`
  );
  return { code, changed: 1 };
}

/** CLI wrapper: <input.js> [output.js] */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-unlock-model-restore.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const fs = require("fs");
  const path = require("path");

  const inputPath = path.resolve(inputFile);
  const src = fs.readFileSync(inputPath, "utf8");

  const { code: output, changed } = transform(src);

  if (changed === 0) {
    if (src.includes(MARKER)) {
      console.error("Model-restore-family already patched; skipping.");
    } else {
      throw new Error('No matching restore classifier ("unknown_family" ternary) found — bundle may have drifted.');
    }
  } else {
    console.error('Patched restore classifier: guarded "unknown_family" rejection branch.');
  }

  if (outputFile) {
    fs.writeFileSync(path.resolve(outputFile), output, "utf8");
  } else {
    process.stdout.write(output);
  }
}

module.exports = { transform, MARKER };

if (require.main === module) {
  main();
}

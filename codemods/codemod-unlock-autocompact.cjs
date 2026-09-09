#!/usr/bin/env node

/**
 * Transform: add "auto" as an accepted autoCompactWindow source.
 *
 * Handles two baseline variants:
 *   Old (pre-2.1.167): return Q === "env" || Q === "settings";
 *   New (2.1.167+):    return Q === "env" || Q === "settings" || Q === "model-default";
 *
 * Both become:
 *   return Q === "env" || Q === "settings" || Q === "model-default" || Q === "auto";
 * or (old baseline):
 *   return Q === "env" || Q === "settings" || Q === "auto";
 */
function transform(code) {
  // Idempotency: the mod guard is present only after this patch applies.
  if (code.includes('__isModEnabled__("unlock_autocompact")')) {
    return { code, changed: 0 };
  }

  // Guard wraps just the `|| X === "auto"` term, so toggling the mod off
  // restores the upstream gate (env/settings/model-default) exactly. Per user
  // policy every patch is toggleable; the mod defaults ON in mods.json.
  const autoTerm = (v) => `(typeof __isModEnabled__ === "function" && __isModEnabled__("unlock_autocompact") && ${v} === "auto")`;

  // New baseline (2.1.167+): return X === "env" || X === "settings" [|| X === "clientdata" (2.1.179+)] || ... || X === "model-default";
  // Middle sources vary across versions (2.1.178: settings; 2.1.179: settings+clientdata),
  // so capture+preserve them rather than hardcoding, then append the guarded "auto" term.
  const newPattern = /return (\w+) === "env"((?: \|\| \1 === "[\w-]+")*) \|\| \1 === "model-default";/;
  if (newPattern.test(code)) {
    code = code.replace(
      newPattern,
      (_match, varName, middle) => `return ${varName} === "env"${middle} || ${varName} === "model-default" || ${autoTerm(varName)};`
    );
    return { code, changed: 1 };
  }

  // Old baseline (pre-2.1.167): return X === "env" || X === "settings";
  const oldPattern = /return (\w+) === "env" \|\| \1 === "settings";/;
  if (oldPattern.test(code)) {
    code = code.replace(
      oldPattern,
      (match, varName) => `return ${varName} === "env" || ${varName} === "settings" || ${autoTerm(varName)};`
    );
    return { code, changed: 1 };
  }

  return { code, changed: 0 };
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-unlock-autocompact.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const fs = require("fs");
  const path = require("path");

  const inputPath = path.resolve(inputFile);
  const src = fs.readFileSync(inputPath, "utf8");

  const { code: output, changed } = transform(src);

  if (changed === 0) {
    if (src.includes('__isModEnabled__("unlock_autocompact")')) {
      console.error("Auto-compact eligibility already patched; skipping.");
    } else {
      throw new Error("No matching mq_ source check found — bundle may have drifted.");
    }
  } else {
    console.error("Patched mq_() to accept 'auto' as valid autoCompactWindow source (mod-guarded).");
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

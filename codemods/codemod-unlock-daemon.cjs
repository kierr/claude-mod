#!/usr/bin/env node

"use strict";

const MOD_ID = "unlock_daemon";

function transform(code) {
  // Idempotency: already patched
  if (code.includes("__DSE__")) {
    return { code, changed: 0 };
  }

  // Match: function OzH() { return D_("tengu_amber_anchor", false); }
  // The function name is minified but the string "tengu_amber_anchor" is stable
  // Minified names may contain $ (e.g. Q$H), so use [\w$]+ instead of \w+
  // RATIONALE: Uses \s* instead of \n between braces and body — webcrack usually
  // produces multi-line output, but different webcrack versions or upstream reformats
  // could produce single-line output. Would need proof that \n is required for
  // disambiguation (prevents matching a different function) to revert to \n.
  const pattern = /([ \t]*)function\s+([\w$]+)\(\)\s*\{\s*\n?\s*return\s+[\w$]+\(\s*"tengu_amber_anchor"\s*,\s*false\s*\)\s*;\s*\n?\s*\}/;

  if (!pattern.test(code)) {
    return { code, changed: 0 };
  }

  const result = code.replace(
    pattern,
    (match, indent, fnName) => {
      // Extract original body (everything between outer braces)
      const bodyStart = match.indexOf("{") + 1;
      const bodyEnd = match.lastIndexOf("}");
      const originalBody = match.substring(bodyStart, bodyEnd).trim();
      return (
        indent + `function ${fnName}() {\n` +
        indent + `    if(typeof __isModEnabled__==="function"&&__isModEnabled__("${MOD_ID}"))return true; /* __DSE__ */\n` +
        indent + "    " + originalBody.replace(/\n/g, "\n" + indent + "    ") + "\n" +
        indent + "  }"
      );
    }
  );

  return { code: result, changed: result !== code ? 1 : 0 };
}

if (require.main === module) {
  const fs = require("fs");
  const inputPath = process.argv[2];
  const outputPath = process.argv[3] || inputPath;
  const code = fs.readFileSync(inputPath, "utf8");
  const { code: output, changed } = transform(code);
  if (changed === 0) {
    if (code.includes("__DSE__")) {
      console.error(`${MOD_ID}: already applied; skipping.`);
    } else {
      throw new Error(`${MOD_ID}: no matching pattern found — bundle may have drifted.`);
    }
  } else {
    fs.writeFileSync(outputPath, output);
    console.error(`${MOD_ID}: ${changed} patches applied`);
  }
  process.exit(changed > 0 ? 0 : 2);
}

module.exports = { transform };

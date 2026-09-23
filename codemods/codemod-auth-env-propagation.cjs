#!/usr/bin/env node
// Forward credentials through both subprocess and tmux environment allowlists.
// Use array spreads so injected expressions remain valid in the generated bundle.
"use strict";

const MOD_ID = "add_auth_forwarding";

function transform(code) {
  // Idempotency: already patched (mod-guarded ternary is unique to this codemod)
  if (code.includes('__isModEnabled__("add_auth_forwarding")')) {
    return { code, changed: 0 };
  }

  let result = code;
  let changed = 0;

  // Match both inline arrays and Set-backed environment allowlists.
  // Use spread insertion to keep generated expressions compatible with Bun.
  const inlinePattern = /for\s*\(\s*let\s+([\w$]+)\s+of\s*\[\s*"CLAUDE_CONFIG_DIR"/;
  const setPattern = /([\w$]+)\s*=\s*new\s+Set\(\[\s*"CLAUDE_CONFIG_DIR"/;

  if (inlinePattern.test(result)) {
    // Old form: inject spread directly into the for-of array
    result = result.replace(
      inlinePattern,
      (match, loopVar) =>
        `for (let ${loopVar} of [...(typeof __isModEnabled__==="function"&&__isModEnabled__("${MOD_ID}")` +
        ` ? ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] : []), "CLAUDE_CONFIG_DIR"`
    );
    changed++;
  } else if (setPattern.test(result)) {
    // New form: find the Set variable, then find its for-of usage, inject spread before the Set spread
    const setMatch = result.match(setPattern);
    const setVarName = setMatch[1];
    // Find the for-of loop that iterates the Set variable
    const forOfPattern = new RegExp(`for\\s*\\(\\s*let\\s+([\\w$]+)\\s+of\\s+${setVarName}\\s*\\)`);
    const forOfMatch = result.match(forOfPattern);
    if (forOfMatch) {
      const loopVar = forOfMatch[1];
      // Replace the for-of with spread injection: for (let _ of [...(ternary), ...SETVAR])
      result = result.replace(
        forOfPattern,
        `for (let ${loopVar} of [...(typeof __isModEnabled__==="function"&&__isModEnabled__("${MOD_ID}")` +
        ` ? ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] : []), ...${setVarName}])`
      );
      changed++;
    }
  }

  // Patch 2: tmux teammate env whitelist — add auth vars conditionally.
  // Uses spread syntax: VAR = [...(ternary), "EXISTING", ...]
  const tmuxPattern = /([\w$]+)\s*=\s*\[([^\]]*)"ANTHROPIC_BASE_URL"/;
  const tmuxMatch = result.match(tmuxPattern);
  if (tmuxMatch) {
    const arrayContent = tmuxMatch[2];
    if (!arrayContent.includes("ANTHROPIC_AUTH_TOKEN")) {
      result = result.replace(
        tmuxPattern,
        (match, varName, before) =>
          `${varName} = [...(typeof __isModEnabled__==="function"&&__isModEnabled__("${MOD_ID}")` +
          ` ? ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] : []), ${before}"ANTHROPIC_BASE_URL"`
      );
      changed++;
    }
  }

  return { code: result, changed };
}

if (require.main === module) {
  const fs = require("fs");
  const inputPath = process.argv[2];
  const outputPath = process.argv[3] || inputPath;
  const code = fs.readFileSync(inputPath, "utf8");
  const { code: output, changed } = transform(code);
  if (changed === 0) {
    if (code.includes('__isModEnabled__("add_auth_forwarding")')) {
      console.error(`${MOD_ID}: already applied; skipping.`);
    } else {
      throw new Error(`${MOD_ID}: no matching patterns found — bundle may have drifted.`);
    }
  } else {
    fs.writeFileSync(outputPath, output);
    console.error(`${MOD_ID}: ${changed} patches applied`);
  }
  process.exit(changed > 0 ? 0 : 2);
}

module.exports = { transform };

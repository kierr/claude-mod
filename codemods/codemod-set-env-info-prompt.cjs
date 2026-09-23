#!/usr/bin/env node
// Replace identity strings individually because optional guards can separate them within the prompt array.

const fs = require("fs");
const path = require("path");

const ENV_VAR = "CLAUDE_CODE_ENV_INFO_PROMPT";
const MOD_ID = "set_env_info_prompt";

// Match either quoted or template-literal model-family text.
const STRING1_PATTERN =
  /[`"]The most recent Claude model[^`"]*[`"]/g;

// Pattern for string 2: always double-quoted.
const STRING2_PATTERN =
  /"Claude Code is available as a CLI in the terminal[^"]*"/g;

// Pattern for string 3: always double-quoted.
const STRING3_PATTERN =
  /"Fast mode for Claude Code[^"]*"/g;

function transform(code) {
  // Idempotency: check for the exact replacement string
  if (code.includes(`__env_model_info_guarded__`)) {
    return { code, changed: 0 };
  }

  // __getModConfig__("set_env_info_prompt","prompt") ?? null
  // Disabled -> undefined ?? null -> null (claims removed); enabled+set -> custom prompt.
  const guardedReplacement = `(__getModConfig__("${MOD_ID}","prompt") ?? null)`;
  let count = 0;

  const result = code
    .replace(STRING1_PATTERN, (match) => {
      count++;
      return guardedReplacement;
    })
    .replace(STRING2_PATTERN, (match) => {
      count++;
      return guardedReplacement;
    })
    .replace(STRING3_PATTERN, (match) => {
      count++;
      return guardedReplacement;
    });

  if (count > 0) {
    return { code: "var __env_model_info_guarded__ = true;\n" + result, changed: count };
  }
  return { code: result, changed: count };
}

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-set-env-info-prompt.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const code = fs.readFileSync(path.resolve(inputFile), "utf8");
  const { code: output, changed } = transform(code);

  if (changed === 0) {
    if (code.includes("__env_model_info_guarded__")) {
      console.error("Env model info already replaced; skipping.");
    } else {
      throw new Error("No matching model info block found — bundle may have drifted.");
    }
  } else {
    console.error(`Replaced ${changed} env_info string(s) with ${ENV_VAR} override.`);
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

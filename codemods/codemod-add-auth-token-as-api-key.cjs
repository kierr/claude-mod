#!/usr/bin/env node
// Use the auth token as an API-key source after the bare-mode check, preserving bare-mode behavior.
"use strict";

const MOD_ID = "add_auth_token_as_api_key";
const STABLE_ANCHOR = "skipRetrievingKeyFromApiKeyHelper";

function transform(code) {
  // Idempotency: already patched
  if (code.includes("__ATAK__")) {
    return { code, changed: 0 };
  }

  // Verify the stable anchor exists
  if (!code.includes(STABLE_ANCHOR)) {
    return { code, changed: 0 };
  }

  // Match the transition from bare-mode block to normal key resolution.
  // The bare-mode block ends with `source: "none"` + closing braces,
  // followed by `let _ = <fn>() ? undefined : process.env.ANTHROPIC_API_KEY;`
  //
  // We match:
  //   source: "none"\n      };\n    }\n    let <var> = <fn>() ? undefined : process.env.ANTHROPIC_API_KEY;
  // And inject the ANTHROPIC_AUTH_TOKEN check between the } and the let.

  const pattern = new RegExp(
    '(source: "none"\\n' +
    '\\s+};\\n' +
    '\\s+}\\n' +
    ')(\\s+let [\\w$]+ = [\\w$]+\\(\\) \\? undefined : process\\.env\\.ANTHROPIC_API_KEY;)',
  );

  const match = code.match(pattern);
  if (!match) {
    return { code, changed: 0 };
  }

  // Verify this is inside the right function by checking the anchor is nearby
  const matchIndex = code.indexOf(match[0]);
  const precedingContext = code.substring(Math.max(0, matchIndex - 500), matchIndex);
  if (!precedingContext.includes(STABLE_ANCHOR)) {
    return { code, changed: 0 };
  }

  const injection =
    match[1] +
    "    if (typeof __isModEnabled__===\"function\"&&__isModEnabled__(\"" + MOD_ID + "\")&&process.env.ANTHROPIC_AUTH_TOKEN) {\n" +
    "      return {\n" +
    "        key: process.env.ANTHROPIC_AUTH_TOKEN,\n" +
    "        source: \"ANTHROPIC_AUTH_TOKEN\"\n" +
    "      }; /* __ATAK__ */\n" +
    "    }\n" +
    match[2];

  // Use callback to avoid $-pattern interpretation in captured text (e.g.
  // minified names like $1 would be treated as backreferences in a string arg).
  let working = code.replace(pattern, () => injection);
  let changed = working !== code ? 1 : 0;

  // Rider: suppress the both-auth-methods false-positive warning (__BAM__).
  // The injection above makes the API-key resolver return source
  // "ANTHROPIC_AUTH_TOKEN" — the same source the auth-token resolver already
  // returns from the env var. The both-auth-methods diagnostic only de-dupes the
  // apiKeyHelper/apiKeyHelper case, so it fires as a false positive whenever this
  // mod is active with ANTHROPIC_AUTH_TOKEN set. Generalize the guard to fire
  // only when the two resolvers report DIFFERENT sources. Backrefs tie the guard
  // identifiers to the !== "none" identifiers so the match is structural.
  //
  // Not verified by status_tests.applied (which checks __ATAK__ only): if a
  // future release rewrites this warning, the rider no-ops and the cosmetic
  // warning returns — self-announcing — instead of failing verification and
  // disabling the auth mod along with it.
  const guardPattern = /([\w$]+) !== "none" && ([\w$]+)\.source !== "none" && \(\1 !== "apiKeyHelper" \|\| \2\.source !== "apiKeyHelper"\)/;
  const beforeGuard = working;
  working = working.replace(
    guardPattern,
    (_m, a, b) => `${a} !== "none" && ${b}.source !== "none" && (${a} !== ${b}.source) /* __BAM__ */`,
  );
  if (working !== beforeGuard) changed++;

  return { code: working, changed };
}

module.exports = { transform };

if (require.main === module) {
  const fs = require("fs");
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];

  if (!inputPath) {
    console.error("Usage: node codemod-add-auth-token-as-api-key.cjs <input> [output]");
    process.exit(1);
  }

  const code = fs.readFileSync(inputPath, "utf8");
  const { code: output, changed } = transform(code);

  if (outputPath) {
    fs.writeFileSync(outputPath, output);
  } else {
    process.stdout.write(output);
  }

  console.error(`add-auth-token-as-api-key: ${changed ? "applied" : "no match"}`);
  process.exit(changed ? 0 : 2);
}

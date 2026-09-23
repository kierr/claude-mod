#!/usr/bin/env node
// Include provider credentials in the generated daemon environment; the service does not inherit the interactive shell.
"use strict";

const MOD_ID = "add_auth_forwarding";

function transform(code) {
  // Match the EnvironmentVariables section of the daemon plist template.
  // Unique anchors:
  //   - <key>EnvironmentVariables</key> inside a template literal
  //   - Only PATH is present as a single env var
  //   - The template uses ${RrH(O)} (minified name) to escape values
  //
  // We match the PATH line and inject additional env var entries after it,
  // before the closing </dict>.
  //
  // Pattern breakdown:
  //   <key>EnvironmentVariables</key><dict>\n    <key>PATH</key><string>${\w+(\w+)}</string>\n  </dict>
  // Note: </string> closing tag for PATH is absorbed into inject rather than
  // captured in the `after` group, so we don't produce an orphaned </string>.
  const pattern =
    /(<key>EnvironmentVariables<\/key><dict>\s*\n\s*<key>PATH<\/key><string>)\$\{([\w$]+)\(([\w$]+)\)\}<\/string>(\s*\n\s*<\/dict>)/;

  if (!pattern.test(code)) {
    return { code, changed: 0 };
  }

  // Verify this is the daemon plist by checking for "<string>daemon</string>"
  // in the preceding context (ProgramArguments entry). The label uses ${MNH}
  // template expression so we can't anchor on the literal daemon label string.
  const envVarsIndex = code.search(pattern);
  const precedingContext = code.substring(Math.max(0, envVarsIndex - 500), envVarsIndex);
  if (!precedingContext.includes("<string>daemon</string>")) {
    return { code, changed: 0 };
  }

  const result = code.replace(
    pattern,
    (match, before, escapeFn, pathVar, after) => {
      // Inject additional env var entries as template expressions.
      // Each entry is conditional: only emitted if __isModEnabled__ returns true
      // AND the env var exists. Uses the same escape function (RrH or whatever
      // it's renamed to) to safely escape values for XML.
      // __DPA__ is the idempotency marker. It MUST sit inside the ${...}
      // substitution (JS expression context, where /* */ is a real comment),
      // never as bare text in the template literal — template literals do not
      // honor /* */ comments, so bare marker text renders verbatim into the
      // plist XML and corrupts it (launchd "Bootstrap failed: 5").
      const inject = [
        `\${${escapeFn}(${pathVar})}</string>`,
        `\${typeof __isModEnabled__==="function"&&__isModEnabled__("add_auth_forwarding")&&process.env.ANTHROPIC_API_KEY ? "\\n    <key>ANTHROPIC_API_KEY</key><string>" + ${escapeFn}(process.env.ANTHROPIC_API_KEY) + "</string>" : ""/* __DPA__ */}`,
        `\${typeof __isModEnabled__==="function"&&__isModEnabled__("add_auth_forwarding")&&process.env.ANTHROPIC_BASE_URL ? "\\n    <key>ANTHROPIC_BASE_URL</key><string>" + ${escapeFn}(process.env.ANTHROPIC_BASE_URL) + "</string>" : ""}`,
      ].join("\n");
      return before + inject + after;
    }
  );

  return { code: result, changed: result !== code ? 1 : 0 };
}

module.exports = { transform };

if (require.main === module) {
  const fs = require("fs");
  const inputPath = process.argv[2];
  const outputPath = process.argv[3] || inputPath;
  const code = fs.readFileSync(inputPath, "utf8");
  const { code: output, changed } = transform(code);
  fs.writeFileSync(outputPath, output);
  console.error(`${MOD_ID}: ${changed} patches applied`);
  process.exit(changed > 0 ? 0 : 2);
}

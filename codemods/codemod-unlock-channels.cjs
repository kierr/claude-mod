#!/usr/bin/env node

function transform(code) {
  // Idempotency check
  if (code.includes("__channels_unnerfed")) {
    return { code, changed: 0 };
  }

  let changed = 0;

  // Gate 1: Provider check — exact multi-line match on the if-return block.
  // The reason string "channels are not available on third-party providers" is unique
  // in the bundle (only appears in this gate).
  const providerGate = new RegExp(
    `if\\s*\\(\\w+\\(\\)\\s*!==\\s*"firstParty"\\)\\s*\\{\\n` +
    `\\s*return\\s*\\{\\n` +
    `\\s*action:\\s*"skip",\\n` +
    `\\s*kind:\\s*"provider",\\n` +
    `\\s*reason:\\s*"channels are not available on third-party providers"\\n` +
    `\\s*\\};\\n` +
    `\\s*\\}`
  );

  // Gate 2: Feature flag (DNH / tengu_harbor)
  const ffGate = new RegExp(
    `if\\s*\\(!\\w+\\(\\)\\)\\s*\\{\\n` +
    `\\s*return\\s*\\{\\n` +
    `\\s*action:\\s*"skip",\\n` +
    `\\s*kind:\\s*"disabled",\\n` +
    `\\s*reason:\\s*"channels feature is not currently available"\\n` +
    `\\s*\\};\\n` +
    `\\s*\\}`
  );

  // Gate 3: Policy check (org managed settings)
  const policyGate = new RegExp(
    `if\\s*\\(\\w+\\(\\w+\\)\\)\\s*\\{\\n` +
    `\\s*return\\s*\\{\\n` +
    `\\s*action:\\s*"skip",\\n` +
    `\\s*kind:\\s*"policy",\\n` +
    `\\s*reason:\\s*"channels not enabled by org policy[^"]*"[^}]*\\n` +
    `\\s*\\};\\n` +
    `\\s*\\}`
  );

  // Keep the disabled-status object scoped to the disabled branch.
  // The enabled path must return before any access to that object.
  const statusBlock = new RegExp(
    'const \\w+ = \\{\\n' +
    '\\s*disabled: !\\w+\\(\\),\\n' +
    '\\s*is3P: \\w+\\(\\) !== "firstParty",\\n' +
    '\\s*policyBlocked: \\w+\\(\\w+\\)\\n' +
    '\\s*\\};'
  );

  // Gate 5: Capability stripper — removes claude/channel from server capabilities
  // when DNH() is false or plugin not on allowlist, preventing capability check pass.
  // Match the full if-block including body so we produce valid JS after replacement.
  // The capabilities variable name (LH in 2.1.150) is a minifier artifact — use capture group.
  // Stable anchor: "claude/channel" property key (unique string literal).
  const capStripper = new RegExp(
    `if\\s*\\((\\w+)\\["claude\\/channel"\\]\\s*&&\\s*\\(!\\w+\\(\\)\\s*\\|\\|\\s*!\\w+\\([^)]+\\)\\)\\)\\s*\\{\\n` +
    `\\s*delete \\1\\["claude\\/channel"\\];\\n` +
    `\\s*\\}`
  );

  // Gate 6: Plugin allowlist check — only enforce when the effective allowlist is non-empty.
  // The GrowthBook ledger (tengu_harbor_ledger) returns [] for third-party providers,
  // which would block all plugins. We add $.length > 0 so an empty list = no enforcement.
  // If an org explicitly sets allowedChannelPlugins, those are always enforced (non-empty).
  //
  // Target: the inner if condition inside the !O.dev block:
  //   if (!$.some(A => A.plugin === O.name && A.marketplace === O.marketplace))
  //   → if ($.length > 0 && !$.some(A => A.plugin === O.name && A.marketplace === O.marketplace))
  //
  // The ledger variable ($ in 2.1.150) is captured as group 3 for reuse in gate 7.
  const pluginAllowlistInner = new RegExp(
    '(if\\s*\\()(!([\\w$]+)\\.some\\([\\w$]+\\s*=>\\s*[\\w$]+\\.plugin\\s*===\\s*[\\w$]+\\.name\\s*&&\\s*[\\w$]+\\.marketplace\\s*===\\s*[\\w$]+\\.marketplace\\))(\\)\\s*\\{)'
  );

  // Gate 7: Server allowlist — else-if for server-type channels.
  // Same logic: only enforce when ledger is non-empty. Target the else-if guard:
  //   } else if (!O.dev) {  →  } else if (!O.dev && Dw6().length > 0) {
  const serverAllowlistGuard = /(\}\s*else\s+if\s*\()(!\w+\.dev)(\)\s*\{)/;

  // Gate 1: Provider check — wrap in mod guard instead of removing.
  // When mod is enabled: condition is false → gate skipped.
  // When mod is disabled: condition is true → original gate executes.
  if (providerGate.test(code)) {
    code = code.replace(providerGate, (match) =>
      `if(!(typeof __isModEnabled__==="function"&&__isModEnabled__("unlock_channels"))){${match}} // [channels patch] provider gate wrapped`
    );
    changed++;
  }

  if (ffGate.test(code)) {
    code = code.replace(ffGate, (match) =>
      `if(!(typeof __isModEnabled__==="function"&&__isModEnabled__("unlock_channels"))){${match}} // [channels patch] feature flag gate wrapped`
    );
    changed++;
  }

  if (policyGate.test(code)) {
    code = code.replace(policyGate, (match) =>
      `if(!(typeof __isModEnabled__==="function"&&__isModEnabled__("unlock_channels"))){${match}} // [channels patch] policy gate wrapped`
    );
    changed++;
  }

  // Keep the disabled-status object scoped to the disabled branch.
  // The enabled path must return before any access to that object.
  if (statusBlock.test(code)) {
    code = code.replace(statusBlock, (match) =>
      `if(!(typeof __isModEnabled__==="function"&&__isModEnabled__("unlock_channels"))){${match}} // [channels patch] status block wrapped`
    );
    changed++;
  }

  // Gate 5: Capability stripper — wrap in mod guard instead of removing.
  if (capStripper.test(code)) {
    code = code.replace(capStripper, (match) =>
      `if(!(typeof __isModEnabled__==="function"&&__isModEnabled__("unlock_channels"))){${match}} // [channels patch] capability stripper wrapped`
    );
    changed++;
  }

  // Gate 6: Add empty-list guard to plugin allowlist inner condition.
  // Guarded by mod check: when disabled, original condition is preserved.
  let ledgerVar = "$"; // default: literal $ from original pattern
  let gate6Matched = false;
  if (pluginAllowlistInner.test(code)) {
    const m6 = code.match(pluginAllowlistInner);
    ledgerVar = m6[3]; // capture the ledger variable name from the some() call
    // When mod is enabled: add $.length > 0 guard.
    // When mod is disabled: original condition preserved.
    code = code.replace(pluginAllowlistInner,
      (match, p1, p2, p3, p4) =>
        `${p1}(typeof __isModEnabled__==="function"&&__isModEnabled__("unlock_channels")) ? ${ledgerVar}.length > 0 && ${p2} : ${p2}${p4} /* channels patch */`
    );
    gate6Matched = true;
    changed++;
  }

  // Gate 7: Add empty-list guard to server allowlist else-if condition.
  // Uses the ledger variable captured from gate 6 (not hardcoded Dw6).
  // Guarded by mod check: when disabled, original condition is preserved.
  // Gate 7 only applies when gate 6 matched — they share the ledger variable.
  // RATIONALE: Search from gate 6's insertion point to scope the regex to the
  // channels function. Without this, the unscoped regex could match unrelated
  // `else if (!X.dev)` patterns elsewhere in the bundle. Would need the channels
  // function to be restructured so that gate 7's anchor is no longer an else-if
  // to reconsider.
  if (gate6Matched) {
    const gate6Anchor = code.indexOf("/* channels patch */");
    if (gate6Anchor !== -1) {
      // Search only the region after gate 6 — still within the channels function.
      // Use a scoped copy to avoid matching unrelated else-if patterns elsewhere,
      // but cap at 2000 chars to avoid creating a huge substring.
      const searchLen = Math.min(code.length - gate6Anchor, 2000);
      const region = code.substring(gate6Anchor, gate6Anchor + searchLen);
      const m7 = serverAllowlistGuard.exec(region);
      if (m7) {
        const splicePos = gate6Anchor + m7.index;
        const replacement7 =
          `${m7[1]}(typeof __isModEnabled__==="function"&&__isModEnabled__("unlock_channels")) ? ${m7[2]} && ${ledgerVar}.length > 0 : ${m7[2]}${m7[3]} /* channels patch */`;
        code = code.substring(0, splicePos) + replacement7 + code.substring(splicePos + m7[0].length);
        changed++;
      }
    }
  }

  // Mark as patched. Anchor on the provider gate comment injected above,
  // then scan backward to find the enclosing function declaration.
  // Using the comment (not a minified name) avoids drift across releases.
  if (changed > 0) {
    const markerAnchor = code.indexOf("// [channels patch] provider gate wrapped");
    if (markerAnchor !== -1) {
      // Scan backward from the comment to find the enclosing function declaration
      const preceding = code.substring(Math.max(0, markerAnchor - 2000), markerAnchor);
      const fnMatch = preceding.match(/function\s+([\w$]+)\([^)]*\)\s*\{(?:[^}"'`]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)*$/);
      if (fnMatch) {
        // Insert the idempotency marker at the function declaration
        const fnDeclInPreceding = preceding.lastIndexOf("function " + fnMatch[1]);
        const absInsertPos = markerAnchor - preceding.length + fnDeclInPreceding;
        code = code.substring(0, absInsertPos) + "// __channels_unnerfed\n  " + code.substring(absInsertPos);
      } else {
        // Fallback: place marker just before the provider gate comment
        code = code.substring(0, markerAnchor) + "// __channels_unnerfed\n  " + code.substring(markerAnchor);
      }
    }
  }

  return { code, changed };
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-unlock-channels.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const fs = require("fs");
  const path = require("path");

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const { code: output, changed } = transform(code);

  if (changed === 0) {
    if (code.includes("__channels_unnerfed")) {
      console.error("Channels force-enable already applied; skipping.");
    } else {
      throw new Error("No matching channel gate blocks found — bundle may have drifted.");
    }
  } else {
    console.error(`Wrapped ${changed} channel gate block(s) in mod guards.`);
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

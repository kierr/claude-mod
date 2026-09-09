#!/usr/bin/env node

const MOD_ID = "unlock_advisor";
const ENABLE_MARKER = "/* __ADVISOR_ENABLE__ */";
const PAIRING_MARKER = "/* __ADVISOR_PAIRING__ */";
const CGK_MARKER = "/* __ADVISOR_CGK__ */";
const FGH_MARKER = "/* __ADVISOR_FGH__ */";

// Injection 1: match the explicit DISABLE-check block, capturing its leading
// indent so the injected guard reproduces it. Bounded: every line is matched
// explicitly with \n separators and [ \t]* (whitespace only, no newlines) —
// cannot run away.
//   <indent>if (FN(process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL)) {
//   <indent>  return false;
//   <indent>}
const DISABLE_BLOCK = /([ \t]*)if \(([\w$]+)\(process\.env\.CLAUDE_CODE_DISABLE_ADVISOR_TOOL\)\) \{\n[ \t]*return false;\n[ \t]*\}\n/;

// Injection 2: locate nGK's advisor-model bind, right before the first pairing
// check. Capture indent + the resolved-advisor var name + the logger name. The
// lookahead pins the match to the resolver by requiring the unique "base model"
// Skipping log on the next check — so a same-shape `let X = fn(...)` elsewhere
// cannot match — and captures the logger from that log so the injected guard
// reuses it instead of hardcoding a minified name that changes every release.
// [^;\n]* keeps the bind on one line (cannot run away across lines/newlines).
//   <indent>let <advisorVar> = <fn>(<args>);
//   <indent>if (!<fn>(<arg>)) { <logger>(`[AdvisorTool] Skipping advisor - base model ...
const PAIRING_ANCHOR = /([ \t]*)let ([\w$]+) = [\w$]+\([^;\n]*\);\n(?=[ \t]*if \(![\w$]+\([\w$]+\)\) \{\n[ \t]*([\w$]+)\(`\[AdvisorTool\] Skipping advisor - base model)/;

// Injection 3: cGK() is the chokepoint for wGH(main) and xmH(main,adv) — both
// open with `if (cGK()) return true;`. It is the unique zero-arg function whose
// entire body is `return <envObj>.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL;`.
// Match the signature line + the body indent (groups 1, 2), and verify the body
// via a bounded lookahead (no [\s\S]). Inject the guard right after the opening
// brace so it returns true before the env read. No minified names are captured.
//   function cGK() {
//   <indent>return nH.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL;
//   }
// The indent is captured INSIDE the lookahead (group 1) so m[0] is just the
// signature line — the guard is appended after `{`, leaving the original
// `return` (and its indent) untouched. Capturing the indent outside the
// lookahead would consume it, doubling the indent and de-indenting the return.
const CGK_ANCHOR = /function [\w$]+\(\) \{\n(?=([ \t]*)return [\w$]+\.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL;\n[ \t]*\})/;

// Injection 4: fGH(advisor) gates advisor validity — the mK_() picker filter
// (via sE6), the $W4 note, the slash validator h7T, and startup. It reads the
// experimental env var DIRECTLY (not via cGK), so gate 3 alone does not unblock
// it. Pin the match to fGH by requiring its signature shape (one param) followed
// immediately by the M4-style allowlist `if(!fn(x)){return false;}` and then the
// experimental-env `if(<obj>.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL)` —
// that sequence is unique to fGH (Pc is zero-arg and reads process.env via a
// truthiness helper, not <obj>.X). Bounded lookahead; no [\s\S].
//   function fGH(H) {
//   <indent>if (!M4(H)) {
//   <indent>  return false;
//   <indent>}
//   <indent>if (nH.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL) {
// Indent captured inside the lookahead (group 1) so m[0] is just the signature
// line — same reason as CGK_ANCHOR (avoids consuming/doubling the body indent).
const FGH_ANCHOR = /function [\w$]+\([\w$]+\) \{\n(?=([ \t]*)if \(![\w$]+\([\w$]+\)\) \{\n[ \t]*return false;\n[ \t]*\}\n[ \t]*if \([\w$]+\.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL\))/;

function transform(code) {
  let output = code;
  let changed = 0;

  // Injection 1 — Pc() master enable. Idempotent via the ENABLE marker.
  if (!code.includes(ENABLE_MARKER)) {
    const m = code.match(DISABLE_BLOCK);
    if (m) {
      const indent = m[1];
      const guard =
        `${indent}if (typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}")) {\n` +
        `${indent}  return true; ${ENABLE_MARKER}\n` +
        `${indent}}\n`;
      // Function replacer avoids $ interpretation in the guard.
      output = output.replace(m[0], () => m[0] + guard);
      changed++;
    } else {
      console.error("unlock_advisor: CLAUDE_CODE_DISABLE_ADVISOR_TOOL gate not found — bundle may have drifted.");
    }
  }

  // Injection 2 — nGK() pairing bypass. Idempotent via the PAIRING marker.
  if (!output.includes(PAIRING_MARKER)) {
    const m = output.match(PAIRING_ANCHOR);
    if (m) {
      const indent = m[1];
      const advisorVar = m[2];
      const logger = m[3];
      const guard =
        `${indent}if (typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}")) {\n` +
        `${indent}  ${logger}(\`[AdvisorTool] Server-side tool enabled with \${${advisorVar}} as the advisor model (pairing bypassed)\`);\n` +
        `${indent}  return ${advisorVar}; ${PAIRING_MARKER}\n` +
        `${indent}}\n`;
      output = output.replace(m[0], () => m[0] + guard);
      changed++;
    } else {
      console.error("unlock_advisor: nGK pairing resolver not found — bundle may have drifted (injection 1 still applied).");
    }
  }

  // Injection 3 — cGK() selection/UI chokepoint. Idempotent via the CGK marker.
  if (!output.includes(CGK_MARKER)) {
    const m = output.match(CGK_ANCHOR);
    if (m) {
      const indent = m[1];
      const guard =
        `${indent}if (typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}")) {\n` +
        `${indent}  return true; ${CGK_MARKER}\n` +
        `${indent}}\n`;
      output = output.replace(m[0], () => m[0] + guard);
      changed++;
    } else {
      console.error("unlock_advisor: cGK chokepoint not found — bundle may have drifted (injections 1-2 still applied).");
    }
  }

  // Injection 4 — fGH() advisor-validity gate. Idempotent via the FGH marker.
  if (!output.includes(FGH_MARKER)) {
    const m = output.match(FGH_ANCHOR);
    if (m) {
      const indent = m[1];
      const guard =
        `${indent}if (typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}")) {\n` +
        `${indent}  return true; ${FGH_MARKER}\n` +
        `${indent}}\n`;
      output = output.replace(m[0], () => m[0] + guard);
      changed++;
    } else {
      console.error("unlock_advisor: fGH validity gate not found — bundle may have drifted (injections 1-3 still applied).");
    }
  }

  return { code: output, changed };
}

/** CLI wrapper */
function main() {
  const fs = require("fs");
  const path = require("path");
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-unlock-advisor.cjs <input.js> [output.js]");
    process.exit(1);
  }
  const code = fs.readFileSync(path.resolve(inputFile), "utf8");
  const { code: output, changed } = transform(code);
  if (changed === 0) {
    if (code.includes(ENABLE_MARKER) && code.includes(CGK_MARKER) && code.includes(FGH_MARKER) && code.includes(PAIRING_MARKER)) {
      console.error("unlock_advisor already applied; skipping.");
    } else {
      console.error("unlock_advisor: no gates found — bundle may have drifted.");
    }
  } else {
    console.error(`unlock_advisor: injected ${changed} guard(s).`);
  }
  if (outputFile) {
    fs.writeFileSync(path.resolve(outputFile), output, "utf8");
  } else {
    process.stdout.write(output);
  }
}

if (require.main === module) {
  main();
}

module.exports = { transform };

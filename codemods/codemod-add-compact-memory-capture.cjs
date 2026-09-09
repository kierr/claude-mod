#!/usr/bin/env node
// Run memory capture before the summary using the same cache parameters and an isolated transcript.
// Capture failures must not prevent compaction. Tool and path checks stay local to the capture turn.

const MOD_ID = "add_compact_memory_capture";

// Idempotency marker. Written whenever the capture turn is injected.
const MARKER = "__cmc_patched__";

// Capture prompt. Inlined rather than config-stringified (a multi-line prompt
// in mods.json is awkward to edit). Tuned to elicit ONLY durable insights and
// explicitly exclude transient/derivable state.
const CAPTURE_PROMPT =
  "CRITICAL MEMORY CAPTURE: This conversation is about to be compacted and " +
  "its detail will be summarized away. Before that happens, durably capture " +
  "the insights worth keeping across sessions. Save ONLY: (1) user preferences, " +
  "working style, or feedback discovered; (2) project decisions and their " +
  "rationale; (3) non-obvious technical or domain context that would be " +
  "expensive to re-derive. Skip transient task state, in-progress work, and " +
  "anything derivable from code or git history. Be concise — one memory " +
  "per distinct insight. Then stop.";

/**
 * Locate the summary call, its context, and the message factory by stable keys.
 * Return null unless every required binding and insertion point is found.
 */
function discoverCompactVars(code) {
  // (1) Injection site + summary-call locals. The combination of
  //     querySource:"compact" + forkLabel:"compact" + maxTurns:1 is globally
  //     unique to the compaction summary fork. The `try {\n<indent>` before it
  //     is the insertion point (matched via lookahead so the original `let`
  //     statement is preserved verbatim).
  const callSiteRe =
    /try \{\n(\s+)(?=let ([\w$]+) = await ([\w$]+)\(\{\n\s+promptMessages: \[([\w$]+)\],\n\s+cacheSafeParams: ([\w$]+),\n\s+canUseTool: ([\w$]+)\(\),\n\s+querySource: "compact",\n\s+forkLabel: "compact",\n\s+maxTurns: 1,)/;
  const callSite = callSiteRe.exec(code);
  if (!callSite) return null;
  const indent = callSite[1];
  const callee = callSite[3]; // runForkedAgent (mG)
  const cacheSafeParams = callSite[5]; // T
  // callSite[2] = summary result var, [4] = promptMessages local, [6] = cp8

  // (2) streamCompactSummary signature -> context (K) + preCompactTokenCount (O).
  //     Destructured param keys are stable (they mirror the typed signature).
  const sigRe =
    /async function [\w$]+\(\{\n\s+messages: [\w$]+,\n\s+summaryRequest: [\w$]+,\n\s+appState: [\w$]+,\n\s+context: ([\w$]+),\n\s+preCompactTokenCount: ([\w$]+),\n\s+cacheSafeParams: ([\w$]+),/;
  const sig = sigRe.exec(code);
  if (!sig) return null;
  const context = sig[1]; // K
  const preCompactTokenCount = sig[2]; // O
  // Cross-check: the cacheSafeParams local at the call site must be the same
  // binding as in the signature (both are T). If they differ, the bundle shape
  // has changed in a way the codemod does not expect -> fail safe.
  if (sig[3] !== cacheSafeParams) return null;

  // (3) createUserMessage -> U6. The definition's destructured param keys
  //     (content / isMeta / isVisibleInTranscriptOnly / isVirtual /
  //     isCompactSummary) are stable across releases.
  const createUserRe =
    /function ([\w$]+)\(\{\n\s+content: [\w$]+,\n\s+isMeta: [\w$]+,\n\s+isVisibleInTranscriptOnly: [\w$]+,\n\s+isVirtual: [\w$]+,\n\s+isCompactSummary: [\w$]+,/;
  const createUser = createUserRe.exec(code);
  if (!createUser) return null;
  const createUserMessage = createUser[1]; // U6

  return {
    indent,
    callee,
    cacheSafeParams,
    context,
    preCompactTokenCount,
    createUserMessage,
    index: callSite.index,
    raw: callSite[0],
  };
}

/**
 * Build the injected capture-turn block. `names` carries the discovered
 * minified identifiers; every line is prefixed with the captured indentation
 * so the block slots into the existing try-body without reformatting.
 *
 * The canUseTool is inlined as a function expression so the entire patch is
 * one self-contained insertion (single injection point, trivially idempotent).
 */
function buildCaptureBlock(names) {
  const {
    indent,
    callee,
    cacheSafeParams,
    context,
    preCompactTokenCount,
    createUserMessage,
  } = names;

  // Relative-indented lines (base indent is prepended per-line at join time).
  const lines = [
    `if (typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}")) {`,
    `  var __cmcMinTokens = (typeof __getModConfig__ === "function" ? __getModConfig__("${MOD_ID}", "min_tokens", 20000) : 20000);`,
    `  if (${preCompactTokenCount} >= __cmcMinTokens) {`,
    `    try {`,
    `      await ${callee}({`,
    `        promptMessages: [${createUserMessage}({ content: "${CAPTURE_PROMPT}" })],`,
    `        cacheSafeParams: ${cacheSafeParams},`,
    `        canUseTool: async function(__cmcTool, __cmcInput) {`,
    `          try {`,
    `            var __cmcN = __cmcTool && __cmcTool.name;`,
    `            if (__cmcN === "Read" || __cmcN === "Glob" || __cmcN === "Grep" || __cmcN === "LS") {`,
    `              return { behavior: "allow", updatedInput: __cmcInput };`,
    `            }`,
    `            if (typeof __cmcN === "string" && __cmcN.indexOf("memory_") === 0) {`,
    `              return { behavior: "allow", updatedInput: __cmcInput };`,
    `            }`,
    `            if (__cmcN === "Edit" || __cmcN === "Write" || __cmcN === "MultiEdit" || __cmcN === "NotebookEdit") {`,
    `              var __cmcPath = (__cmcInput && (__cmcInput.file_path || __cmcInput.notebook_path)) || "";`,
    `              if (__cmcPath.indexOf("/.claude/projects/") !== -1 && __cmcPath.indexOf("/memory/") !== -1) {`,
    `                return { behavior: "allow", updatedInput: __cmcInput };`,
    `              }`,
    `              return { behavior: "deny", message: "[${MOD_ID}] write outside memory dir blocked", decisionReason: { type: "other", reason: "path scope: memory dir" } };`,
    `            }`,
    `            return { behavior: "deny", message: "[${MOD_ID}] only memory/read/write tools allowed", decisionReason: { type: "other", reason: "memory capture turn" } };`,
    `          } catch (__cmcE) {`,
    `            return { behavior: "deny", message: "[${MOD_ID}] canUseTool error: " + __cmcE };`,
    `          }`,
    `        },`,
    `        querySource: "compact",`,
    `        forkLabel: "memory_capture",`,
    `        maxTurns: (typeof __getModConfig__ === "function" ? __getModConfig__("${MOD_ID}", "max_turns", 8) : 8),`,
    `        skipCacheWrite: true,`,
    `        skipTranscript: true,`,
    `        overrides: { abortController: ${context}.abortController }`,
    `      });`,
    `    } catch (__cmcErr) {`,
    `      console.error("[${MOD_ID}] capture turn failed:", __cmcErr);`,
    `    }`,
    `  }`,
    `}`,
  ];

  // Join with newline + base indent so every line lands at the right column.
  // The replacement wraps this as:  "try {\n" + indent + <block> + "\n" + indent
  return lines.join("\n" + indent);
}

function transform(code) {
  // Idempotency: the MARKER is prepended only on a successful injection and is
  // the same signal the yaml applied-test checks, so the engine and the codemod
  // agree on "already applied". Re-running is a no-op. Prefer the MARKER over
  // the injected forkLabel string: forkLabel is a free-form enum value that
  // upstream could legitimately reuse, which would false-positive here.
  if (code.includes(MARKER)) {
    return { code, changed: 0 };
  }

  const names = discoverCompactVars(code);
  if (!names) {
    return { code, changed: 0 };
  }

  const block = buildCaptureBlock(names);

  // Insert the block right after the inner `try {\n<indent>` that precedes the
  // summary call, preserving the original `let R = await mG({` statement (it was
  // matched by lookahead, so only `try {\n<indent>` is consumed).
  const before = code.slice(0, names.index);
  const matched = names.raw; // "try {\n<indent>"
  const after = code.slice(names.index + matched.length);
  code =
    before +
    "try {\n" +
    names.indent +
    block +
    "\n" +
    names.indent +
    after;

  // Global marker so the engine's applied-status test is a cheap substring
  // check and so partial application is visible. Written only on success.
  if (!code.includes(MARKER)) {
    code = "var " + MARKER + " = true;\n" + code;
  }

  return { code, changed: 1 };
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-add-compact-memory-capture.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const fs = require("fs");
  const path = require("path");

  const inputPath = path.resolve(inputFile);
  const src = fs.readFileSync(inputPath, "utf8");

  const { code: output, changed } = transform(src);

  if (changed === 0) {
    if (src.includes(MARKER)) {
      console.error("Compact memory capture already applied; skipping.");
    } else {
      throw new Error("No matching targets found — bundle may have drifted.");
    }
  } else {
    console.error("Patched 1 target: injected memory-capture forked turn before compact summary.");
  }

  if (outputFile) {
    fs.writeFileSync(path.resolve(outputFile), output, "utf8");
  } else {
    process.stdout.write(output);
  }
}

module.exports = { transform, discoverCompactVars, buildCaptureBlock, CAPTURE_PROMPT };

if (require.main === module) {
  main();
}

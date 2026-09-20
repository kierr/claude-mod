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
 *
 * Supports both monolithic (2.1.181) and code-split (2.1.277+) bundles.
 * Code-split may wrap the call site in extra try/if blocks and has more
 * function parameters than the monolithic version.
 */
function discoverCompactVars(code) {
  // Strategy: find the unique anchor `forkLabel: "compact"` near
  // `querySource: "compact"` and `maxTurns: 1`, then discover the surrounding
  // call-site structure (callee, promptMessages, cacheSafeParams, canUseTool)
  // and the outer function signature (context, preCompactTokenCount, cacheSafeParams).

  // (1) Find the call site anchor: querySource:"compact" + forkLabel:"compact" + maxTurns:1
  //     These three together are globally unique to the compaction summary fork.
  const callAnchorRe =
    /promptMessages: \[([\w$]+)\],\n\s+cacheSafeParams: ([\w$]+),\n\s+canUseTool: ([\w$]+)\(\),\n\s+querySource: "compact",\n\s+forkLabel: "compact",\n\s+maxTurns: 1,/;
  const callAnchor = callAnchorRe.exec(code);
  if (!callAnchor) return null;
  const promptMessagesLocal = callAnchor[1];
  const cacheSafeParams = callAnchor[2];
  const canUseToolFn = callAnchor[3];

  // Find the `await CALLEE({` that precedes the call anchor.
  // Search backwards from the anchor for `await <ident>({`
  const anchorStart = callAnchor.index;
  const preceding = code.slice(Math.max(0, anchorStart - 500), anchorStart);
  const calleeRe = /await ([\w$]+)\(\{\n\s*$/;
  const calleeMatch = calleeRe.exec(preceding);
  if (!calleeMatch) return null;
  const callee = calleeMatch[1];

  // Find the `try {` indentation for the injection point.
  // The injection goes before the inner `try` that wraps the await call.
  // In code-split this inner `try` may be inside an `if (B) { try {` block.
  // We match the `try {\n<indent>` immediately before `let X = await callee({`
  const tryRe = new RegExp(
    '(try [{]\\n)(\\s+)(?=let [\\w$]+ = await ' + callee + '[(][{])'
  );
  const tryMatch = tryRe.exec(code);
  if (!tryMatch) return null;
  const indent = tryMatch[2];
  const injectionIndex = tryMatch.index;
  const injectionRaw = tryMatch[0]; // "try {\n<indent>"

  // (2) Find the function signature containing preCompactTokenCount and cacheSafeParams.
  //     We must find the one that CONTAINS the call site. Search backwards from
  //     the call anchor for the nearest `async function` with these destructured params.
  //     Multiple functions may have these params (code-split has several compaction
  //     functions), so we anchor to the one wrapping our call site.
  const anchorEnd = callAnchor.index + callAnchor[0].length;
  // Search backwards from call anchor for async function with preCompactTokenCount
  const precedingCode = code.slice(0, anchorEnd);
  // Find all async functions with preCompactTokenCount and cacheSafeParams in their
  // destructured params, then take the last one (nearest to the call site)
  const sigCandidates = [];
  const sigGlobalRe =
    /async function [\w$]+\(\{[\s\S]*?context: ([\w$]+),[\s\S]*?preCompactTokenCount: ([\w$]+),[\s\S]*?cacheSafeParams: ([\w$]+),/g;
  let sigMatch;
  while ((sigMatch = sigGlobalRe.exec(precedingCode)) !== null) {
    // Only keep candidates whose match ends before the call anchor
    if (sigMatch.index < anchorEnd) {
      sigCandidates.push({
        context: sigMatch[1],
        preCompactTokenCount: sigMatch[2],
        cacheSafeParams: sigMatch[3],
        index: sigMatch.index,
      });
    }
  }
  if (sigCandidates.length === 0) return null;
  // Take the last candidate (closest to call site)
  const sig = sigCandidates[sigCandidates.length - 1];
  const context = sig.context;
  const preCompactTokenCount = sig.preCompactTokenCount;
  const sigCacheSafeParams = sig.cacheSafeParams;
  // Cross-check: the cacheSafeParams local at the call site must be the same
  // binding as in the signature. If they differ, the bundle shape has changed
  // in a way the codemod does not expect -> fail safe.
  if (sigCacheSafeParams !== cacheSafeParams) return null;

  // (3) Find createUserMessage. The definition takes destructured params including
  //     content, isMeta, isCompactSummary. In code-split the param list is much
  //     longer. We match a function whose first two destructured params are
  //     content and isMeta, and which also has isCompactSummary somewhere.
  const createUserRe =
    /function ([\w$]+)\(\{\n\s+content: [\w$]+,\n\s+isMeta: [\w$]+,[\s\S]*?isCompactSummary: [\w$]+,/;
  const createUser = createUserRe.exec(code);
  if (!createUser) return null;
  const createUserMessage = createUser[1];

  return {
    indent,
    callee,
    cacheSafeParams,
    context,
    preCompactTokenCount,
    createUserMessage,
    index: injectionIndex,
    raw: injectionRaw,
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

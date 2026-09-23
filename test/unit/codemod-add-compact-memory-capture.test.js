import { describe, it, expect } from "bun:test";
import path from "path";

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-add-compact-memory-capture.cjs");
const { transform } = require(CODEMOD_PATH);

const PATCH_ID = "add_compact_memory_capture";
const TIMEOUT = 5000;

/**
 * Build a fixture mirroring the three anchor regions in the deobfuscated
 * bundle: createUserMessage definition, streamCompactSummary signature, and
 * the cache-sharing summary call. Configurable minified names verify the
 * codemod survives minifier renaming across releases.
 */
function buildFixture(names = {}) {
  const {
    createUser = "U6",
    contentParam = "Hc",
    isMetaParam = "_c",
    visibleParam = "qc",
    virtualParam = "Kc",
    compactSummaryParam = "Oc",
    summarizeParam = "Tc",
    streamFn = "xnK",
    messages = "H",
    summaryReq = "_",
    appState = "q",
    context = "K",
    preCompact = "O",
    cacheSafe = "T",
    stripEssential = "z",
    onResponse = "$",
    callee = "mG",
    resultVar = "R",
    denyFactory = "cp8",
    flagResolver = "Y_",
  } = names;

  return `  function ${denyFactory}() {
    return async () => ({ behavior: "deny", message: "Tool use is not allowed during compaction", decisionReason: { type: "other", reason: "compaction agent should only produce text summary" } });
  }
  function ${createUser}({
    content: ${contentParam},
    isMeta: ${isMetaParam},
    isVisibleInTranscriptOnly: ${visibleParam},
    isVirtual: ${virtualParam},
    isCompactSummary: ${compactSummaryParam},
    summarizeMetadata: ${summarizeParam}
  }) {
    return { type: "user", message: { role: "user", content: ${contentParam} }, uuid: "x" };
  }
  async function ${streamFn}({
    messages: ${messages},
    summaryRequest: ${summaryReq},
    appState: ${appState},
    context: ${context},
    preCompactTokenCount: ${preCompact},
    cacheSafeParams: ${cacheSafe},
    stripNonEssential: ${stripEssential} = false,
    onResponseLength: ${onResponse}
  }) {
    let Y = ${flagResolver}("tengu_compact_cache_prefix", true);
    try {
      if (Y) {
        try {
          let ${resultVar} = await ${callee}({
            promptMessages: [${summaryReq}],
            cacheSafeParams: ${cacheSafe},
            canUseTool: ${denyFactory}(),
            querySource: "compact",
            forkLabel: "compact",
            maxTurns: 1,
            maxOutputTokens: Math.min(sW_, azH(${context}.options.mainLoopModel)),
            skipCacheWrite: true,
            skipTranscript: true,
            overrides: { abortController: ${context}.abortController }
          });
          return ${resultVar};
        } catch (${resultVar}) {}
      }
      return null;
    } finally {}
  }
`;
}

describe("codemod-add-compact-memory-capture", () => {
  describe("injection", () => {
    it("should report changed=1 on a matching bundle", { timeout: TIMEOUT }, () => {
      const { changed } = transform(buildFixture());
      expect(changed).toBe(1);
    });

    it("should inject the memory_capture forked turn", { timeout: TIMEOUT }, () => {
      const { code } = transform(buildFixture());
      expect(code).toContain('forkLabel: "memory_capture"');
      expect(code).toContain("CRITICAL MEMORY CAPTURE");
    });

    it("should write the idempotency marker", { timeout: TIMEOUT }, () => {
      const { code } = transform(buildFixture());
      expect(code).toContain("__cmc_patched__");
    });
  });

  describe("reuse of discovered locals", () => {
    it("should reuse the discovered cacheSafeParams object", { timeout: TIMEOUT }, () => {
      const { code } = transform(buildFixture({ cacheSafe: "Q" }));
      // The capture turn must pass the SAME object as the summary turn.
      expect(code).toContain("cacheSafeParams: Q,");
    });

    it("should reuse the discovered context for abortController", { timeout: TIMEOUT }, () => {
      const { code } = transform(buildFixture({ context: "M" }));
      expect(code).toContain("abortController: M.abortController");
    });

    it("should gate on the discovered preCompactTokenCount local", { timeout: TIMEOUT }, () => {
      const { code } = transform(buildFixture({ preCompact: "P" }));
      expect(code).toContain("if (P >= __cmcMinTokens)");
    });

    it("should call the discovered runForkedAgent callee", { timeout: TIMEOUT }, () => {
      const { code } = transform(buildFixture({ callee: "rF2" }));
      expect(code).toContain("await rF2({");
    });

    it("should build the capture message via the discovered createUserMessage", { timeout: TIMEOUT }, () => {
      const { code } = transform(buildFixture({ createUser: "w1" }));
      expect(code).toContain('promptMessages: [w1({ content: "CRITICAL MEMORY CAPTURE');
    });

    it("should run the capture turn BEFORE the summary turn", { timeout: TIMEOUT }, () => {
      const { code } = transform(buildFixture());
      const captureIdx = code.indexOf('forkLabel: "memory_capture"');
      const summaryIdx = code.indexOf('forkLabel: "compact"');
      expect(captureIdx).toBeGreaterThan(-1);
      expect(summaryIdx).toBeGreaterThan(-1);
      expect(captureIdx).toBeLessThan(summaryIdx);
    });
  });

  describe("resilience across minified-name sets", () => {
    it("should apply with an entirely different name set", { timeout: TIMEOUT }, () => {
      const { code, changed } = transform(
        buildFixture({
          createUser: "mk",
          streamFn: "zQ",
          messages: "m1",
          summaryReq: "s1",
          appState: "a1",
          context: "ctx",
          preCompact: "ptc",
          cacheSafe: "csp",
          callee: "fork",
          resultVar: "res",
          denyFactory: "deny",
          flagResolver: "flag",
        }),
      );
      expect(changed).toBe(1);
      expect(code).toContain("cacheSafeParams: csp,");
      expect(code).toContain("abortController: ctx.abortController");
      expect(code).toContain("if (ptc >= __cmcMinTokens)");
      expect(code).toContain("await fork({");
      expect(code).toContain('promptMessages: [mk({ content: "CRITICAL MEMORY CAPTURE');
    });

    it("should fail safe when cacheSafeParams differs between signature and call site", { timeout: TIMEOUT }, () => {
      // Hand-craft a fixture where the signature uses T but the call site uses U
      // — the consistency cross-check must reject this (changed=0, no injection).
      const inconsistent = `  function U6({
    content: Hc,
    isMeta: _c,
    isVisibleInTranscriptOnly: qc,
    isVirtual: Kc,
    isCompactSummary: Oc,
    summarizeMetadata: Tc
  }) {
    return { type: "user", message: { role: "user", content: Hc } };
  }
  async function xnK({
    messages: H,
    summaryRequest: _,
    appState: q,
    context: K,
    preCompactTokenCount: O,
    cacheSafeParams: T,
    stripNonEssential: z = false
  }) {
    try {
      let R = await mG({
        promptMessages: [_],
        cacheSafeParams: U,
        canUseTool: cp8(),
        querySource: "compact",
        forkLabel: "compact",
        maxTurns: 1,
        skipCacheWrite: true
      });
    } catch (R) {}
  }
`;
      const { code, changed } = transform(inconsistent);
      expect(changed).toBe(0);
      expect(code).not.toContain('forkLabel: "memory_capture"');
    });
  });

  describe("canUseTool scoping", () => {
    it("should enumerate tool names and deny default", { timeout: TIMEOUT }, () => {
      const { code } = transform(buildFixture());
      // Every gated tool name appears as an equality check.
      for (const t of ["Read", "Glob", "Grep", "LS", "Edit", "Write", "NotebookEdit", "MultiEdit"]) {
        expect(code).toContain(`__cmcN === "${t}"`);
      }
      expect(code).toContain('__cmcN.indexOf("memory_") === 0');
      expect(code).toContain('behavior: "deny"');
      expect(code).toContain("max_turns");
      expect(code).toContain("min_tokens");
      // Write tools are gated by a memory-dir path check.
      expect(code).toContain('"/.claude/projects/"');
      expect(code).toContain('"/memory/"');
    });

    // Exercise the ACTUAL injected canUseTool (extracted from the generated
    // block and eval'd) so the path-scope logic is verified by behavior, not
    // just string presence.
    function extractCanUseTool(code) {
      const m = code.match(/canUseTool: (async function\(__cmcTool, __cmcInput\) \{[\s\S]*?\})[ \t]*,\n[ \t]*querySource:/);
      if (!m) throw new Error("canUseTool function not found in generated code");
      return new Function("return " + m[1])();
    }

    it("allows reads anywhere (non-destructive)", async () => {
      const fn = extractCanUseTool(transform(buildFixture()).code);
      await expect(fn({ name: "Read" }, { file_path: "/etc/anything" })).resolves.toMatchObject({ behavior: "allow" });
      await expect(fn({ name: "Glob" }, { pattern: "*" })).resolves.toMatchObject({ behavior: "allow" });
    });

    it("allows writes only inside the memory dir", async () => {
      const fn = extractCanUseTool(transform(buildFixture()).code);
      const inDir = "/Users/u/.claude/projects/-proj/memory/foo.md";
      await expect(fn({ name: "Edit" }, { file_path: inDir })).resolves.toMatchObject({ behavior: "allow" });
      await expect(fn({ name: "Write" }, { file_path: inDir })).resolves.toMatchObject({ behavior: "allow" });
      await expect(fn({ name: "MultiEdit" }, { file_path: inDir })).resolves.toMatchObject({ behavior: "allow" });
      await expect(fn({ name: "NotebookEdit" }, { notebook_path: inDir.replace(/\.md$/, ".ipynb") })).resolves.toMatchObject({ behavior: "allow" });
    });

    it("denies writes outside the memory dir (blast-radius containment)", async () => {
      const fn = extractCanUseTool(transform(buildFixture()).code);
      await expect(fn({ name: "Edit" }, { file_path: "/etc/passwd" })).resolves.toMatchObject({ behavior: "deny" });
      await expect(fn({ name: "Write" }, { file_path: "/Users/me/.zshrc" })).resolves.toMatchObject({ behavior: "deny" });
      // A path that mentions "memory" but is not under .claude/projects is still denied.
      await expect(fn({ name: "Write" }, { file_path: "/tmp/memory/evil" })).resolves.toMatchObject({ behavior: "deny" });
      // Missing path entirely.
      await expect(fn({ name: "Write" }, {})).resolves.toMatchObject({ behavior: "deny" });
    });

    it("allows memory_* tools by prefix, denies arbitrary tools", async () => {
      const fn = extractCanUseTool(transform(buildFixture()).code);
      await expect(fn({ name: "memory_save" }, {})).resolves.toMatchObject({ behavior: "allow" });
      await expect(fn({ name: "Bash" }, {})).resolves.toMatchObject({ behavior: "deny" });
      await expect(fn({ name: "Task" }, {})).resolves.toMatchObject({ behavior: "deny" });
    });
  });

  describe("safety wrapper", () => {
    it("should wrap the capture call in try/catch that logs", { timeout: TIMEOUT }, () => {
      const { code } = transform(buildFixture());
      expect(code).toContain("catch (__cmcErr)");
      expect(code).toContain("capture turn failed");
    });

    it("should be gated by __isModEnabled__", { timeout: TIMEOUT }, () => {
      const { code } = transform(buildFixture());
      expect(code).toContain('typeof __isModEnabled__ === "function"');
      expect(code).toContain('__isModEnabled__("add_compact_memory_capture")');
    });
  });

  describe("idempotency", () => {
    it("should return changed=0 on second application", { timeout: TIMEOUT }, () => {
      const first = transform(buildFixture());
      expect(first.changed).toBe(1);
      const second = transform(first.code);
      expect(second.changed).toBe(0);
    });

    it("should produce identical output on repeated runs", { timeout: TIMEOUT }, () => {
      const once = transform(buildFixture()).code;
      const twice = transform(once).code;
      const thrice = transform(twice).code;
      expect(once).toBe(twice);
      expect(twice).toBe(thrice);
    });
  });

  describe("no-match cases", () => {
    it("should not transform code without targets", { timeout: TIMEOUT }, () => {
      const input = `function test() { return true; }`;
      const { code, changed } = transform(input);
      expect(changed).toBe(0);
      expect(code).toBe(input);
    });

    it("should not transform empty code", { timeout: TIMEOUT }, () => {
      const { code, changed } = transform("");
      expect(changed).toBe(0);
      expect(code).toBe("");
    });

    it("should not transform when only the deny-message anchor is missing the call site", { timeout: TIMEOUT }, () => {
      // Has createUserMessage + signature but no summary call -> no injection point.
      const partial = `  function U6({ content: Hc, isMeta: _c, isVisibleInTranscriptOnly: qc, isVirtual: Kc, isCompactSummary: Oc }) { return {}; }
  async function xnK({ messages: H, summaryRequest: _, appState: q, context: K, preCompactTokenCount: O, cacheSafeParams: T }) { return null; }
`;
      const { code, changed } = transform(partial);
      expect(changed).toBe(0);
    });
  });

  describe("patch YAML status_test regex round-trip", () => {
    const { assertAppliedRegex, getApplicableRegex } = require("./test-helpers.cjs");

    it("applied regex should match patched output", { timeout: TIMEOUT }, () => {
      const { code } = transform(buildFixture());
      assertAppliedRegex(PATCH_ID, code);
    });

    it("applicable regex should match unpatched fixture", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const applicableRegex = getApplicableRegex(PATCH_ID);
      expect(applicableRegex).not.toBeNull();
      // The applicable anchor is the deny-all message, present in the fixture.
      expect(applicableRegex.test(input)).toBe(true);
    });
  });
});

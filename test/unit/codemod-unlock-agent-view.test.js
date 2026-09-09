import { describe, it, expect } from "bun:test";

const { transform } = require("../../codemods/codemod-unlock-agent-view.cjs");

/**
 * Build a Patch A V1 fixture (<= 2.1.143): single-line return with || chain.
 */
function buildPatchAInput(names = {}) {
  const fn = names.fn || "xWH";
  const sh = names.sh || "SH";
  const vs = names.vs || "VS";
  const nn = names.nn || "NN1";
  return `  function ${fn}() {
    return ${sh}(process.env.CLAUDE_CODE_DISABLE_AGENT_VIEW) || ${vs}()?.settings.disableAgentView === true || ${nn}();
  }`;
}

/**
 * Build a Patch A V2 fixture (>= 2.1.144): multi-line if/return with reason strings.
 */
function buildPatchAV2Input(names = {}) {
  const fn = names.fn || "iV3";
  const envFn = names.envFn || "aH";
  const settingsFn = names.settingsFn || "bK";
  return `  function ${fn}() {
    if (${envFn}(process.env.CLAUDE_CODE_DISABLE_AGENT_VIEW)) {
      return "is disabled by CLAUDE_CODE_DISABLE_AGENT_VIEW";
    }
    if (${settingsFn}()?.settings.disableAgentView === true) {
      return "is disabled by the 'disableAgentView' setting";
    }
    return null;
  }`;
}

function buildPatchBInput(names = {}) {
  const fn = names.fn || "yc";
  const xwh = names.xwh || "xWH";
  const q7 = names.q7 || "Q7";
  const d = names.d || "D_";
  return `  function ${fn}() {
    return !${xwh}() && (${q7}() || ${d}("tengu_slate_meadow", false));
  }`;
}

describe("codemod-unlock-agent-view", () => {
  describe("Patch A: disable-check gate", () => {
    it("should replace disable-check function body with return false", () => {
      const input = buildPatchAInput();
      const { code, changed } = transform(input);

      expect(changed).toBe(1);
      expect(code).toContain("return false; /* __AVFE__ */");
      // Mod guard wrapping preserves original body (restored when mod disabled)
      expect(code).toContain("CLAUDE_CODE_DISABLE_AGENT_VIEW");
      expect(code).toContain("__isModEnabled__(\"unlock_agent_view\")");
    });

    it("should work with different minified names", () => {
      const input = buildPatchAInput({ fn: "ZB9", sh: "Kk", vs: "Pp2", nn: "MM" });
      const { code, changed } = transform(input);

      expect(changed).toBe(1);
      expect(code).toContain("return false; /* __AVFE__ */");
    });

    it("should preserve function name in replacement", () => {
      const input = buildPatchAInput({ fn: "myFunc" });
      const { code } = transform(input);

      expect(code).toContain("function myFunc()");
    });

    it("should preserve indentation", () => {
      const input = buildPatchAInput();
      const { code } = transform(input);

      expect(code).toMatch(/^  function \w+\(\)/m);
    });

    it("should not match already-patched code", () => {
      const input = buildPatchAInput();
      const first = transform(input);
      const second = transform(first.code);

      expect(second.changed).toBe(0);
      expect(second.code).toBe(first.code);
    });

    it("should match 2.1.141+ pattern (no third || term)", () => {
      // 2.1.141 simplified the function to just two terms
      const input = `  function MpH() {
    return CH(process.env.CLAUDE_CODE_DISABLE_AGENT_VIEW) || rS()?.settings.disableAgentView === true;
  }`;
      const { code, changed } = transform(input);

      expect(changed).toBe(1);
      expect(code).toContain("return false; /* __AVFE__ */");
      // Mod guard wrapping preserves original body
      expect(code).toContain("CLAUDE_CODE_DISABLE_AGENT_VIEW");
    });
  });

  describe("Patch A V2: multi-line if/return (>= 2.1.144)", () => {
    it("should wrap multi-line disable-check function with mod guard", () => {
      const input = buildPatchAV2Input();
      const { code, changed } = transform(input);

      expect(changed).toBe(1);
      // V2 returns null (not false) when mod is enabled
      expect(code).toContain("return null; /* __AVFE__ */");
      // Mod guard wrapping preserves original body (restored when mod disabled)
      expect(code).toContain("CLAUDE_CODE_DISABLE_AGENT_VIEW");
      expect(code).toContain("disableAgentView");
      expect(code).toContain("__isModEnabled__(\"unlock_agent_view\")");
    });

    it("should preserve function name in V2 replacement", () => {
      const input = buildPatchAV2Input({ fn: "myCheck" });
      const { code } = transform(input);

      expect(code).toContain("function myCheck()");
    });

    it("should work with different minified names in V2", () => {
      const input = buildPatchAV2Input({ fn: "Z9x", envFn: "eN", settingsFn: "sT" });
      const { code, changed } = transform(input);

      expect(changed).toBe(1);
      expect(code).toContain("return null; /* __AVFE__ */");
    });

    it("should be idempotent for V2", () => {
      const input = buildPatchAV2Input();
      const first = transform(input);
      const second = transform(first.code);

      expect(second.changed).toBe(0);
      expect(second.code).toBe(first.code);
    });
  });

  describe("Patch B: GrowthBook/fleet gate", () => {
    it("should replace fleet gate function body with return true", () => {
      const input = buildPatchBInput();
      const { code, changed } = transform(input);

      expect(changed).toBe(1);
      expect(code).toContain("return true; /* __AVFE__ */");
      // Mod guard wrapping preserves original body (restored when mod disabled)
      expect(code).toContain("tengu_slate_meadow");
      expect(code).toContain("__isModEnabled__(\"unlock_agent_view\")");
    });

    it("should work with different minified names", () => {
      const input = buildPatchBInput({ fn: "AB", xwh: "Z9", q7: "QR", d: "Ff" });
      const { code, changed } = transform(input);

      expect(changed).toBe(1);
      expect(code).toContain("return true; /* __AVFE__ */");
    });

    it("should not match already-patched code", () => {
      const input = buildPatchBInput();
      const first = transform(input);
      const second = transform(first.code);

      expect(second.changed).toBe(0);
    });
  });

  describe("Combined transform", () => {
    it("should apply both patches and report changed=2", () => {
      const input = buildPatchAInput() + "\n" + buildPatchBInput();
      const { code, changed } = transform(input);

      expect(changed).toBe(2);
      expect(code).toContain("return false; /* __AVFE__ */");
      expect(code).toContain("return true; /* __AVFE__ */");
    });

    it("should return changed=0 when nothing matches", () => {
      const input = "const x = 42;";
      const { code, changed } = transform(input);

      expect(changed).toBe(0);
      expect(code).toBe(input);
    });

    it("should handle patch A only (patch B absent, 2.1.141+ pattern)", () => {
      // 2.1.141+: Patch A (2-term) without Patch B (tengu_slate_meadow removed)
      const input = `  function MpH() {
    return CH(process.env.CLAUDE_CODE_DISABLE_AGENT_VIEW) || rS()?.settings.disableAgentView === true;
  }
  function DF() {
    return !MpH();
  }`;
      const { code, changed } = transform(input);

      expect(changed).toBe(1);
      expect(code).toContain("return false; /* __AVFE__ */");
      // DF() is untouched — it returns !MpH() which is now !false = true
      expect(code).toContain("return !MpH()");
    });
  });
});

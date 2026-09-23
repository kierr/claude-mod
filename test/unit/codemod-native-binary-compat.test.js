import { describe, it, expect } from "bun:test";
import path from "path";

const parser = require(path.join(process.cwd(), "codemods/node_modules/@babel/parser"));

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-native-binary-compat.cjs");
const { transform } = require(CODEMOD_PATH);

const PATCH_ID = "native_binary_compat";
const TIMEOUT = 5000;

/**
 * Build a fixture matching both patch targets. Configurable minified names
 * ([\w$]+-safe) to verify resilience across releases.
 */
function buildFixture(names = {}) {
  const {
    fzName = "Fz",
    useStateObj = "$C6",
    xyName = "xY",
    zjName = "Zj",
    lqName = "Lq",
    s8Name = "S8",
    yHName = "yH",
  } = names;

  return `  function ${fzName}() {
    return Array.isArray(Bun.embeddedFiles) && Bun.embeddedFiles.length > 0;
  }
  async function RgH(H) {
    try {
      return !!(await $Y(H));
    } catch {
      return false;
    }
  }
  function ${zjName}() { return true; }
  function ${lqName}() { return false; }
  function ${xyName}(opts) { return { key: null, source: null }; }
  function ${yHName}(str) {}
  function jT4() {
    let [H, _] = ${useStateObj}.useState(() => {
      if (!${zjName}() || ${lqName}()) {
        return "valid";
      }
      let {
        key: K,
        source: O
      } = ${xyName}({
        skipRetrievingKeyFromApiKeyHelper: true
      });
      if (K || O === "apiKeyHelper") {
        return "loading";
      }
      return "missing";
    });
    let q = ${useStateObj}.useCallback(async () => {
      if (!${zjName}() || ${lqName}()) { _("valid"); return; }
      await RgH(${s8Name}());
      let { key: K, source: O } = ${xyName}();
      if (!K) { _("missing"); return; }
      _("valid");
    }, []);
    return { status: H, reverify: q };
  }
`;
}

describe("codemod-native-binary-compat", () => {
  describe("Patch A — Fz()/EA() forced true", () => {
    it("should wrap the Bun.embeddedFiles return with a mod guard", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code, changed } = transform(input);

      expect(changed).toBeGreaterThanOrEqual(1);
      expect(code).toContain('__isModEnabled__("native_binary_compat")) || Array.isArray(Bun.embeddedFiles)');
      expect(code).toContain("Array.isArray(Bun.embeddedFiles) && Bun.embeddedFiles.length > 0");
    });

    it("should handle dollar-bearing minified names", { timeout: TIMEOUT }, () => {
      const input = buildFixture({ fzName: "$EA" });
      const { code, changed } = transform(input);

      expect(changed).toBeGreaterThanOrEqual(1);
      expect(code).toContain("__isModEnabled__");
    });

    it("should NOT patch a non-return Bun.embeddedFiles usage", { timeout: TIMEOUT }, () => {
      const input = `function Fz() {
    let x = Array.isArray(Bun.embeddedFiles) && Bun.embeddedFiles.length > 0;
    return x;
  }`;
      // Patch A finds no `return ...embeddedFiles;` line; Patch B also absent → 0 changes.
      const { changed } = transform(input);
      expect(changed).toBe(0);
    });
  });

  describe("Patch B — auth status missing → loading", () => {
    it("should change return 'missing' to mod-guarded loading in useState callback", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code, changed } = transform(input);

      expect(changed).toBeGreaterThanOrEqual(1);
      const useStateStart = code.indexOf("useState(() => {");
      expect(useStateStart).toBeGreaterThan(-1);
      const block = code.substring(useStateStart, useStateStart + 700);
      expect(block).toContain('__isModEnabled__("native_binary_compat")) ? "loading" : "missing"');
    });

    it("should preserve the reverify callback's _('missing')", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);
      expect(code).toContain('_("missing")');
    });

    it("should work with different minified names", { timeout: TIMEOUT }, () => {
      const input = buildFixture({ useStateObj: "React", xyName: "getKey", zjName: "hasAuth", lqName: "isExempt" });
      const { code, changed } = transform(input);
      expect(changed).toBe(2);
      expect(code).toContain("React.useState");
    });
  });

  describe("both patches", () => {
    it("should report changed=2 when both apply", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { changed } = transform(input);
      expect(changed).toBe(2);
    });

    it("should produce syntactically valid JS", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);
      expect(() => parser.parse(code, { sourceType: "module" })).not.toThrow();
    });
  });

  describe("idempotency", () => {
    it("should return changed=0 on second application", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const first = transform(input);
      expect(first.changed).toBe(2);
      const second = transform(first.code);
      expect(second.changed).toBe(0);
    });

    it("should produce identical output on repeated runs", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const once = transform(input).code;
      const twice = transform(once).code;
      expect(once).toBe(twice);
    });
  });

  describe("no-match cases", () => {
    it("should not transform code without either target", { timeout: TIMEOUT }, () => {
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
  });

  describe("patch YAML status_test regex round-trip", () => {
    const { assertAppliedRegex, getApplicableRegex } = require("./test-helpers.cjs");

    it("applied regex should match patched output", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);
      assertAppliedRegex(PATCH_ID, code);
    });

    it("applicable regex should match unpatched fixture", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const applicableRegex = getApplicableRegex(PATCH_ID);
      expect(applicableRegex).not.toBeNull();
      expect(applicableRegex.test(input)).toBe(true);
    });
  });
});

import { describe, it, expect } from "bun:test";
import path from "path";

const parser = require(path.join(process.cwd(), "codemods/node_modules/@babel/parser"));

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-set-flags-and-policy.cjs");
const { transform } = require(CODEMOD_PATH);

const PATCH_ID = "set_flags_and_policy";

// Regex-based codemods run in-process — no Babel spawn overhead
const TIMEOUT = 5000;

/**
 * Build a realistic GrowthBook resolver module snippet with configurable
 * minified names. This verifies the codemod works regardless of what names
 * webcrack produces each release.
 *
 * @param {object} names - Minified name overrides
 * @returns {string} Fixture code
 */
function buildFixture(names = {}) {
  const {
    nk6Name = "nk6",
    nk6Flag = "GE_",
    nk6Return = "GE_",
    ik6Name = "ik6",
    resolverName = "WI",
    growthBookObj = "ZI",
    defaultFlagFn = "z",
    v7Name = "V7",
    h67Name = "H67",
    bx5Name = "BX5",
    pX5Name = "pX5",
  } = names;

  // Simulate the GrowthBook resolver module structure:
  // nk6() is the env-override stub (if (!VAR) { VAR = true; } return VAR2;)
  // ik6() is the mods-override stub (return;) — this is what gets replaced
  // Then the resolver body referencing cachedGrowthBookFeatures
  // V7() is the policy gate resolver — also gets patched
  return `function ${nk6Name}() {
  if (!${nk6Flag}) {
    ${nk6Flag} = true;
  }
  return ${nk6Return};
}

function ${ik6Name}() {
  return;
}

function ${resolverName}(K) {
  var z = ${nk6Name}();
  var v = ${ik6Name}();
  if (z !== null) return z;
  if (v !== null) return v;
  var cached = ${growthBookObj}.cachedGrowthBookFeatures?.[K];
  if (cached !== undefined) return cached;
  return ${defaultFlagFn}(K);
}

function ${v7Name}(H) {
    let _ = ${h67Name}();
    if (!_) {
      if (${bx5Name}.has(H)) {
        return false;
      }
      return true;
    }
    let q = _[H];
    if (q) {
      return q.allowed;
    }
    let K = []?.compliance_taints ?? [];
    for (let [O, T] of ${pX5Name}) {
      if (T === H && K.includes(O)) {
        return false;
      }
    }
    return true;
  }`;
}

describe("codemod-set-flags-and-policy", () => {
  describe("basic transformation", () => {
    it("should replace the ik6() return; stub with mods.json reader", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code, changed } = transform(input);

      expect(changed).toBe(2);
      expect(code).toContain("typeof __modsLoad__");
      expect(code).toContain("__ff_fk");
      expect(code).toContain("feature_flags_");
    });

    it("should inject __modsLoad__() call", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);

      expect(code).toContain('typeof __modsLoad__ === "function"');
      expect(code).toContain("__modsLoad__()");
    });

    it("should preserve the nk6() function unchanged", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);

      expect(code).toMatch(/function nk6\(\)\s*\{\s*if\s*\(!GE_\)\s*\{/);
      expect(code).toContain("return GE_;");
    });

    it("should preserve the resolver function structure", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);

      expect(code).toContain("cachedGrowthBookFeatures");
      expect(code).toContain("function WI(K)");
    });

    it("should preserve the ik6() function name", { timeout: TIMEOUT }, () => {
      const input = buildFixture({ ik6Name: "ik6" });
      const { code } = transform(input);

      expect(code).toMatch(/function ik6\(\)/);
    });
  });

  describe("minified name resilience", () => {
    it("should work with different minified names (release A)", { timeout: TIMEOUT }, () => {
      const input = buildFixture({
        nk6Name: "ZB1",
        nk6Flag: "seen",
        nk6Return: "seen",
        ik6Name: "pQ3",
        resolverName: "KR9",
        growthBookObj: "GB",
        defaultFlagFn: "dfl",
      });
      const { code, changed } = transform(input);

      expect(changed).toBe(2);
      expect(code).toContain("typeof __modsLoad__");
      expect(code).toMatch(/function pQ3\(\)/);
      expect(code).toContain("function ZB1()");
      expect(code).toContain("cachedGrowthBookFeatures");
    });

    it("should work with different minified names (release B)", { timeout: TIMEOUT }, () => {
      const input = buildFixture({
        nk6Name: "x7",
        nk6Flag: "_init",
        nk6Return: "_init",
        ik6Name: "m2",
        resolverName: "resolve",
        growthBookObj: "ctx",
        defaultFlagFn: "def",
      });
      const { code, changed } = transform(input);

      expect(changed).toBe(2);
      expect(code).toContain("typeof __modsLoad__");
      expect(code).toMatch(/function m2\(\)/);
    });

    it("should work with single-letter minified names", { timeout: TIMEOUT }, () => {
      const input = buildFixture({
        nk6Name: "a",
        nk6Flag: "b",
        nk6Return: "b",
        ik6Name: "c",
        resolverName: "d",
        growthBookObj: "e",
        defaultFlagFn: "f",
      });
      const { code, changed } = transform(input);

      expect(changed).toBe(2);
      expect(code).toContain("typeof __modsLoad__");
      expect(code).toMatch(/function c\(\)/);
    });

    it("should work with underscore-containing names", { timeout: TIMEOUT }, () => {
      const input = buildFixture({
        nk6Name: "_init",
        nk6Flag: "_seen",
        nk6Return: "_seen",
        ik6Name: "_stub",
        resolverName: "_resolve",
      });
      const { code, changed } = transform(input);

      expect(changed).toBe(2);
      expect(code).toContain("typeof __modsLoad__");
      expect(code).toMatch(/function _stub\(\)/);
    });

    it("should work when nk6Flag and nk6Return are different variables", { timeout: TIMEOUT }, () => {
      // Some releases may have flag and return as different variables
      const input = buildFixture({
        nk6Name: "fn1",
        nk6Flag: "initialized",
        nk6Return: "result",
      });
      const { code, changed } = transform(input);

      expect(changed).toBe(2);
      expect(code).toContain("typeof __modsLoad__");
    });
  });

  describe("fail-closed safety", () => {
    it("should include typeof guard before calling __modsLoad__", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);

      const typeofIndex = code.indexOf('typeof __modsLoad__');
      const callIndex = code.indexOf("__modsLoad__()");
      expect(typeofIndex).toBeGreaterThan(-1);
      expect(callIndex).toBeGreaterThan(-1);
      expect(typeofIndex).toBeLessThan(callIndex);
    });

    it("should fall back to return; when __modsLoad__ is not a function", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);

      // The replacement body should end with a bare `return;` as fallback
      // when __modsLoad__ is missing or returns no feature_flags_ keys
      expect(code).toMatch(/return;\s*\}/);
    });

    it("patched code should be syntactically valid JS", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);

      try {
        parser.parse(code, { sourceType: "module" });
      } catch (e) {
        throw new Error(`Output is not valid JS: ${e.message}\n${code.substring(0, 500)}`);
      }
    });
  });

  describe("injected code structure", () => {
    it("should build the per-flag mods.json key with the feature_flags_ prefix", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);

      // The injected code does a direct per-flag lookup (redesigned from
      // the old prefix-scan: no __ff_k/__ff_out/__ff_count loop).
      expect(code).toContain('__ff_fk = "feature_flags_" + K');
      expect(code).toContain('if (__ff_fk in __ff_cfg)');
    });

    it("should only return an override when the flag key exists", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);

      // Direct key-membership check (redesigned from the old __ff_count>0 gate).
      expect(code).toContain("if (__ff_fk in __ff_cfg)");
      expect(code).toMatch(/return \{ value: __ff_raw, source: "mod" \}/);
    });

    it("should use var declarations (no let/const for CJS compat)", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);

      // All injected vars should use var, not let/const
      const injectedSection = code.substring(
        code.indexOf("typeof __modsLoad__"),
        code.indexOf("__ff_fk") + 800
      );
      expect(injectedSection).not.toContain("let ");
      expect(injectedSection).not.toContain("const ");
      expect(injectedSection).toContain("var ");
    });

    it("should include object-wrapping for gate flags", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);

      // Gate flags (tengu_onyx_plover, tengu_herring_clock) need {enabled, available}
      expect(code).toContain("__ff_wrap");
      expect(code).toContain("tengu_onyx_plover");
      expect(code).toContain("tengu_herring_clock");
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
      const thrice = transform(twice).code;

      expect(once).toBe(twice);
      expect(twice).toBe(thrice);
    });

    it("should not modify code that already contains __ff_prefix and __ff_cfg", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const patched = transform(input).code;

      // Simulate re-patching scenario: code already has both markers
      const result = transform(patched);
      expect(result.changed).toBe(0);
      expect(result.code).toBe(patched);
    });
  });

  describe("no-match cases", () => {
    it("should not transform code without cachedGrowthBookFeatures", { timeout: TIMEOUT }, () => {
      // Build a fixture with the nk6+ik6 pattern but no cachedGrowthBookFeatures nearby
      const input = `function nk6() {
  if (!GE_) {
    GE_ = true;
  }
  return GE_;
}

function ik6() {
  return;
}

function unrelatedResolver(K) {
  return z(K);
}`;
      const { code, changed } = transform(input);

      expect(changed).toBe(0);
      expect(code).toBe(input);
    });

    it("should not transform code without the nk6() stub pattern", { timeout: TIMEOUT }, () => {
      const input = `function someOther() {
  return;
}

var x = cachedGrowthBookFeatures;`;
      const { code, changed } = transform(input);

      expect(changed).toBe(0);
      expect(code).toBe(input);
    });

    it("should not transform empty code", { timeout: TIMEOUT }, () => {
      const { code, changed } = transform("");

      expect(changed).toBe(0);
      expect(code).toBe("");
    });

    it("should not transform code with only cachedGrowthBookFeatures", { timeout: TIMEOUT }, () => {
      const input = `var x = "cachedGrowthBookFeatures";`;
      const { code, changed } = transform(input);

      expect(changed).toBe(0);
      expect(code).toBe(input);
    });

    it("should not match when ik6 is too far from cachedGrowthBookFeatures", { timeout: TIMEOUT }, () => {
      // nk6+ik6 pattern exists but cachedGrowthBookFeatures is >500 chars away from ik6
      const padding = " ".repeat(600);
      const input = `function nk6() {
  if (!GE_) {
    GE_ = true;
  }
  return GE_;
}

function ik6() {
  return;
}
${padding}
var x = cachedGrowthBookFeatures;`;
      const { code, changed } = transform(input);

      expect(changed).toBe(0);
      expect(code).toBe(input);
    });
  });

  describe("patch YAML status_test regex round-trip", () => {
    const { assertAppliedRegex } = require("./test-helpers.cjs");

    it("applied regex should match patched output", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);

      assertAppliedRegex(PATCH_ID, code);
    });

    it("applicable regex should match unpatched fixture", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const applicableRegex = require("./test-helpers.cjs").getApplicableRegex(PATCH_ID);

      expect(applicableRegex).not.toBeNull();
      expect(applicableRegex.test(input)).toBe(true);
    });

    it("applicable regex persists post-patch (anchor-based check)", { timeout: TIMEOUT }, () => {
      // The applicable regex for this patch is `cachedGrowthBookFeatures` — it
      // identifies the GrowthBook module by a stable string anchor. The codemod
      // does not remove this anchor, so the applicable regex still matches
      // post-patch output. This is by design: applicable means "contains the
      // target module", not "contains the pre-patch stub". The applied regex
      // (__ff_prefix) is the reliable "already patched" signal.
      const input = buildFixture();
      const { code } = transform(input);
      const applicableRegex = require("./test-helpers.cjs").getApplicableRegex(PATCH_ID);

      // The anchor persists — this is expected for string-anchor-based applicable checks
      expect(applicableRegex.test(code)).toBe(true);
      // The applied regex is the true "is it patched?" signal
      assertAppliedRegex(PATCH_ID, code);
    });
  });
});

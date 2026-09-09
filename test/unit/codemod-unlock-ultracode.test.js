import { describe, it, expect } from "bun:test";
import { transform } from "../../codemods/codemod-unlock-ultracode.cjs";

const TIMEOUT = 30000;

/**
 * Build fixture mimicking the VcH xhigh_effort and max_effort capability
 * check functions. Variable names are minifier artifacts — use generic names.
 */
function buildFixture(names = {}) {
  const {
    xhighFn = "VcH",
    maxFn = "QX7",
    param = "H",
    capFn = "Hr",
    modelFn = "A7",
    effortFn = "eS",
    innerFn = "eJ",
    opusSlug = "claude-opus-4-8",
    haikuSlug = "claude-haiku-4-5",
    sonnetSlug = "claude-sonnet-4-6",
  } = names;

  // max_effort function (appears before xhigh_effort in the real bundle)
  const maxEffortBody = `function ${maxFn}(${param}) {
    let _ = ${capFn}(${param}, "max_effort");
    if (_ !== undefined) { return _; }
    let q = ${modelFn}(${param});
    if (q === "${haikuSlug}") { return false; }
    if (q === "${opusSlug}" || q === "${sonnetSlug}") { return true; }
    return ${effortFn}(${innerFn}(${param}));
  }`;

  // xhigh_effort function
  const xhighBody = `function ${xhighFn}(${param}) {
    let _ = ${capFn}(${param}, "xhigh_effort");
    if (_ !== undefined) { return _; }
    let q = ${modelFn}(${param});
    if (q.includes("claude-3-") || q === "${haikuSlug}") { return false; }
    if (q === "${opusSlug}" || q === "claude-opus-4-7") { return true; }
    return ${effortFn}(${innerFn}(${param}));
  }`;

  return maxEffortBody + "\n" + xhighBody;
}

describe("codemod-unlock-ultracode", () => {
  it("patches both xhigh_effort and max_effort capability checks", () => {
    const input = buildFixture();
    const { code, changed } = transform(input);

    expect(changed).toBe(2);
    // Both functions should get the mod guard
    const guardCount = (code.match(/__isModEnabled__\("unlock_ultracode"\)/g) || []).length;
    expect(guardCount).toBe(2);
  });

  it("works with different minified function names", () => {
    const input = buildFixture({
      xhighFn: "zK3",
      maxFn: "pR8",
      capFn: "wN2",
      modelFn: "tB5",
      param: "Q",
    });
    const { code, changed } = transform(input);
    expect(changed).toBe(2);
  });

  it("injects guard at top of function body", () => {
    const input = buildFixture();
    const { code } = transform(input);

    // The guard should appear right after the opening brace
    expect(code).toContain('if (typeof __isModEnabled__ === "function" && __isModEnabled__("unlock_ultracode"))');
    expect(code).toContain("return true;");
  });

  it("is idempotent — skips already-patched code", () => {
    const input = buildFixture();
    const { code: patched } = transform(input);
    const { code: repatched, changed } = transform(patched);
    expect(changed).toBe(0);
    expect(repatched).toBe(patched);
  });

  it("throws when no capability check functions are found", () => {
    // The codemod throws rather than silently returning 0 — this is by design
    // so the patch engine reports the failure explicitly.
    expect(() => transform("var x = 42;")).toThrow();
  });

  it("exports transform as a function", () => {
    expect(typeof transform).toBe("function");
  });
});

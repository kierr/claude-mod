import { describe, it, expect } from "bun:test";
import { transform } from "../../codemods/codemod-unlock-workflows.cjs";

const TIMEOUT = 30000;

/**
 * Build fixture mimicking the q67() allow_workflows gate and FX5()
 * workflow availability resolver. Variable names are minifier artifacts.
 */
function buildFixture(names = {}) {
  const {
    gateFn = "q67",
    v7Fn = "V7",
    availFn = "FX5",
    flagFn = "L_",
    planFn = "OK",
    xH = "xH",
    VK = "VK",
  } = names;

  // q67() — allow_workflows policy gate
  const gate = `function ${gateFn}() {
    return ${v7Fn}("allow_workflows");
  }`;

  // FX5() — workflow availability resolver
  const avail = `function ${availFn}() {
    if (${xH}(process.env.CLAUDE_CODE_WORKFLOWS)) {
      let _ = ${flagFn}("tengu_workflows_enabled", true);
      return { available: _, defaultOn: _ };
    }
    if (${VK}(process.env.CLAUDE_CODE_WORKFLOWS)) {
      return { available: false, defaultOn: false };
    }
    if (!${flagFn}("tengu_workflows_enabled", true)) {
      return { available: false, defaultOn: false };
    }
    return { available: true, defaultOn: ${planFn}() !== "pro" };
  }`;

  return gate + "\n" + avail;
}

describe("codemod-unlock-workflows", () => {
  it("patches both allow_workflows gate and FX5 availability resolver", () => {
    const input = buildFixture();
    const { code, changed } = transform(input);

    expect(changed).toBe(2);
    expect(code).toContain('__isModEnabled__("unlock_workflows")');
    expect(code).toContain("{ available: true, defaultOn: true }");
  });

  it("replaces q67 gate with mod-guarded ternary", () => {
    const input = buildFixture();
    const { code } = transform(input);

    // The gate function should now check __isModEnabled__ before calling V7
    expect(code).toMatch(/return typeof __isModEnabled__ === "function" && __isModEnabled__\("unlock_workflows"\) \? true : \w+\("allow_workflows"\)/);
  });

  it("works with different minified function names", () => {
    const input = buildFixture({
      gateFn: "zN4",
      v7Fn: "pK9",
      availFn: "wR3",
      flagFn: "tL6",
      planFn: "mQ2",
      xH: "aB1",
      VK: "cD2",
    });
    const { code, changed } = transform(input);
    expect(changed).toBe(2);
  });

  it("is idempotent — skips already-patched code", () => {
    const input = buildFixture();
    const { code: patched } = transform(input);
    const { code: repatched, changed } = transform(patched);
    expect(changed).toBe(0);
    expect(repatched).toBe(patched);
  });

  it("throws when allow_workflows gate is not found", () => {
    // The codemod throws rather than silently returning 0 — explicit failure.
    expect(() => transform("var x = 42;")).toThrow("allow_workflows");
  });

  it("exports transform as a function", () => {
    expect(typeof transform).toBe("function");
  });
});

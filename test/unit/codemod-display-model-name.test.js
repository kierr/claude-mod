import { describe, it, expect } from "bun:test";
import { transform } from "../../codemods/codemod-display-model-name.cjs";

const TIMEOUT = 30000;

describe("codemod-display-model-name (wrapper)", () => {
  it("returns changed: 0 when sub-codemods can't find their targets (regex contract)", () => {
    const code = `
      function showModel() {
        return "claude-sonnet-4-6";
      }
    `;
    // Regex contract: transform(code) — sub-codemods gracefully skip on missing anchors
    const result = transform(code);
    expect(result.changed).toBe(0);
  });

  it("returns changed: 0 on trivial input (regex contract)", () => {
    const code = "var x = 42;";
    const result = transform(code);
    expect(result.changed).toBe(0);
  });

  it("always returns { code, changed } object (regex contract)", () => {
    const code = "var x = 42;";
    const result = transform(code);
    expect(result).toEqual({ code, changed: 0 });
  });

  it("exports transform as a function", () => {
    expect(typeof transform).toBe("function");
  });
});

import { describe, it, expect } from "bun:test";
import { transform } from "../../codemods/codemod-unlock-models.cjs";

const TIMEOUT = 30000;

describe("codemod-unlock-models (wrapper)", () => {
  it("throws when sub-codemods can't find their targets (regex contract)", () => {
    const code = `
      function getModelList() {
        if (process.env.CLAUDE_CODE_USE_BEDROCK) return ["bedrock-model"];
        if (process.env.CLAUDE_CODE_USE_VERTEX) return ["vertex-model"];
        return ["claude-sonnet-4-6"];
      }
    `;
    // Regex contract: transform(code) — sub-codemods throw on missing anchors
    expect(() => transform(code)).toThrow();
  });

  it("throws on trivial input (regex contract)", () => {
    const code = "var x = 42;";
    expect(() => transform(code)).toThrow();
  });

  it("handles old Babel contract (ast, code) for backward compatibility", () => {
    const code = "var x = 42;";
    // Old callers pass (ast, code); wrapper extracts code from arguments
    expect(() => transform(null, code)).toThrow();
  });

  it("exports transform as a function", () => {
    expect(typeof transform).toBe("function");
  });
});

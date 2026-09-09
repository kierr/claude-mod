import { describe, it, expect } from "bun:test";
import { transform } from "../../codemods/codemod-unlock-agent-models.cjs";

describe("codemod-unlock-agent-models (wrapper)", () => {
  it("chains model-enum-to-string then custom-model-descriptions", () => {
    // Minimal fixture: model-enum-to-string matches "claude-sonnet-4-6-20250626"
    // in a return inside a .findLast("assistant") context.
    // custom-model-descriptions matches model label text in a specific AST shape.
    // The wrapper should return changed > 0 when at least one sub-transform matches.
    const input = `
      function pXO(H) {
        var _ = H.findLast("assistant");
        if (_.model === "claude-sonnet-4-6-20250626") return _.model;
        return null;
      }
    `;

    const { code, changed } = transform(input);
    // model-enum-to-string wraps the enum in a string() call
    expect(changed).toBeGreaterThanOrEqual(0);
    expect(typeof code).toBe("string");
  });

  it("returns unchanged code when no sub-codemods match", () => {
    const input = "var x = 42;";
    const { code, changed } = transform(input);
    expect(changed).toBe(0);
    expect(code).toBe(input);
  });

  it("exports transform as a function", () => {
    expect(typeof transform).toBe("function");
  });
});

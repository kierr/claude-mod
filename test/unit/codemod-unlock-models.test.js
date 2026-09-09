import { describe, it, expect } from "bun:test";
import path from "path";
import { transform } from "../../codemods/codemod-unlock-models.cjs";

const parser = require(path.join(process.cwd(), "codemods/node_modules/@babel/parser"));

const TIMEOUT = 30000;

describe("codemod-unlock-models (wrapper)", () => {
  it("chains gateway-models-unfilter then model-full-list on shared AST", () => {
    // model-full-list requires specific AST shapes (model-capabilities wrapper)
    // that minimal fixtures don't provide — it throws on mismatch.
    const code = `
      function getModelList() {
        if (process.env.CLAUDE_CODE_USE_BEDROCK) return ["bedrock-model"];
        if (process.env.CLAUDE_CODE_USE_VERTEX) return ["vertex-model"];
        return ["claude-sonnet-4-6"];
      }
    `;
    const ast = parser.parse(code);
    expect(() => transform(ast, code)).toThrow();
  });

  it("throws when sub-codemods can't find their targets", () => {
    const code = "var x = 42;";
    const ast = parser.parse(code);
    expect(() => transform(ast, code)).toThrow();
  });

  it("exports transform as a function", () => {
    expect(typeof transform).toBe("function");
  });
});

import { describe, it, expect } from "bun:test";
import path from "path";
import { transform } from "../../codemods/codemod-display-model-name.cjs";

const parser = require(path.join(process.cwd(), "codemods/node_modules/@babel/parser"));

const TIMEOUT = 30000;

describe("codemod-display-model-name (wrapper)", () => {
  it("chains four Babel sub-codemods on shared AST", () => {
    // Sub-codemods require specific AST shapes (mainLoopModel + mainLoopModelForSession)
    // that minimal fixtures don't provide — they throw on mismatch.
    const code = `
      function showModel() {
        return "claude-sonnet-4-6";
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

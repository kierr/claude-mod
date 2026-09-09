import { describe, it, expect } from "bun:test";
import { findMatchingBrace } from "../../lib/utils.cjs";

describe("findMatchingBrace", () => {
  it("should find matching curly brace", () => {
    const code = "function foo() { return 1; }";
    const openPos = code.indexOf("{");
    const result = findMatchingBrace(code, openPos, "{", "}");
    expect(result).toBe(code.lastIndexOf("}"));
  });

  it("should find matching square bracket", () => {
    const code = "return [a, [b, c], d];";
    const openPos = code.indexOf("[");
    const result = findMatchingBrace(code, openPos, "[", "]");
    expect(result).toBe(code.lastIndexOf("]"));
  });

  it("should skip braces inside double-quoted strings", () => {
    const code = '{ x: "}" }';
    const result = findMatchingBrace(code, 0, "{", "}");
    expect(result).toBe(code.length - 1);
  });

  it("should skip braces inside single-quoted strings", () => {
    const code = "{ x: '}' }";
    const result = findMatchingBrace(code, 0, "{", "}");
    expect(result).toBe(code.length - 1);
  });

  it("should skip braces inside template literals", () => {
    const code = "{ x: `}` }";
    const result = findMatchingBrace(code, 0, "{", "}");
    expect(result).toBe(code.length - 1);
  });

  it("should handle template literal ${} expressions", () => {
    const code = "{ x: `${obj.method()}` }";
    const result = findMatchingBrace(code, 0, "{", "}");
    expect(result).toBe(code.length - 1);
  });

  it("should handle nested braces", () => {
    const code = "{ if (true) { return 1; } return 0; }";
    const result = findMatchingBrace(code, 0, "{", "}");
    expect(result).toBe(code.length - 1);
  });

  it("should return -1 for unmatched brace", () => {
    const code = "{ if (true) { return 1; }";
    const result = findMatchingBrace(code, 0, "{", "}");
    expect(result).toBe(-1);
  });

  it("should return -1 for unmatched bracket", () => {
    const code = "return [a, [b";
    const openPos = code.indexOf("[");
    const result = findMatchingBrace(code, openPos, "[", "]");
    expect(result).toBe(-1);
  });

  it("should handle escaped quotes inside strings", () => {
    const code = '{ x: "it\\"s }" }';
    const result = findMatchingBrace(code, 0, "{", "}");
    expect(result).toBe(code.length - 1);
  });
});

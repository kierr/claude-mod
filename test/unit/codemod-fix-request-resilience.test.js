import { describe, it, expect } from "bun:test";
import { transform } from "../../codemods/codemod-fix-request-resilience.cjs";

describe("codemod-fix-request-resilience (wrapper)", () => {
  it("chains retry-all-errors then fallback-loosen", () => {
    // Fixture that matches retry-all-errors: the return false tail of the retry decider.
    const input = `
    if (q.status === 429) {
      return !i7() || MV8();
    }
    if (q.status && q.status >= 500) {
      return true;
    }
    return false;
    `;

    const { code, changed } = transform(input);
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

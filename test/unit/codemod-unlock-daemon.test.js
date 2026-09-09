import { describe, it, expect } from "bun:test";
import { transform } from "../../codemods/codemod-unlock-daemon.cjs";

const fixture = `function OzH() {
    return D_("tengu_amber_anchor", false);
  }`;

describe("codemod-unlock-daemon", () => {
  it("wraps gate function with mod guard and preserves original body", () => {
    const { code, changed } = transform(fixture);
    expect(changed).toBe(1);
    expect(code).toContain("return true; /* __DSE__ */");
    // Mod guard wrapping preserves original body
    expect(code).toContain("tengu_amber_anchor");
    expect(code).toContain('__isModEnabled__("unlock_daemon")');
  });

  it("is idempotent", () => {
    const first = transform(fixture);
    const second = transform(first.code);
    expect(second.changed).toBe(0);
    expect(second.code).toEqual(first.code);
  });

  it("survives minified function name changes", () => {
    const renamed = fixture.replace("OzH", "xA7");
    const { code, changed } = transform(renamed);
    expect(changed).toBe(1);
    expect(code).toContain("function xA7()");
    expect(code).toContain("return true; /* __DSE__ */");
  });

  it("survives minified callee name changes", () => {
    const renamed = fixture.replace('D_("tengu_amber_anchor"', 'ZB1("tengu_amber_anchor"');
    const { code, changed } = transform(renamed);
    expect(changed).toBe(1);
    expect(code).toContain("return true; /* __DSE__ */");
  });

  it("handles $ in minified function and callee names", () => {
    const renamed = `function Q$H() {
    return Z$1("tengu_amber_anchor", false);
  }`;
    const { code, changed } = transform(renamed);
    expect(changed).toBe(1);
    expect(code).toContain("function Q$H()");
    expect(code).toContain("return true; /* __DSE__ */");
  });

  it("returns 0 changes when pattern not found", () => {
    const { code, changed } = transform("function foo() { return 42; }");
    expect(changed).toBe(0);
    expect(code).toEqual("function foo() { return 42; }");
  });
});

import { describe, it, expect } from "bun:test";
import { transform } from "../../codemods/codemod-unlock-auto-mode.cjs";

// Uses double quotes like the real deobfuscated baseline
const fixture = `function sd(H) {
    if (I8H()) {
      return false;
    }
    let _ = k7(H);
    if (_.includes("claude-3-") || _ === "claude-opus-4-0" || _ === "claude-opus-4-1" || _ === "claude-opus-4-5" || _ === "claude-haiku-4-5") {
      return false;
    }
    if (_ === "claude-opus-4-7" || _ === "claude-opus-4-6" || _ === "claude-sonnet-4-6" || _ === "claude-sonnet-4-5" || _ === "claude-sonnet-4-0") {
      return true;
    }
    return $h(YD(H));
  }`;

describe("codemod-unlock-auto-mode", () => {
  it("prepends mod-guard return true and preserves original body", () => {
    const { code, changed } = transform(fixture);
    expect(changed).toBe(1);
    expect(code).toContain("__AMMB__");
    expect(code).toContain('__isModEnabled__("unlock_auto_mode")');
    expect(code).toContain("typeof __isModEnabled__");
    // Mod guard return true is present
    expect(code).toMatch(/return true;\s*\/\* __AMMB__ \*\//);
    // Original body is preserved
    expect(code).toContain("claude-opus-4-0");
    expect(code).toContain("$h(YD(H))");
    expect(code).toContain("I8H()");
  });

  it("is idempotent", () => {
    const first = transform(fixture);
    const second = transform(first.code);
    expect(second.changed).toBe(0);
    expect(second.code).toEqual(first.code);
  });

  it("survives minified name changes", () => {
    const renamed = fixture
      .replace("sd", "zQ9").replace("I8H", "xT3").replace("k7", "nM2")
      .replace(/\$h/g, "rP4").replace("YD", "wK7");
    const { code, changed } = transform(renamed);
    expect(changed).toBe(1);
    expect(code).toContain("function zQ9(H)");
    expect(code).toContain("__AMMB__");
    // Original body with renamed functions preserved
    expect(code).toContain("xT3()");
    expect(code).toContain("rP4(wK7(H))");
  });

  it("survives parameter name changes (H -> G)", () => {
    const renamed = fixture.replace(/function sd\(H\)/, "function sd(G)");
    const { code, changed } = transform(renamed);
    expect(changed).toBe(1);
    expect(code).toMatch(/function sd\(G\)/);
    expect(code).toContain("__AMMB__");
    // Original body preserved — the body still uses H since only the param changed
    expect(code).toContain("k7(H)");
  });

  it("returns 0 changes when pattern not found", () => {
    const { code, changed } = transform("function foo() { return 42; }");
    expect(changed).toBe(0);
    expect(code).toEqual("function foo() { return 42; }");
  });
});

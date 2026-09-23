import { describe, it, expect } from "bun:test";
import { transform, MARKER } from "../../codemods/codemod-unlock-model-restore.cjs";

// The branch is guarded, not dropped: the unknown_family condition is wrapped so it
// is forced false when the mod is enabled. The "unknown_family" string stays in the
// output (the engine keys idempotency off the __MODEL_RESTORE_OK__ marker).
const GUARD_PREFIX =
  '(typeof __isModEnabled__ === "function" && __isModEnabled__("unlock_model_restore") ? false : (';
const GUARD_SUFFIX = ')) ? "unknown_family" : ';

describe("codemod-unlock-model-restore", () => {
  it("guards the unknown_family condition (2.1.178 two-condition tail)", () => {
    const input =
      '      let $ = !q.has(T9(T)) && !rOH(T) ? "unknown_family" : !lj(T) && !M4(T) ? "not_allowed" : z04(T) ? "retired" : undefined;';
    const { code, changed } = transform(input);
    expect(changed).toBe(1);
    expect(code).toBe(
      '      let $ = ' +
        GUARD_PREFIX +
        '!q.has(T9(T)) && !rOH(T)' +
        GUARD_SUFFIX +
        '!lj(T) && !M4(T) ? "not_allowed" : z04(T) ? "retired" : undefined; /*' +
        MARKER +
        '*/',
    );
    // The branch is retained, just gated.
    expect(code).toContain('"unknown_family"');
  });

  it("handles the 2.1.173 single-condition not_allowed tail", () => {
    const input =
      '      let $ = !q.has(D9(T)) && !DOH(T) ? "unknown_family" : !iY(T) ? "not_allowed" : iY4(T) ? "retired" : undefined;';
    const { code, changed } = transform(input);
    expect(changed).toBe(1);
    expect(code).toContain(GUARD_PREFIX + "!q.has(D9(T)) && !DOH(T)" + GUARD_SUFFIX);
    expect(code).toContain('!iY(T) ? "not_allowed" : iY4(T) ? "retired" : undefined');
    expect(code).toContain(MARKER);
  });

  it("survives different minified names (2.1.177 shape)", () => {
    const input =
      '      let $ = !q.has(_9(T)) && !DOH(T) ? "unknown_family" : !Fj(T) && !N4(T) ? "not_allowed" : fX4(T) ? "retired" : undefined;';
    const { code, changed } = transform(input);
    expect(changed).toBe(1);
    expect(code).toContain(GUARD_PREFIX + "!q.has(_9(T)) && !DOH(T)" + GUARD_SUFFIX);
    expect(code).toContain('"not_allowed"');
    expect(code).toContain('"retired"');
    expect(code).toContain('"unknown_family"');
    expect(code).toContain(MARKER);
  });

  it("preserves surrounding code in a realistic function body", () => {
    const input = [
      "  function kU4(H, _) {",
      "    let q = new Set(iR9.map(T9));",
      '    if (O?.type !== "assistant") continue;',
      '    let $ = !q.has(T9(T)) && !rOH(T) ? "unknown_family" : !lj(T) && !M4(T) ? "not_allowed" : z04(T) ? "retired" : undefined;',
      "    if ($) { return { kind: \"declined\", model: T, reason: $ }; }",
      "    return { kind: \"ok\", model: T };",
      "  }",
    ].join("\n");
    const { code, changed } = transform(input);
    expect(changed).toBe(1);
    // Surrounding statements untouched.
    expect(code).toContain("let q = new Set(iR9.map(T9));");
    expect(code).toContain('if ($) { return { kind: "declined", model: T, reason: $ }; }');
    // The classifier line keeps its unknown_family branch, now guarded.
    expect(code).toContain('__isModEnabled__("unlock_model_restore")');
    expect(code).toContain('? "unknown_family"');
    expect(code).toContain(MARKER);
  });

  it("is idempotent — skips already-guarded code", () => {
    const input =
      '      let $ = ' +
      GUARD_PREFIX +
      '!q.has(T9(T)) && !rOH(T)' +
      GUARD_SUFFIX +
      '!lj(T) && !M4(T) ? "not_allowed" : z04(T) ? "retired" : undefined; /*' +
      MARKER +
      '*/';
    const { code, changed } = transform(input);
    expect(changed).toBe(0);
    expect(code).toBe(input);
  });

  it("returns unchanged code when no match found (drift)", () => {
    const input = "console.log('nothing to see here');";
    const { code, changed } = transform(input);
    expect(changed).toBe(0);
    expect(code).toBe(input);
  });

  it("does not touch the unquoted reason-text map key", () => {
    // The t0T map uses an unquoted key `unknown_family:` — must be left alone.
    const input = [
      "  t0T = {",
      '    unknown_family: "not a model this version of Claude Code recognizes",',
      '    not_allowed: "not allowed by this account\'s model settings",',
      '    retired: "retired"',
      "  };",
    ].join("\n");
    const { code, changed } = transform(input);
    expect(changed).toBe(0);
    expect(code).toBe(input);
  });
});

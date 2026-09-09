import { describe, it, expect } from "bun:test";
import path from "path";
import { transform } from "../../codemods/codemod-unlock-autocompact.cjs";

const { assertAppliedRegex, getApplicableRegex } = require("./test-helpers.cjs");
const PATCH_ID = "unlock_autocompact";

// Guard wraps just the `|| X === "auto"` term, so disabling the mod restores
// the upstream gate (env/settings/model-default) and enabling accepts "auto".
const GUARDED_AUTO = (v) =>
  `(typeof __isModEnabled__ === "function" && __isModEnabled__("unlock_autocompact") && ${v} === "auto")`;

describe("codemod-unlock-autocompact", () => {
  it("patches old-baseline (settings) source check with a guarded auto term", () => {
    const input = [
      "function VH_(H, _) {",
      '  let { source: q } = Wl(H, _);',
      '  return q === "env" || q === "settings";',
      "}",
    ].join("\n");

    const { code, changed } = transform(input);
    expect(changed).toBe(1);
    expect(code).toContain(`  return q === "env" || q === "settings" || ${GUARDED_AUTO("q")};`);
  });

  it("patches new-baseline (model-default) source check with a guarded auto term", () => {
    const input = [
      "function T3_(H, _) {",
      "  let { source: q } = nc(H, _);",
      '  return q === "env" || q === "settings" || q === "model-default";',
      "}",
    ].join("\n");

    const { code, changed } = transform(input);
    expect(changed).toBe(1);
    expect(code).toContain(
      `  return q === "env" || q === "settings" || q === "model-default" || ${GUARDED_AUTO("q")};`
    );
  });

  it("patches 2.1.179+ baseline (settings + clientdata) preserving middle sources", () => {
    const input = [
      "function T3_(H, _) {",
      "  let { source: q } = DU(H, _);",
      '  return q === "env" || q === "settings" || q === "clientdata" || q === "model-default";',
      "}",
    ].join("\n");

    const { code, changed } = transform(input);
    expect(changed).toBe(1);
    // clientdata is preserved; the guarded "auto" term is appended.
    expect(code).toContain('q === "clientdata"');
    expect(code).toContain(
      `  return q === "env" || q === "settings" || q === "clientdata" || q === "model-default" || ${GUARDED_AUTO("q")};`
    );
  });

  it("works with different minified variable names", () => {
    const input = [
      "function VH_(H, _) {",
      "  let { source: zK3 } = Wl(H, _);",
      '  return zK3 === "env" || zK3 === "settings";',
      "}",
    ].join("\n");

    const { code, changed } = transform(input);
    expect(changed).toBe(1);
    expect(code).toContain(`return zK3 === "env" || zK3 === "settings" || ${GUARDED_AUTO("zK3")};`);
  });

  it("does not match if-checks that also use env/settings", () => {
    const input = [
      'if (O === "env" || O === "settings") {',
      "  z.push('warning');",
      "}",
    ].join("\n");

    const { changed } = transform(input);
    expect(changed).toBe(0);
  });

  it("does not match if-checks in compaction logic", () => {
    const input = 'if (!a || !!Gc() || D === "env" || D === "settings") {';
    const { changed } = transform(input);
    expect(changed).toBe(0);
  });

  it("is idempotent — skips already-guarded code", () => {
    const input = [
      "function T3_(H, _) {",
      "  let { source: q } = nc(H, _);",
      `  return q === "env" || q === "settings" || q === "model-default" || ${GUARDED_AUTO("q")};`,
      "}",
    ].join("\n");

    const { code, changed } = transform(input);
    expect(changed).toBe(0);
    expect(code).toBe(input);
  });

  it("returns unchanged code when no match found", () => {
    const input = "console.log('hello world');";
    const { code, changed } = transform(input);
    expect(changed).toBe(0);
    expect(code).toBe(input);
  });

  it("status applied regex matches patched output (round-trip)", () => {
    const input = [
      "function T3_(H, _) {",
      '  return q === "env" || q === "settings" || q === "model-default";',
      "}",
    ].join("\n");
    const { code } = transform(input);
    expect(() => assertAppliedRegex(PATCH_ID, code)).not.toThrow();
  });

  it("status applicable regex matches the unpatched new-baseline fixture", () => {
    const input = '  return q === "env" || q === "settings" || q === "model-default";';
    const applicableRegex = getApplicableRegex(PATCH_ID);
    expect(applicableRegex).not.toBeNull();
    expect(applicableRegex.test(input)).toBe(true);
  });
});

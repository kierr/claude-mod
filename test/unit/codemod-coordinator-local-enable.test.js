import { describe, it, expect } from "bun:test";
import path from "path";

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-coordinator-local-enable.cjs");
const { transform } = require(CODEMOD_PATH);

const TIMEOUT = 5000;

/**
 * Build a realistic rx() coordinator predicate with configurable minified names.
 * Mirrors the 2.1.181 structure: two guards + return true.
 */
function buildFixture(names = {}) {
  const {
    rxName = "rx",
    rtName = "rt",
    gxName = "Gx",
    yaName = "ya",
  } = names;
  return `function ${rxName}() {
  if (!${rtName}(process.env.CLAUDE_CODE_COORDINATOR_MODE)) {
    return false;
  }
  if (${gxName}() && !${yaName}() && !${rtName}(process.env.CLAUDE_CODE_REMOTE)) {
    return false;
  }
  return true;
}`;
}

describe("codemod-coordinator-local-enable", () => {
  it("wraps the coordinator guard with a mod ternary", () => {
    const code = buildFixture();
    const { code: out, changed } = transform(code);

    expect(changed).toBe(1);
    // Mod-enabled branch returns false (do-not-block) → rx() falls through to true
    expect(out).toContain('__isModEnabled__("coordinator_local_enable") ? false :');
    // Original guard expression preserved in the else-branch
    expect(out).toContain("Gx() && !ya() && !rt(process.env.CLAUDE_CODE_REMOTE)");
    // typeof guard present (prevents ReferenceError without mods_runtime)
    expect(out).toContain('typeof __isModEnabled__ === "function"');
  }, TIMEOUT);

  it("survives minified-name drift (matches structure, not identity)", () => {
    // Different minified names than the 2.1.181 baseline — same structure
    const code = buildFixture({ rxName: "Zq", rtName: "a1", gxName: "_B", yaName: "$c" });
    const { code: out, changed } = transform(code);

    expect(changed).toBe(1);
    expect(out).toContain("__isModEnabled__");
    expect(out).toContain("_B() && !$c() && !a1(process.env.CLAUDE_CODE_REMOTE)");
  }, TIMEOUT);

  it("is idempotent — running twice does not double-wrap", () => {
    const code = buildFixture();
    const once = transform(code).code;
    const { code: twice, changed } = transform(once);

    expect(changed).toBe(0);
    expect(twice).toBe(once);
    // Exactly one mod guard injected, not nested
    const matches = once.match(/__isModEnabled__\(\s*["']coordinator_local_enable["']\s*\)/g);
    expect(matches.length).toBe(1);
  }, TIMEOUT);

  it("wraps exactly one site — does not touch other CLAUDE_CODE_REMOTE reads", () => {
    // The bare !fn(CLAUDE_CODE_REMOTE) appears 14× in the real bundle; only the
    // 3-term conjunction (coordinator guard) must be wrapped.
    const code = `
function otherSite() { if (!rt(process.env.CLAUDE_CODE_REMOTE)) return null; }
function rx() {
  if (!rt(process.env.CLAUDE_CODE_COORDINATOR_MODE)) return false;
  if (Gx() && !ya() && !rt(process.env.CLAUDE_CODE_REMOTE)) return false;
  return true;
}
function thirdSite() { return rt(process.env.CLAUDE_CODE_REMOTE) ? "x" : "y"; }
`;
    const { code: out, changed } = transform(code);
    expect(changed).toBe(1);
    // The standalone negated read must remain UN-wrapped
    expect(out).toContain('if (!rt(process.env.CLAUDE_CODE_REMOTE)) return null;');
    // The ternary-return read must remain UN-wrapped
    expect(out).toContain("return rt(process.env.CLAUDE_CODE_REMOTE) ? \"x\" : \"y\";");
  }, TIMEOUT);

  it("mod-disabled preserves original semantics (else-branch is the bare guard)", () => {
    const code = buildFixture();
    const { code: out } = transform(code);
    // The wrapped form: (typeof ... && __isModEnabled__(...) ? false : <original>)
    // When the mod is disabled, __isModEnabled__ returns falsy → ternary yields
    // the original guard, so rx() behaves exactly as upstream.
    expect(out).toMatch(
      /\(\s*typeof __isModEnabled__ === "function" && __isModEnabled__\("coordinator_local_enable"\) \? false : Gx\(\) && !ya\(\) && !rt\(process\.env\.CLAUDE_CODE_REMOTE\)\s*\)/
    );
  }, TIMEOUT);

  it("is a no-op when the guard is absent (reports 0 changes)", () => {
    const code = `function rx() { return true; }`;
    const { changed } = transform(code);
    expect(changed).toBe(0);
  }, TIMEOUT);
});

/**
 * Code-split fixture — reflects the actual code-split structure from 2.1.277
 * where the guard is a simple if-block with property access.
 */
function buildCodeSplitFixture() {
  return `function gs(){if(dUe()?.live)return;if(a.CLAUDE_CODE_REMOTE===!0)return Oee()===void 0?"no-container-address":void 0;return"rc-disconnected"}`;
}

describe("codemod-coordinator-local-enable code-split", () => {
  it("wraps the code-split if-block guard with a mod ternary", () => {
    const { code: out, changed } = transform(buildCodeSplitFixture());
    expect(changed).toBe(1);
    expect(out).toContain('__isModEnabled__("coordinator_local_enable") ? false : a.CLAUDE_CODE_REMOTE===!0');
  }, TIMEOUT);

  it("preserves the return statement after the guard", () => {
    const { code: out } = transform(buildCodeSplitFixture());
    // The return and its content should still be present
    expect(out).toContain('return Oee()===void 0');
  }, TIMEOUT);

  it("is idempotent on code-split structure", () => {
    const once = transform(buildCodeSplitFixture()).code;
    const { code: twice, changed } = transform(once);
    expect(changed).toBe(0);
    expect(twice).toBe(once);
  }, TIMEOUT);

  it("mod-disabled preserves original code-split semantics", () => {
    const { code: out } = transform(buildCodeSplitFixture());
    // When mod is disabled, __isModEnabled__ returns falsy → ternary yields
    // the original condition a.CLAUDE_CODE_REMOTE===!0
    expect(out).toMatch(/\? false : a\.CLAUDE_CODE_REMOTE===!0\)\) return/);
  }, TIMEOUT);
});

import { describe, it, expect } from "bun:test";

import path from "path";
const { transform } = require("../../codemods/codemod-unlock-channels.cjs");
const { assertAppliedRegex, assertNotApplicable } = require("./test-helpers.cjs");
const parser = require(path.join(process.cwd(), "codemods/node_modules/@babel/parser"));

/**
 * Build a fixture representing the channel gate function with all 7 gates.
 * Names object allows configurable minified identifiers.
 */
function buildChannelsFixture(names = {}) {
  const prov = names.provider || "Jq";
  const ff = names.featureFlag || "DNH";
  const policy = names.policy || "Xw6";
  const capVar = names.capabilitiesVar || "LH";
  const ledgerVar = names.ledgerVar || "ledgerList";
  const paramVar = names.paramVar || "K";
  const allowParam = names.allowParam || "O";
  const allowItem = names.allowItem || "A";
  const fnName = names.fnName || "qrH";

  return `
function ${fnName}(${paramVar}) {
  if (${prov}() !== "firstParty") {
    return {
      action: "skip",
      kind: "provider",
      reason: "channels are not available on third-party providers"
    };
  }
  if (!${ff}()) {
    return {
      action: "skip",
      kind: "disabled",
      reason: "channels feature is not currently available"
    };
  }
  if (${policy}(${paramVar})) {
    return {
      action: "skip",
      kind: "policy",
      reason: "channels not enabled by org policy"
    };
  }
  const status = {
    disabled: !${ff}(),
    is3P: ${prov}() !== "firstParty",
    policyBlocked: ${policy}(${paramVar})
  };
  if (${capVar}["claude/channel"] && (!${ff}() || !${policy}(${allowParam}))) {
    delete ${capVar}["claude/channel"];
  }
  if (!${allowParam}.dev) {
    if (!${ledgerVar}.some(${allowItem} => ${allowItem}.plugin === ${allowParam}.name && ${allowItem}.marketplace === ${allowParam}.marketplace)) {
      return { blocked: true };
    }
  } else if (!${allowParam}.dev) {
    return { serverBlock: true };
  }
  return { action: "allow" };
}`.trim();
}

describe("codemod-unlock-channels", () => {
  it("wraps all 7 gates with mod guards", () => {
    const input = buildChannelsFixture();
    const { code, changed } = transform(input);

    // 7 gates: gates 1-3 (3), gate 4 block wrap (1), gate 5 (1), gates 6-7 (2)
    expect(changed).toBe(7);
    // Gate 1: provider gate wrapped
    expect(code).toContain("provider gate wrapped");
    expect(code).toContain("__isModEnabled__(\"unlock_channels\")");
    // Gate 2: feature flag gate wrapped
    expect(code).toContain("feature flag gate wrapped");
    // Gate 3: policy gate wrapped
    expect(code).toContain("policy gate wrapped");
    // Gate 4: status block wrapped
    expect(code).toContain("status block wrapped");
    // Gate 5: capability stripper wrapped
    expect(code).toContain("capability stripper wrapped");
    // Gate 6: plugin allowlist gets mod-guarded ternary
    expect(code).toContain("channels patch */");
    // Gate 7: server allowlist gets mod-guarded ternary
    // Marker injected
    expect(code).toContain("__channels_unnerfed");
  });

  it("is idempotent — second transform returns changed: 0", () => {
    const input = buildChannelsFixture();
    const first = transform(input);
    expect(first.changed).toBeGreaterThan(0);

    const second = transform(first.code);
    expect(second.changed).toBe(0);
    expect(second.code).toBe(first.code);
  });

  it("works with different minified names", () => {
    const input = buildChannelsFixture({
      provider: "ZB1",
      featureFlag: "abc",
      policy: "Xy9",
      capabilitiesVar: "caps",
      ledgerVar: "ll",
      paramVar: "opts",
      allowParam: "ch",
      allowItem: "item",
      fnName: "myGate",
    });
    const { code, changed } = transform(input);

    expect(changed).toBe(7);
  });

  it("wraps gate 4 status block in mod guard", () => {
    const input = buildChannelsFixture();
    const { code } = transform(input);

    // Status block should be wrapped in a mod-guarded conditional
    expect(code).toContain("status block wrapped");
    // Original status block fields should still be present (inside the guard)
    expect(code).toMatch(/disabled: !\w+\(\)/);
    expect(code).toMatch(/is3P: \w+\(\) !== "firstParty"/);
    expect(code).toMatch(/policyBlocked: \w+\(\w+\)/);
  });

  it("wraps gate 5 capability stripper in mod guard", () => {
    const input = buildChannelsFixture();
    const { code } = transform(input);

    expect(code).toContain("capability stripper wrapped");
    expect(code).toContain("claude/channel");
    // The original delete should still be present (inside the guard)
    expect(code).toMatch(/delete \w+\["claude\/channel"\]/);
  });

  it("wraps gate 6 plugin allowlist with ledger-length guard", () => {
    const input = buildChannelsFixture();
    const { code } = transform(input);

    // Should contain the ledger variable length check
    expect(code).toMatch(/ledgerList\.length > 0/);
    // Should have mod-guarded ternary
    expect(code).toMatch(/__isModEnabled__\("unlock_channels"\).*ledgerList/);
  });

  it("wraps gate 7 server allowlist with ledger-length guard (no hardcoded Dw6)", () => {
    const input = buildChannelsFixture();
    const { code } = transform(input);

    // Should NOT contain hardcoded Dw6
    expect(code).not.toContain("Dw6");
    // Should contain the ledger variable length check in server allowlist
    expect(code).toMatch(/__isModEnabled__.*ledgerList\.length > 0/);
  });

  it("returns changed: 0 with unchanged code when nothing matches", () => {
    const input = "const x = 42;";
    const { code, changed } = transform(input);

    expect(changed).toBe(0);
    expect(code).toBe(input);
  });

  it("produces valid JS output", () => {
    const input = buildChannelsFixture();
    const { code } = transform(input);

    try {
      parser.parse(code, { sourceType: "module" });
    } catch (e) {
      throw new Error(`Output is not valid JS: ${e.message}\n${code.substring(0, 500)}`);
    }
  });

  it("matches the applied status_test regex", () => {
    const input = buildChannelsFixture();
    const { code } = transform(input);
    expect(() => assertAppliedRegex("unlock_channels", code)).not.toThrow();
  });

  // Note: assertNotApplicable is not tested here because the mod-guard wrapping
  // preserves the original gate code. The applicable regex (reason string) still
  // matches the output — this is expected. The engine uses the `applied` regex
  // (__channels_unnerfed) to verify success, not the absence of the applicable pattern.
});

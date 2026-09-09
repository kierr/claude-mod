import { describe, it, expect } from "bun:test";

const { transform } = require("../../codemods/codemod-unlock-advisor.cjs");
const { assertAppliedRegex } = require("./test-helpers.cjs");

/**
 * Build the advisor enable predicate (Pc). Names object allows configurable
 * minified identifiers. Mirrors the real Pc() structure. Target of injection 1.
 */
function buildAdvisorPredicate(names = {}) {
  const fn = names.fn || "vQ";
  const envHelper = names.envHelper || "q_";
  const providerCheck = names.providerCheck || "l8";
  const otherCheck = names.otherCheck || "NN";
  const gb = names.gb || "Y_";
  return `
function ${fn}() {
  if (${envHelper}(process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL)) {
    return false;
  }
  if (${providerCheck}() !== "firstParty" || !${otherCheck}()) {
    return false;
  }
  if (${envHelper}(process.env.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL)) {
    return true;
  }
  return ${gb}("tengu_sage_compass2", {}).enabled ?? false;
}`.trim();
}

/**
 * Build the cGK() selection/UI chokepoint — the unique zero-arg function whose
 * entire body is `return <envObj>.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL;`.
 * Target of injection 3.
 */
function buildAdvisorOverride(names = {}) {
  const fn = names.overrideFn || "cGK";
  const envObj = names.envObj || "nH";
  return `
function ${fn}() {
  return ${envObj}.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL;
}`.trim();
}

/**
 * Build the fGH(advisor) validity predicate: M4 allowlist, then a direct
 * experimental-env check (NOT via cGK), then a tier>=floor check. Target of
 * injection 4.
 */
function buildAdvisorValidity(names = {}) {
  const fn = names.validityFn || "fGH";
  const param = names.validityParam || "H";
  const allowFn = names.allowFn || "M4";
  const envObj = names.envObj || "nH";
  const tierVar = names.tierVar || "_";
  const tierFn = names.tierFn || "y8q";
  const tierFloor = names.tierFloor || "rzO";
  return `
function ${fn}(${param}) {
  if (!${allowFn}(${param})) {
    return false;
  }
  if (${envObj}.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL) {
    return true;
  }
  let ${tierVar} = T9(${param});
  let q = ${tierFn}(${tierVar});
  return q !== undefined && q >= ${tierFloor};
}`.trim();
}

/**
 * Build the advisor runtime resolver (nGK) with its three pairing checks.
 * The resolved-advisor var (default q) and args mirror the real nGK().
 * Target of injection 2.
 */
function buildAdvisorResolver(names = {}) {
  const fn = names.resolverFn || "pqK";
  const baseFn = names.baseFn || "V0H";
  const validFn = names.validFn || "y0H";
  const tierFn = names.tierFn || "qxH";
  const resolveFn = names.resolveFn || "gO";
  const normalizeFn = names.normalizeFn || "D9";
  const log = names.log || "N";
  const advisorVar = names.advisorVar || "q";
  const advisorArg = names.advisorArg || "H";
  const baseArg = names.baseArg || "_";
  return `
function ${fn}(${advisorArg}, ${baseArg}) {
  if (!vQ() || !${advisorArg}) {
    return;
  }
  let ${advisorVar} = ${resolveFn}(${normalizeFn}(${advisorArg}));
  if (!${baseFn}(${baseArg})) {
    ${log}(\`[AdvisorTool] Skipping advisor - base model \${${baseArg}} does not support advisor\`);
    return;
  }
  if (!${validFn}(${advisorVar})) {
    ${log}(\`[AdvisorTool] Skipping advisor - \${${advisorVar}} is not a valid advisor model\`);
    return;
  }
  if (!${tierFn}(${baseArg}, ${advisorVar})) {
    ${log}(\`[AdvisorTool] Skipping advisor - \${${advisorVar}} cannot advise \${${baseArg}} (advisor must be at least as capable as the base model)\`);
    return;
  }
  ${log}(\`[AdvisorTool] Server-side tool enabled with \${${advisorVar}} as the advisor model\`);
  return ${advisorVar};
}`.trim();
}

/** All four fixtures concatenated in source order (ENABLE → CGK → FGH → PAIRING). */
function buildAll() {
  return buildAdvisorPredicate() + "\n\n" + buildAdvisorOverride() + "\n\n" +
    buildAdvisorValidity() + "\n\n" + buildAdvisorResolver();
}

describe("codemod-unlock-advisor", () => {
  it("injects all four guards (changed: 4) on a full fixture", () => {
    const { code, changed } = transform(buildAll());

    expect(changed).toBe(4);
    expect(code).toContain("__ADVISOR_ENABLE__");
    expect(code).toContain("__ADVISOR_CGK__");
    expect(code).toContain("__ADVISOR_FGH__");
    expect(code).toContain("__ADVISOR_PAIRING__");
  });

  it("places all four markers in source order (ENABLE → CGK → FGH → PAIRING)", () => {
    const { code } = transform(buildAll());

    const enable = code.indexOf("__ADVISOR_ENABLE__");
    const cgk = code.indexOf("__ADVISOR_CGK__");
    const fgh = code.indexOf("__ADVISOR_FGH__");
    const pairing = code.indexOf("__ADVISOR_PAIRING__");

    expect(enable).toBeGreaterThan(-1);
    expect(cgk).toBeGreaterThan(enable);
    expect(fgh).toBeGreaterThan(cgk);
    expect(pairing).toBeGreaterThan(fgh);
  });

  it("injection 1: ENABLE guard lands after DISABLE check, before provider gate", () => {
    const { code } = transform(buildAll());

    const disablePos = code.indexOf("CLAUDE_CODE_DISABLE_ADVISOR_TOOL");
    const guardPos = code.indexOf("__ADVISOR_ENABLE__");
    const providerPos = code.indexOf('!== "firstParty"');

    expect(guardPos).toBeGreaterThan(disablePos);
    expect(providerPos).toBeGreaterThan(guardPos);
  });

  it("injection 2: PAIRING guard lands after the advisor bind, before the base-model check", () => {
    const { code } = transform(buildAll());

    const bindPos = code.indexOf("let q = gO(D9(H));");
    const guardPos = code.indexOf("__ADVISOR_PAIRING__");
    const baseCheckPos = code.indexOf("base model");

    expect(guardPos).toBeGreaterThan(bindPos);
    expect(baseCheckPos).toBeGreaterThan(guardPos);
    // The guard returns the resolved advisor var by its captured name.
    expect(code).toContain("return q; /* __ADVISOR_PAIRING__ */");
  });

  it("injection 3: CGK guard lands at top of cGK, before the env return", () => {
    const { code } = transform(buildAll());

    // The cGK function's signature, then the guard, then its original return.
    const sigPos = code.indexOf("function cGK() {");
    const guardPos = code.indexOf("__ADVISOR_CGK__");
    const envReturnPos = code.indexOf("return nH.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL;");

    expect(guardPos).toBeGreaterThan(sigPos);
    expect(envReturnPos).toBeGreaterThan(guardPos);
    // The original env return is preserved verbatim (mod-off path intact).
    expect(code).toContain("return true; /* __ADVISOR_CGK__ */");
  });

  it("injection 4: FGH guard lands at top of fGH, before the M4 allowlist check", () => {
    const { code } = transform(buildAll());

    const sigPos = code.indexOf("function fGH(H) {");
    const guardPos = code.indexOf("__ADVISOR_FGH__");
    const allowPos = code.indexOf("if (!M4(H))");

    expect(guardPos).toBeGreaterThan(sigPos);
    expect(allowPos).toBeGreaterThan(guardPos);
    expect(code).toContain("return true; /* __ADVISOR_FGH__ */");
  });

  it("is idempotent — second pass returns changed: 0 and identical code", () => {
    const first = transform(buildAll());
    const second = transform(first.code);

    expect(first.changed).toBe(4);
    expect(second.changed).toBe(0);
    expect(second.code).toBe(first.code);
  });

  it("works with different minified names across all four gates", () => {
    const input = buildAdvisorPredicate({
      fn: "isEnabled", envHelper: "truthy", providerCheck: "getProvider",
      otherCheck: "hasAccount", gb: "flag",
    }) + "\n\n" + buildAdvisorOverride({
      overrideFn: "ovr", envObj: "cfg",
    }) + "\n\n" + buildAdvisorValidity({
      validityFn: "isVal", validityParam: "M", allowFn: "listed", envObj: "cfg",
      tierVar: "t", tierFn: "tierOf", tierFloor: "MIN_TIER",
    }) + "\n\n" + buildAdvisorResolver({
      resolverFn: "resolveAdvisor", baseFn: "supports", validFn: "isValid",
      tierFn: "tierOk", resolveFn: "norm", normalizeFn: "id", log: "warnLog",
      advisorVar: "advisor", advisorArg: "A", baseArg: "B",
    });
    const { code, changed } = transform(input);

    expect(changed).toBe(4);
    // Injection 1 anchors on the DISABLE env string; predicate still patched.
    expect(code).toContain('truthy(process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL)');
    expect(code).toContain('getProvider() !== "firstParty"');
    // Injection 2 captures the advisor var + logger and reproduces them.
    expect(code).toContain("return advisor; /* __ADVISOR_PAIRING__ */");
    expect(code).toContain("${advisor} as the advisor model (pairing bypassed)");
    expect(code).toContain("warnLog(`[AdvisorTool] Server-side tool enabled");
    expect(code).not.toMatch(/\bN\(\`\[AdvisorTool\] Server-side tool enabled/);
    // Injections 3 & 4 land in the renamed cGK/fGH shapes and do not capture names.
    expect(code).toContain("function ovr() {");
    expect(code).toContain("__ADVISOR_CGK__");
    expect(code).toContain("function isVal(M) {");
    expect(code).toContain("__ADVISOR_FGH__");
    // The cGK env return is reproduced with the renamed env object, untouched.
    expect(code).toContain("return cfg.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL;");
  });

  it("returns changed: 0 when all gates are absent", () => {
    const input = "function unrelated() { return 42; }";
    const { code, changed } = transform(input);
    expect(changed).toBe(0);
    expect(code).toBe(input);
  });

  it("matches $-containing minified names (2.1.181 regression: $Oa/$He)", () => {
    // Exercise dollar-sign identifiers: word-only regexes would silently miss
    // those function names and leave required injections unapplied.
    const input = buildAdvisorPredicate({
      fn: "$Pc", envHelper: "rt", providerCheck: "Hr",
      otherCheck: "xO", gb: "ut",
    }) + "\n\n" + buildAdvisorOverride({
      overrideFn: "$Oa", envObj: "Ge",
    }) + "\n\n" + buildAdvisorValidity({
      validityFn: "$He", validityParam: "e", allowFn: "Cl", envObj: "Ge",
      tierVar: "$t", tierFn: "$tier", tierFloor: "$FLOOR",
    }) + "\n\n" + buildAdvisorResolver({
      resolverFn: "$nGK", baseFn: "$wGH", validFn: "$vGH",
      tierFn: "$xmH", resolveFn: "$gO", normalizeFn: "$D9", log: "$N",
      advisorVar: "$q", advisorArg: "$H", baseArg: "$_",
    });
    const { code, changed } = transform(input);
    expect(changed).toBe(4);
    expect(code).toContain("__ADVISOR_ENABLE__");
    expect(code).toContain("__ADVISOR_CGK__");
    expect(code).toContain("__ADVISOR_FGH__");
    expect(code).toContain("__ADVISOR_PAIRING__");
    // The renamed $Oa/$He functions are located and the env-return / allowlist
    // preserved with the $-bearing identifiers.
    expect(code).toContain("function $Oa() {");
    expect(code).toContain("return Ge.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL;");
    expect(code).toContain("function $He(e) {");
    expect(code).toContain("if (!Cl(e))");
    // Injection 2 reproduces the captured $-bearing advisor var + logger.
    expect(code).toContain("return $q; /* __ADVISOR_PAIRING__ */");
    expect(code).toContain("$N(`[AdvisorTool] Server-side tool enabled");
  });

  it("injection 1 only (others absent): changed: 1, ENABLE marker only", () => {
    const { code, changed } = transform(buildAdvisorPredicate());

    expect(changed).toBe(1);
    expect(code).toContain("__ADVISOR_ENABLE__");
    expect(code).not.toContain("__ADVISOR_CGK__");
    expect(code).not.toContain("__ADVISOR_FGH__");
    expect(code).not.toContain("__ADVISOR_PAIRING__");
  });

  it("injection 2 only (others absent): changed: 1, PAIRING marker only", () => {
    const { code, changed } = transform(buildAdvisorResolver());

    expect(changed).toBe(1);
    expect(code).toContain("__ADVISOR_PAIRING__");
    expect(code).not.toContain("__ADVISOR_ENABLE__");
    expect(code).not.toContain("__ADVISOR_CGK__");
    expect(code).not.toContain("__ADVISOR_FGH__");
  });

  it("injection 3 only (others absent): changed: 1, CGK marker only", () => {
    const { code, changed } = transform(buildAdvisorOverride());

    expect(changed).toBe(1);
    expect(code).toContain("__ADVISOR_CGK__");
    expect(code).not.toContain("__ADVISOR_ENABLE__");
    expect(code).not.toContain("__ADVISOR_FGH__");
    expect(code).not.toContain("__ADVISOR_PAIRING__");
  });

  it("injection 4 only (others absent): changed: 1, FGH marker only", () => {
    const { code, changed } = transform(buildAdvisorValidity());

    expect(changed).toBe(1);
    expect(code).toContain("__ADVISOR_FGH__");
    expect(code).not.toContain("__ADVISOR_ENABLE__");
    expect(code).not.toContain("__ADVISOR_CGK__");
    expect(code).not.toContain("__ADVISOR_PAIRING__");
  });

  it("preserves the explicit DISABLE kill switch", () => {
    const { code } = transform(buildAll());
    expect(code).toMatch(/if \(\w+\(process\.env\.CLAUDE_CODE_DISABLE_ADVISOR_TOOL\)\)\s*\{\s*return false;/);
  });

  it("ENABLE guard returns true (bypasses provider + flag when mod on)", () => {
    const { code } = transform(buildAll());
    expect(code).toMatch(/return true; \/\* __ADVISOR_ENABLE__ \*\//);
  });

  it("generated code parses as valid JS", () => {
    const { parse } = require("@babel/parser");
    const { code } = transform(buildAll());
    expect(() => parse(code, { sourceType: "script" })).not.toThrow();
  });

  it("matches the applied status_test regex when all four markers present", () => {
    const { code } = transform(buildAll());
    expect(() => assertAppliedRegex("unlock_advisor", code)).not.toThrow();
  });

  it("fails the applied status_test when only injections 1 & 2 apply (selection-layer drift)", () => {
    // Simulate cGK/fGH drift: predicate + resolver patch (ENABLE + PAIRING) but
    // the selection/UI gates are absent. The tightened applied test requires all
    // four markers in order, so the missing CGK/FGH (between ENABLE and PAIRING)
    // must make this throw — otherwise the advisor enables but the picker stays
    // empty and the warning still prints on a proxy.
    const input = buildAdvisorPredicate() + "\n\n" + buildAdvisorResolver();
    const { code } = transform(input);
    expect(() => assertAppliedRegex("unlock_advisor", code)).toThrow();
  });
});

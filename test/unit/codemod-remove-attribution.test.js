import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { randomUUID } from "crypto";

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-remove-attribution.cjs");

// Babel parsing in execSync is slow on CI runners — increase per-test timeout
// (bun:test default is 5000ms which is too tight for spawning Node + Babel).
const TIMEOUT = 30000;
const FIXTURES_DIR = path.join(process.cwd(), "test/fixtures");

function runCodemod(inputCode) {
  const tempInput = path.join(FIXTURES_DIR, `temp-input-${randomUUID()}.js`);
  const tempOutput = path.join(FIXTURES_DIR, `temp-output-${randomUUID()}.js`);

  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  fs.writeFileSync(tempInput, inputCode);

  try {
    execSync(`node "${CODEMOD_PATH}" "${tempInput}" "${tempOutput}"`, {
      stdio: "pipe",
      cwd: process.cwd(),
    });

    return fs.readFileSync(tempOutput, "utf8");
  } finally {
    if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
    if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
  }
}

// Build a fixture that mimics the 2.1.98 structure where T1/T2 "powered by"
// string is NOT in the statement immediately after the var declaration.
function buildV2198Fixture(names) {
  const {
    t1fn, t1var, t1blockVar, t1extraVar,
    t2fn, t2var, t2blockVar, t2extraVar,
    t3fn, t3remoteCheckVar,
    t4fn,
    t5fn, t5var,
    t6fn, t6reviewerVar, t6addReviewerVar,
  } = names;

  return `
// Transform 1: computeEnvInfo — powered-by string in later statement, not adjacent
function ${t1fn}() {
  var ${t1var} = "";
  {
    var ${t1extraVar} = "unrelated string";
  }
  var ${t1extraVar}2 = true ? "a" : "b";
  {
    var ${t1blockVar} = "You are powered by the model " + "claude-sonnet-4-6";
    ${t1var} = ${t1blockVar};
  }
  return ${t1var};
}

// Transform 2: computeSimpleEnvInfo — same non-adjacent pattern
function ${t2fn}() {
  var ${t2var} = null;
  {
    var ${t2extraVar} = "unrelated string";
  }
  var ${t2extraVar}2 = false ? "x" : "y";
  {
    var ${t2blockVar} = "You are powered by the model " + "claude-haiku-4-5";
    ${t2var} = ${t2blockVar};
  }
  return ${t2var};
}

// Transform 3: getAttributionTexts (noreply@anthropic.com)
function ${t3fn}() {
  if (${t3remoteCheckVar}) {
    return { commit: "", pr: "" };
  }
  var email = "noreply@anthropic.com";
  return { commit: "Authored-by: " + email, pr: "PR attribution" };
}

// Transform 4: Enhanced PR attribution (-shotted by)
function ${t4fn}() {
  return "This was -shotted by an automated process";
}

// Transform 5: /commit prompt (Committing changes with git)
function ${t5fn}() {
  return "Committing changes with git. Please review the diff.";
}

// Transform 6: commit-push-pr prompt (anthropics/claude-code)
function ${t6fn}() {
  var ${t6reviewerVar} = "https://github.com/anthropics/claude-code/pull/123";
  var ${t6addReviewerVar} = "gh pr edit --add-reviewer reviewer";
  return "Created PR: " + ${t6reviewerVar} + " Co-Authored-By: claude";
}
`;
}

// v2.1.98 style names (with extra vars for non-adjacent statements)
const namesV2198 = {
  t1fn: "envInfoFn", t1var: "envResult", t1blockVar: "modelStr", t1extraVar: "tmpA",
  t2fn: "simpleEnvFn", t2var: "simpleResult", t2blockVar: "simpleStr", t2extraVar: "tmpB",
  t3fn: "attrFn", t3remoteCheckVar: "isRemote",
  t4fn: "prAttrFn",
  t5fn: "commitFn", t5var: "commitMsg",
  t6fn: "pushPRFn", t6reviewerVar: "prLink", t6addReviewerVar: "reviewCmd",
};

// Build a complete fixture with all 6 target functions.
// Names are parameterized for varied minified name testing.
function buildFullFixture(names) {
  const {
    // Transform 1: computeEnvInfo
    t1fn, t1var, t1blockVar,
    // Transform 2: computeSimpleEnvInfo
    t2fn, t2var, t2blockVar,
    // Transform 3: getAttributionTexts
    t3fn, t3remoteCheckVar,
    // Transform 4: Enhanced PR attribution
    t4fn,
    // Transform 5: /commit prompt
    t5fn, t5var,
    // Transform 6: commit-push-pr prompt
    t6fn, t6reviewerVar, t6addReviewerVar,
  } = names;

  return `
// Transform 1: computeEnvInfo (var init "")
function ${t1fn}() {
  var ${t1var} = "";
  {
    var ${t1blockVar} = "You are powered by the model " + "claude-sonnet-4-6";
    ${t1var} = ${t1blockVar};
  }
  return ${t1var};
}

// Transform 2: computeSimpleEnvInfo (var init null)
function ${t2fn}() {
  var ${t2var} = null;
  {
    var ${t2blockVar} = "You are powered by the model " + "claude-haiku-4-5";
    ${t2var} = ${t2blockVar};
  }
  return ${t2var};
}

// Transform 3: getAttributionTexts (noreply@anthropic.com)
function ${t3fn}() {
  if (${t3remoteCheckVar}) {
    return { commit: "", pr: "" };
  }
  var email = "noreply@anthropic.com";
  return { commit: "Authored-by: " + email, pr: "PR attribution" };
}

// Transform 4: Enhanced PR attribution (-shotted by)
function ${t4fn}() {
  return "This was -shotted by an automated process";
}

// Transform 5: /commit prompt (Committing changes with git)
function ${t5fn}() {
  return "Committing changes with git. Please review the diff.";
}

// Transform 6: commit-push-pr prompt (anthropics/claude-code)
function ${t6fn}() {
  var ${t6reviewerVar} = "https://github.com/anthropics/claude-code/pull/123";
  var ${t6addReviewerVar} = "gh pr edit --add-reviewer reviewer";
  return "Created PR: " + ${t6reviewerVar} + " Co-Authored-By: claude";
}
`;
}

// v2.1.92 style names
const namesV2192 = {
  t1fn: "JiK1", t1var: "Y1", t1blockVar: "B1",
  t2fn: "JiK2", t2var: "Y2", t2blockVar: "B2",
  t3fn: "JiK3", t3remoteCheckVar: "isRemote",
  t4fn: "JiK4",
  t5fn: "JiK5", t5var: "commitPrompt",
  t6fn: "JiK6", t6reviewerVar: "reviewerUrl", t6addReviewerVar: "addReviewerCmd",
};

// v2.1.94+ style names
const namesV2194 = {
  t1fn: "computeEnv", t1var: "envStr", t1blockVar: "block1",
  t2fn: "computeSimple", t2var: "simpleStr", t2blockVar: "block2",
  t3fn: "getAttribution", t3remoteCheckVar: "isRemoteSession",
  t4fn: "enhancedPRAttribution",
  t5fn: "commitPromptFn", t5var: "commitMsg",
  t6fn: "pushPRPrompt", t6reviewerVar: "prUrl", t6addReviewerVar: "reviewerCmd",
};

// v2.1.98 T6 style: uses --reviewer instead of Co-Authored-By (real 2.1.98 structure)
const namesV2198T6 = {
  t1fn: "t1fn", t1var: "t1var", t1blockVar: "t1block",
  t2fn: "t2fn", t2var: "t2var", t2blockVar: "t2block",
  t3fn: "t3fn", t3remoteCheckVar: "isRemote",
  t4fn: "t4fn",
  t5fn: "t5fn", t5var: "commitMsg",
  t6fn: "khK",
};

// Build a 2.1.98-style fixture where T6 uses --reviewer pattern (no Co-Authored-By)
function buildV2198T6Fixture(names) {
  return `
// T1: computeEnvInfo
function ${names.t1fn}() {
  var ${names.t1var} = "";
  {
    var ${names.t1blockVar} = "You are powered by the model " + "claude-sonnet-4-6";
    ${names.t1var} = ${names.t1blockVar};
  }
  return ${names.t1var};
}

// T2: computeSimpleEnvInfo
function ${names.t2fn}() {
  var ${names.t2var} = null;
  {
    var ${names.t2blockVar} = "You are powered by the model " + "claude-haiku-4-5";
    ${names.t2var} = ${names.t2blockVar};
  }
  return ${names.t2var};
}

// T3: getAttributionTexts
function ${names.t3fn}() {
  if (${names.t3remoteCheckVar}) { return {commit:"",pr:""}; }
  var email = "noreply@anthropic.com";
  return { commit: "Authored-by: " + email, pr: "PR attribution" };
}

// T4: Enhanced PR attribution
function ${names.t4fn}() {
  return "This was -shotted by an automated process";
}

// T5: /commit prompt
function ${names.t5fn}() {
  return "Committing changes with git. Please review.";
}

// T6: 2.1.98-style — vars contain both --reviewer AND anthropics/claude-code
// No Co-Authored-By anywhere in the function
function ${names.t6fn}(q, K) {
  let w = "";
  let rVar = " and \`--reviewer anthropics/claude-code\`";
  let aVar = " (and add \`--add-reviewer anthropics/claude-code\`)";
  return "Create PR with" + rVar + aVar + " details: " + w;
}
`;
}

describe("codemod-remove-attribution", () => {
  describe("all 6 transforms with v2.1.92 style names", () => {
    it("applies all 6 transforms successfully", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture(namesV2192);

      const output = runCodemod(input);

      // All transforms inject __isModEnabled__("remove_attribution")
      const modCheckCount = (output.match(/remove_attribution/g) || []).length;
      expect(modCheckCount).toBeGreaterThanOrEqual(6);
    });

    it("includes UNDERCOVER MODE ACTIVE text from Phase 2", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture(namesV2192);

      const output = runCodemod(input);

      expect(output).toContain("UNDERCOVER MODE ACTIVE");
      expect(output).toContain("Co-Authored-By");
    });
  });

  describe("all 6 transforms with v2.1.94+ style names", () => {
    it("applies all 6 transforms with different names", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture(namesV2194);

      const output = runCodemod(input);

      const modCheckCount = (output.match(/remove_attribution/g) || []).length;
      expect(modCheckCount).toBeGreaterThanOrEqual(6);
    });
  });

  describe("v2.1.98 structure — non-adjacent powered-by blocks", () => {
    it("applies all 6 transforms with non-adjacent T1/T2 blocks", { timeout: TIMEOUT }, () => {
      const input = buildV2198Fixture(namesV2198);

      const output = runCodemod(input);

      const modCheckCount = (output.match(/remove_attribution/g) || []).length;
      expect(modCheckCount).toBeGreaterThanOrEqual(6);
      expect(output).toContain("UNDERCOVER MODE ACTIVE");
    });

    it("T1 clears model var despite powered-by block not being adjacent", { timeout: TIMEOUT }, () => {
      const input = buildV2198Fixture(namesV2198);

      const output = runCodemod(input);

      expect(output).toContain('envResult = ""');
    });

    it("T2 clears model var with adjacent blocks (v2.1.92 fixture)", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture(namesV2192);

      // Verify old fixture still works (adjacent blocks)
      const output = runCodemod(input);
      expect(output).toContain('Y2 = ""');
    });
  });

  describe("v2.1.98 T6 — --reviewer pattern (no Co-Authored-By)", () => {
    it("applies all 6 transforms with --reviewer T6 fixture", { timeout: TIMEOUT }, () => {
      const input = buildV2198T6Fixture(namesV2198T6);

      const output = runCodemod(input);

      const modCheckCount = (output.match(/remove_attribution/g) || []).length;
      expect(modCheckCount).toBeGreaterThanOrEqual(6);
      expect(output).toContain("UNDERCOVER MODE ACTIVE");
    });

    it("T6 nullifies both --reviewer vars", { timeout: TIMEOUT }, () => {
      const input = buildV2198T6Fixture(namesV2198T6);

      const output = runCodemod(input);

      // rVar and aVar (the two --reviewer vars) should both be set to ""
      expect(output).toContain('rVar = ""');
      expect(output).toContain('aVar = ""');
    });

    it("T6 wraps return with undercover prefix marker", { timeout: TIMEOUT }, () => {
      const input = buildV2198T6Fixture(namesV2198T6);

      const output = runCodemod(input);

      expect(output).toContain("__uc_pr_result");
      expect(output).toContain("UNDERCOVER MODE ACTIVE");
    });
  });

  describe("T6 discrimination — Co-Authored-By / --reviewer pre-filter", () => {
    it("rejects functions with anthropics/claude-code but without Co-Authored-By or --reviewer", { timeout: TIMEOUT }, () => {
      // This function has "anthropics/claude-code" but is NOT the commit-push-pr prompt
      const input = `
function ${namesV2192.t1fn}() {
  var ${namesV2192.t1var} = "";
  { var ${namesV2192.t1blockVar} = "You are powered by the model " + "claude-sonnet-4-6"; ${namesV2192.t1var} = ${namesV2192.t1blockVar}; }
  return ${namesV2192.t1var};
}
function ${namesV2192.t2fn}() {
  var ${namesV2192.t2var} = null;
  { var ${namesV2192.t2blockVar} = "You are powered by the model " + "claude-haiku-4-5"; ${namesV2192.t2var} = ${namesV2192.t2blockVar}; }
  return ${namesV2192.t2var};
}
function ${namesV2192.t3fn}() {
  if (${namesV2192.t3remoteCheckVar}) { return {commit:"",pr:""}; }
  var email = "noreply@anthropic.com";
  return { commit: "Authored-by: " + email, pr: "PR attribution" };
}
function ${namesV2192.t4fn}() {
  return "This was -shotted by an automated process";
}
function ${namesV2192.t5fn}() {
  return "Committing changes with git. Please review.";
}
// Decoy: has "anthropics/claude-code" but no "--reviewer" and no "Co-Authored-By" — rejected
function decoyFn() {
  var repoUrl = "https://github.com/anthropics/claude-code";
  return "Check repo: " + repoUrl;
}
// Real T6 target: has both "anthropics/claude-code" AND "Co-Authored-By"
function ${namesV2192.t6fn}() {
  var ${namesV2192.t6reviewerVar} = "https://github.com/anthropics/claude-code/pull/123";
  var ${namesV2192.t6addReviewerVar} = "gh pr edit --add-reviewer reviewer";
  return "Created PR: " + ${namesV2192.t6reviewerVar} + " Co-Authored-By: claude";
}
`;
      // Should still get exactly 6 transforms (decoy is rejected by Co-Authored-By filter)
      const output = runCodemod(input);
      const modCheckCount = (output.match(/remove_attribution/g) || []).length;
      expect(modCheckCount).toBeGreaterThanOrEqual(6);
      // Decoy function body must NOT contain the mod guard — proves it was rejected
      const decoyFnMatch = output.match(/function decoyFn\(\)\s*\{[^}]+\}/s);
      expect(decoyFnMatch).toBeTruthy();
      expect(decoyFnMatch[0]).not.toContain("remove_attribution");
    });

    it("rejects function with Co-Authored-By but no reviewerVar", { timeout: TIMEOUT }, () => {
      const input = `
function ${namesV2192.t1fn}() {
  var ${namesV2192.t1var} = "";
  { var ${namesV2192.t1blockVar} = "You are powered by the model " + "claude-sonnet-4-6"; ${namesV2192.t1var} = ${namesV2192.t1blockVar}; }
  return ${namesV2192.t1var};
}
function ${namesV2192.t2fn}() {
  var ${namesV2192.t2var} = null;
  { var ${namesV2192.t2blockVar} = "You are powered by the model " + "claude-haiku-4-5"; ${namesV2192.t2var} = ${namesV2192.t2blockVar}; }
  return ${namesV2192.t2var};
}
function ${namesV2192.t3fn}() {
  if (${namesV2192.t3remoteCheckVar}) { return {commit:"",pr:""}; }
  var email = "noreply@anthropic.com";
  return { commit: "Authored-by: " + email, pr: "PR attribution" };
}
function ${namesV2192.t4fn}() {
  return "This was -shotted by an automated process";
}
function ${namesV2192.t5fn}() {
  return "Committing changes with git. Please review.";
}
// Decoy: has both strings but no var decl with "anthropics/claude-code" init (no reviewerVar)
// The "anthropics/claude-code" appears only as a function argument, not a var init
function decoyWithReturn() {
  return "Co-Authored-By: claude " + fetchPR("anthropics/claude-code");
}
// Real T6 target
function ${namesV2192.t6fn}() {
  var ${namesV2192.t6reviewerVar} = "https://github.com/anthropics/claude-code/pull/123";
  var ${namesV2192.t6addReviewerVar} = "gh pr edit --add-reviewer reviewer";
  return "Created PR: " + ${namesV2192.t6reviewerVar} + " Co-Authored-By: claude";
}
`;
      const output = runCodemod(input);
      const modCheckCount = (output.match(/remove_attribution/g) || []).length;
      expect(modCheckCount).toBeGreaterThanOrEqual(6);
      // Decoy function body must NOT contain the mod guard — proves it was rejected
      const decoyMatch = output.match(/function decoyWithReturn\(\)\s*\{[^}]+\}/s);
      expect(decoyMatch).toBeTruthy();
      expect(decoyMatch[0]).not.toContain("remove_attribution");
    });
  });

  describe("individual transform verification", () => {
    it("transform 1: clears model var initialized to empty string", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture(namesV2192);

      const output = runCodemod(input);

      // After the block containing "You are powered by", should have guard
      expect(output).toContain('Y1 = ""');
    });

    it("transform 2: clears model var initialized to null", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture(namesV2192);

      const output = runCodemod(input);

      // Should have guard that sets var to ""
      expect(output).toContain('Y2 = ""');
    });

    it("transform 3: inserts early return {commit:'',pr:''}", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture(namesV2192);

      const output = runCodemod(input);

      // Should have early return with commit: "" and pr: ""
      expect(output).toMatch(/commit:\s*""/);
      expect(output).toMatch(/pr:\s*""/);
    });

    it("transform 4: inserts early return empty string", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture(namesV2192);

      const output = runCodemod(input);

      // Should have guard that returns ""
      expect(output).toContain("remove_attribution");
    });

    it("transform 5: wraps commit return with prefix", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture(namesV2192);

      const output = runCodemod(input);

      // Should contain __uc_result variable and UNDERCOVER prefix
      expect(output).toContain("__uc_result");
      expect(output).toContain("UNDERCOVER MODE ACTIVE");
    });

    it("transform 6: wraps return with undercover prefix", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture(namesV2192);

      const output = runCodemod(input);

      // Should wrap return with prefix marker
      expect(output).toContain("__uc_pr_result");
      expect(output).toContain("UNDERCOVER MODE ACTIVE");
    });

    it("transform 6: nullifies both reviewerUrl and addReviewerCmd in legacy fixture", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture(namesV2192);

      const output = runCodemod(input);

      // Both vars must be nullified: reviewerUrl (anthropics/claude-code) and addReviewerCmd (--add-reviewer)
      expect(output).toContain('reviewerUrl = ""');
      expect(output).toContain('addReviewerCmd = ""');
    });

    it("transform 6: nullifies both vars with v2.1.94 names too", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture(namesV2194);

      const output = runCodemod(input);

      expect(output).toContain('prUrl = ""');
      expect(output).toContain('reviewerCmd = ""');
    });
  });

  describe("preserve surrounding code", () => {
    it("does not modify unrelated functions", { timeout: TIMEOUT }, () => {
      const input = `
function unrelated(x) { return x + 1; }

${buildFullFixture(namesV2192)}

function alsoUnrelated() { return 42; }
`;

      const output = runCodemod(input);

      expect(output).toContain("return x + 1");
      expect(output).toContain("return 42");
    });
  });

  describe("edge cases", () => {
    it("rejects code with missing transforms (fail-closed)", { timeout: TIMEOUT }, () => {
      // Only 5 of 6 transforms would match
      const input = `
// T1: computeEnvInfo
function fn1() {
  var Y = "";
  { var B = "You are powered by the model"; Y = B; }
  return Y;
}

// T2: computeSimpleEnvInfo
function fn2() {
  var Y = null;
  { var B = "You are powered by the model"; Y = B; }
  return Y;
}

// T3: getAttributionTexts
function fn3() {
  if (isRemote) { return {commit:"",pr:""}; }
  var e = "noreply@anthropic.com";
  return {commit: e, pr: "attr"};
}

// T4: Enhanced PR attribution
function fn4() {
  return "This was -shotted by an automated process";
}

// T5: commit prompt
function fn5() {
  return "Committing changes with git. Please review.";
}

// Missing T6 (no anthropics/claude-code)
`;

      expect(() => runCodemod(input)).toThrow(/expected 6 transforms, got 5/);
    });

    it("is idempotent — already transformed code is a no-op", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture(namesV2192);
      const output1 = runCodemod(input);

      // Running again: isAlreadyPatched detects existing __isModEnabled__("remove_attribution")
      expect(() => runCodemod(output1)).toThrow(/expected 6 transforms, got 0/);
    });
  });
});

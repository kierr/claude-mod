import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const parser = require(path.join(process.cwd(), "codemods/node_modules/@babel/parser"));

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-retry-all-errors.cjs");

const TIMEOUT = 30000;

/**
 * Build a zw3 429 return block fixture with configurable minified names.
 * This verifies the codemod works regardless of what names webcrack produces.
 */
function buildPatternCFixture(names = {}) {
  const {
    varName = "H",
    fn1 = "Lq",
    fn2 = "faH",
  } = names;

  return `    if (${varName}.status === 429) {
      return !${fn1}() || ${fn2}();
    }`;
}

describe("codemod-retry-all-errors", () => {
  function runCodemod(inputCode) {
    const tempInput = path.join(process.cwd(), "test/fixtures", `temp-input-${randomUUID()}.js`);
    const tempOutput = path.join(process.cwd(), "test/fixtures", `temp-output-${randomUUID()}.js`);

    fs.mkdirSync(path.join(process.cwd(), "test/fixtures"), { recursive: true });
    fs.writeFileSync(tempInput, inputCode);

    try {
      const { execSync } = require("child_process");
      execSync(`node "${CODEMOD_PATH}" "${tempInput}" "${tempOutput}"`, {
        stdio: "pipe",
        cwd: process.cwd()
      });

      const output = fs.readFileSync(tempOutput, "utf8");

      // Cleanup
      fs.unlinkSync(tempInput);
      fs.unlinkSync(tempOutput);

      return output;
    } catch (error) {
      // Cleanup on error
      if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
      if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
      throw error;
    }
  }

  describe("Pattern C: zw3 429 return block", () => {
    it("should insert __isModEnabled__ + __getModConfig__ guard inside 429 block", { timeout: TIMEOUT }, () => {
      const input = buildPatternCFixture();
      const output = runCodemod(input);

      expect(output).toContain('__getModConfig__("fix_request_resilience", "enabled", true)');
      expect(output).toContain('typeof __getModConfig__ === "function"');
      expect(output).toContain('__isModEnabled__("fix_request_resilience")');
      expect(output).toContain('typeof __isModEnabled__ === "function"');
    });

    it("should preserve the 429 conditional return as fallback", { timeout: TIMEOUT }, () => {
      const input = buildPatternCFixture({ fn1: "Lq", fn2: "faH" });
      const output = runCodemod(input);

      expect(output).toContain("return !Lq() || faH()");
    });

    it("should preserve the 429 status check", { timeout: TIMEOUT }, () => {
      const input = buildPatternCFixture();
      const output = runCodemod(input);

      expect(output).toContain("if (H.status === 429)");
    });

    it("should insert guard before the conditional return", { timeout: TIMEOUT }, () => {
      const input = buildPatternCFixture();
      const output = runCodemod(input);

      // __getModConfig__ should appear before the conditional return
      const guardIndex = output.indexOf('__getModConfig__("fix_request_resilience"');
      const returnIndex = output.indexOf("return !Lq() || faH()");
      expect(guardIndex).toBeGreaterThan(-1);
      expect(returnIndex).toBeGreaterThan(guardIndex);
    });

    it("should work with different minified function names (release A)", { timeout: TIMEOUT }, () => {
      const input = buildPatternCFixture({ fn1: "r7", fn2: "Ak8" });
      const output = runCodemod(input);

      expect(output).toContain('__getModConfig__("fix_request_resilience"');
      expect(output).toContain("return !r7() || Ak8()");
    });

    it("should work with different minified function names (release B)", { timeout: TIMEOUT }, () => {
      const input = buildPatternCFixture({ fn1: "checkFn", fn2: "bypassFn" });
      const output = runCodemod(input);

      expect(output).toContain('__getModConfig__("fix_request_resilience"');
      expect(output).toContain("return !checkFn() || bypassFn()");
    });

    it("should work with single-letter minified names", { timeout: TIMEOUT }, () => {
      const input = buildPatternCFixture({ fn1: "a", fn2: "b" });
      const output = runCodemod(input);

      expect(output).toContain('__getModConfig__("fix_request_resilience"');
      expect(output).toContain("return !a() || b()");
    });

    it("should work with dollar-sign-containing names", { timeout: TIMEOUT }, () => {
      const input = buildPatternCFixture({ fn1: "$check", fn2: "fn$2" });
      const output = runCodemod(input);

      expect(output).toContain('__getModConfig__("fix_request_resilience"');
      expect(output).toContain("return !$check() || fn$2()");
    });

    it("should work with different variable name", { timeout: TIMEOUT }, () => {
      const input = buildPatternCFixture({ varName: "q", fn1: "i7", fn2: "MV8" });
      const output = runCodemod(input);

      expect(output).toContain('__getModConfig__("fix_request_resilience"');
      expect(output).toContain("return !i7() || MV8()");
    });
  });

  describe("typeof safety guard", () => {
    it("should include typeof __isModEnabled__ guard", { timeout: TIMEOUT }, () => {
      const input = buildPatternCFixture();
      const output = runCodemod(input);

      expect(output).toContain('typeof __isModEnabled__ === "function"');
    });

    it("should include typeof __getModConfig__ guard", { timeout: TIMEOUT }, () => {
      const input = buildPatternCFixture();
      const output = runCodemod(input);

      expect(output).toContain('typeof __getModConfig__ === "function"');
    });

    it("should check typeof before calling __isModEnabled__ and __getModConfig__", { timeout: TIMEOUT }, () => {
      const input = buildPatternCFixture();
      const output = runCodemod(input);

      const typeofIsModIndex = output.indexOf('typeof __isModEnabled__');
      const isModCallIndex = output.indexOf('__isModEnabled__("fix_request_resilience"');
      expect(typeofIsModIndex).toBeLessThan(isModCallIndex);
      expect(typeofIsModIndex).toBeGreaterThan(-1);
      expect(isModCallIndex).toBeGreaterThan(-1);

      const typeofConfigIndex = output.indexOf('typeof __getModConfig__');
      const configCallIndex = output.indexOf('__getModConfig__("fix_request_resilience"');
      expect(typeofConfigIndex).toBeLessThan(configCallIndex);
      expect(typeofConfigIndex).toBeGreaterThan(-1);
      expect(configCallIndex).toBeGreaterThan(-1);
    });
  });

  describe("idempotency", () => {
    it("should not double-insert the guard on second run", { timeout: TIMEOUT }, () => {
      const input = buildPatternCFixture();
      const once = runCodemod(input);

      const twice = runCodemod(once);

      const onceCount = (once.match(/__getModConfig__/g) || []).length;
      const twiceCount = (twice.match(/__getModConfig__/g) || []).length;
      expect(twiceCount).toBe(onceCount);
    });

    it("should have same output on repeated runs", { timeout: TIMEOUT }, () => {
      const input = buildPatternCFixture();
      const once = runCodemod(input);
      const twice = runCodemod(once);
      const thrice = runCodemod(twice);

      expect(once).toBe(twice);
      expect(twice).toBe(thrice);
    });
  });

  describe("Pattern B: SDK shouldRetry (2.1.140+)", () => {
    function buildPatternBFixture(names = {}) {
      const { varName = "H" } = names;
      return `    // x-should-retry header handling
    if (${varName}.status === 429) {
      return true;
    }
    if (${varName}.status >= 500) {
      return true;
    }
    return false;`;
    }

    it("should insert __isModEnabled__ + __getModConfig__ guard before return false (Pattern B)", { timeout: TIMEOUT }, () => {
      const input = buildPatternBFixture();
      const output = runCodemod(input);

      expect(output).toContain('__getModConfig__("fix_request_resilience", "enabled", true)');
      expect(output).toContain('typeof __getModConfig__ === "function"');
      expect(output).toContain('__isModEnabled__("fix_request_resilience")');
      expect(output).toContain('typeof __isModEnabled__ === "function"');
    });

    it("should preserve the original status checks (Pattern B)", { timeout: TIMEOUT }, () => {
      const input = buildPatternBFixture({ varName: "H" });
      const output = runCodemod(input);

      expect(output).toContain("if (H.status === 429)");
      expect(output).toContain("if (H.status >= 500)");
      expect(output).toContain("return false;");
    });

    it("should work with different variable names (Pattern B)", { timeout: TIMEOUT }, () => {
      const input = buildPatternBFixture({ varName: "resp" });
      const output = runCodemod(input);

      expect(output).toContain('__getModConfig__("fix_request_resilience"');
      expect(output).toContain("if (resp.status === 429)");
    });

    it("should be idempotent (Pattern B)", { timeout: TIMEOUT }, () => {
      const input = buildPatternBFixture();
      const once = runCodemod(input);
      const twice = runCodemod(once);

      expect(once).toBe(twice);
    });

    it("should not match Pattern B without x-should-retry anchor", { timeout: TIMEOUT }, () => {
      const input = `    if (H.status === 429) {
      return true;
    }
    if (H.status >= 500) {
      return true;
    }
    return false;`;
      const output = runCodemod(input);

      expect(output).not.toContain("__getModConfig__");
      expect(output).toBe(input);
    });
  });

  describe("no-match cases", () => {
    it("should not transform SDK shouldRetry without x-should-retry anchor", { timeout: TIMEOUT }, () => {
      const input = `    if (q.status === 429) {
      return true;
    }
    if (q.status && q.status >= 500) {
      return true;
    }
    return false;`;
      const output = runCodemod(input);

      expect(output).not.toContain("__getModConfig__");
      expect(output).toBe(input);
    });

    it("should not transform unrelated if blocks", { timeout: TIMEOUT }, () => {
      const input = `    if (someOtherCondition) {
      doSomething();
    }`;
      const output = runCodemod(input);

      expect(output).not.toContain("__getModConfig__");
    });

    it("should not transform empty code", { timeout: TIMEOUT }, () => {
      const output = runCodemod("");
      expect(output).not.toContain("__getModConfig__");
      expect(output).toBe("");
    });

    it("should not transform code without the 429 conditional return pattern", { timeout: TIMEOUT }, () => {
      const input = `    if (q.status === 408) {
      return true;
    }
    if (q.status && q.status >= 500) {
      return true;
    }
    return false;`;
      const output = runCodemod(input);

      expect(output).not.toContain("__getModConfig__");
    });
  });

  describe("structural integrity", () => {
    it("should preserve the conditional return structure for 429", { timeout: TIMEOUT }, () => {
      const input = buildPatternCFixture({ fn1: "Lq", fn2: "faH" });
      const output = runCodemod(input);

      expect(output).toMatch(/return\s+!\s*Lq\(\s*\)\s*\|\|\s*faH\(\s*\)/);
    });

    it("should produce syntactically valid JS when wrapped in a function", { timeout: TIMEOUT }, () => {
      const input = buildPatternCFixture();
      const output = runCodemod(input);

      const wrapped = `function zw3(H) {\n${output}\n}`;
      try {
        parser.parse(wrapped, { sourceType: "module" });
      } catch (e) {
        throw new Error(`Output is not valid JS: ${e.message}\n${output}`);
      }
    });

    it("should maintain proper indentation", { timeout: TIMEOUT }, () => {
      const input = buildPatternCFixture();
      const output = runCodemod(input);

      const lines = output.split("\n");
      const guardLine = lines.find(line => line.includes("__getModConfig__"));
      expect(guardLine).toBeDefined();
      expect(guardLine?.startsWith(" ")).toBe(true);

      const returnLine = lines.find(line => line.includes("return !Lq() || faH()"));
      expect(returnLine).toBeDefined();
      expect(returnLine?.startsWith("      ")).toBe(true);
    });
  });

  describe("error handling", () => {
    it("should report when no match is found", { timeout: TIMEOUT }, () => {
      const input = `    function unrelated() {
      return 42;
    }`;
      const output = runCodemod(input);

      expect(output).not.toContain("__getModConfig__");
    });

    it("should handle malformed input gracefully", { timeout: TIMEOUT }, () => {
      const input = `if (q.status === 429) { return true; }`;
      const output = runCodemod(input);

      expect(output).not.toContain("__getModConfig__");
    });
  });

  describe("Pattern C2: x-should-retry:\"true\" tier-gate un-nerf", () => {
    // The subscriber-tier gate (!FN() || FN()) in the x-should-retry:"true"
    // branch must be neutralized so retry is unconditional regardless of tier.
    function buildC2Fixture(names = {}) {
      const { headerVar = "_", notSubFn = "Lq", entFn = "OsH" } = names;
      return `    let ${headerVar} = H.headers?.get("x-should-retry");
    if (${headerVar} === "true" && (!${notSubFn}() || ${entFn}())) {
      return true;
    }`;
    }

    it("wraps the tier conjunct with the mod guard (true gate)", { timeout: TIMEOUT }, () => {
      const output = runCodemod(buildC2Fixture());
      // The guard is inserted before the original (!Lq() || OsH()) so the
      // branch fires regardless of subscriber tier when the mod is on.
      expect(output).toContain('=== "true" && (typeof __isModEnabled__');
      expect(output).toContain("__isModEnabled__(\"fix_request_resilience\")");
      // Original tier conjunct preserved as the guard's else branch.
      expect(output).toContain("(!Lq() || OsH())");
    });

    it("works with different minified tier-function names", { timeout: TIMEOUT }, () => {
      const output = runCodemod(buildC2Fixture({ notSubFn: "isSub", entFn: "isEnt" }));
      expect(output).toContain('=== "true" && (typeof __isModEnabled__');
      expect(output).toContain("(!isSub() || isEnt())");
    });

    it("is idempotent (re-run does not double-wrap)", { timeout: TIMEOUT }, () => {
      const once = runCodemod(buildC2Fixture());
      const twice = runCodemod(once);
      // The C2 gate shape no longer matches once the guard is in front of the
      // conjunct (the `=== "true" && (` is now followed by `typeof`, not `!`).
      const guardCount = (twice.match(/typeof __isModEnabled__/g) || []).length;
      const onceCount = (once.match(/typeof __isModEnabled__/g) || []).length;
      expect(guardCount).toBe(onceCount);
    });
  });
});

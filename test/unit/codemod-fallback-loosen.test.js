import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const parser = require(path.join(process.cwd(), "codemods/node_modules/@babel/parser"));

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-fallback-loosen.cjs");

// Babel parsing in execSync is slow on CI runners — increase per-test timeout
// (bun:test default is 5000ms which is too tight for spawning Node + Babel).
const TIMEOUT = 30000;

/**
 * Build a realistic fallback block with configurable minified names.
 * This verifies the codemod works regardless of what names webcrack produces.
 */
function buildFixture(names = {}) {
  const {
    errorCheckFn = "W26",
    errorVar = "M",
    notPrimaryFn = "p7",
    opusCheckFn = "EO6",
    modelObj = "_",
    thresholdVar = "Yt_",
  } = names;

  return `    if (${errorCheckFn}(${errorVar}) && (process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS || !${notPrimaryFn}() && ${opusCheckFn}(${modelObj}.model))) {
      ${errorVar}++;
      if (${errorVar} >= ${thresholdVar}) {
        throw new D26("Fallback triggered");
      }
    }`;
}

describe("codemod-fallback-loosen", () => {
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

  describe("basic transformation", () => {
    it("should wrap fallback condition with __getModConfig__ guards", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const output = runCodemod(input);

      expect(output).toContain('__getModConfig__("fix_request_resilience", "min_status", 500)');
      expect(output).toContain('__getModConfig__("fix_request_resilience", "all_models", true)');
      expect(output).toContain('__getModConfig__("fix_request_resilience", "threshold", 1)');
    });

    it("should preserve the original functions as fallback branches", { timeout: TIMEOUT }, () => {
      const input = buildFixture({
        errorCheckFn: "W26", notPrimaryFn: "p7", opusCheckFn: "EO6",
      });
      const output = runCodemod(input);

      // Original error check preserved in else branch
      expect(output).toContain(": W26(M)");
      // Original model check preserved
      expect(output).toContain("!p7() && EO6(_.model)");
      // Original threshold preserved
      expect(output).toContain("|| Yt_)");
    });

    it("should preserve process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const output = runCodemod(input);

      expect(output).toContain("process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS");
    });

    it("should preserve the throw statement inside the block", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const output = runCodemod(input);

      expect(output).toContain("Fallback triggered");
    });
  });

  describe("minified name resilience", () => {
    it("should work with different minified names (release A)", { timeout: TIMEOUT }, () => {
      const input = buildFixture({
        errorCheckFn: "ZB1", errorVar: "err", notPrimaryFn: "qX",
        opusCheckFn: "mK9", modelObj: "ctx", thresholdVar: "CNT",
      });
      const output = runCodemod(input);

      expect(output).toContain('__getModConfig__("fix_request_resilience"');
      // Original names preserved as fallbacks
      expect(output).toContain(": ZB1(err)");
      expect(output).toContain("!qX() && mK9(ctx.model)");
      expect(output).toContain("|| CNT)");
    });

    it("should work with different minified names (release B)", { timeout: TIMEOUT }, () => {
      const input = buildFixture({
        errorCheckFn: "a7f", errorVar: "e", notPrimaryFn: "b2",
        opusCheckFn: "c3d", modelObj: "s", thresholdVar: "max",
      });
      const output = runCodemod(input);

      expect(output).toContain('__getModConfig__("fix_request_resilience"');
      expect(output).toContain(": a7f(e)");
      expect(output).toContain("!b2() && c3d(s.model)");
      expect(output).toContain("|| max)");
    });

    it("should work with single-letter minified names", { timeout: TIMEOUT }, () => {
      const input = buildFixture({
        errorCheckFn: "f", errorVar: "x", notPrimaryFn: "g",
        opusCheckFn: "h", modelObj: "o", thresholdVar: "t",
      });
      const output = runCodemod(input);

      expect(output).toContain('__getModConfig__("fix_request_resilience"');
      expect(output).toContain(": f(x)");
      expect(output).toContain("!g() && h(o.model)");
      expect(output).toContain("|| t)");
    });
  });

  describe("typeof safety guard", () => {
    it("should include typeof __isModEnabled__ guard", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const output = runCodemod(input);

      expect(output).toContain('typeof __isModEnabled__ === "function"');
      expect(output).toContain('__isModEnabled__("fix_request_resilience")');
    });

    it("should include typeof __getModConfig__ guard", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const output = runCodemod(input);

      expect(output).toContain('typeof __getModConfig__ === "function"');
    });
  });

  describe("idempotency", () => {
    it("should not double-wrap an already-transformed block", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const once = runCodemod(input);

      // The second run should find no match (the original pattern is gone)
      const twice = runCodemod(once);

      // Count __getModConfig__ occurrences — should be same as first run
      const onceCount = (once.match(/__getModConfig__/g) || []).length;
      const twiceCount = (twice.match(/__getModConfig__/g) || []).length;
      expect(twiceCount).toBe(onceCount);
    });
  });

  describe("no-match cases", () => {
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
    });

    it("should not transform code without the env var anchor", { timeout: TIMEOUT }, () => {
      const input = `    if (W26(M) && (someOtherCheck(M))) {
      if (A++, A >= Yt_) {
      }
    }`;
      const output = runCodemod(input);

      expect(output).not.toContain("__getModConfig__");
    });
  });

  describe("structural integrity", () => {
    it("should preserve the counter variable increment pattern", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const output = runCodemod(input);

      // Counter variable (M) is both incremented and compared
      expect(output).toMatch(/M\+\+/);
      expect(output).toMatch(/M\s*>=/);
    });

    it("should produce syntactically valid JS when wrapped in a function", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const output = runCodemod(input);

      // Wrap in a function to check syntax validity
      const wrapped = `function test() {\n${output}\n}`;
      try {
        parser.parse(wrapped, { sourceType: "module" });
      } catch (e) {
        throw new Error(`Output is not valid JS: ${e.message}\n${output}`);
      }
    });
  });
});

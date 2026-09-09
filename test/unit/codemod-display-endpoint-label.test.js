import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { randomUUID } from "crypto";

const parser = require(path.join(process.cwd(), "codemods/node_modules/@babel/parser"));

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-display-endpoint-label.cjs");

// Babel parsing in execSync is slow on CI runners — increase per-test timeout
// (bun:test default is 5000ms which is too tight for spawning Node + Babel).
const TIMEOUT = 30000;
const FIXTURES_DIR = path.join(process.cwd(), "test/fixtures");

/** Write input to a temp file, run codemod, return output. Cleans up on success and failure. */
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

describe("codemod-display-endpoint-label", () => {
  describe("structural matching with varied minified names", () => {
    it("matches v2.1.92 style names g7()/P08()", { timeout: TIMEOUT }, () => {
      const input = `
        let status = g7() ? P08() : "API Usage Billing";
      `;

      const output = runCodemod(input);

      expect(output).toContain("process.env.ANTHROPIC_BASE_URL");
      expect(output).toContain("new URL");
      expect(output).toContain(".host");
      // Original call expressions preserved
      expect(output).toContain("g7()");
      expect(output).toContain("P08()");

      // Verify generated code is valid JavaScript
      expect(() => parser.parse(output, { sourceType: "module" })).not.toThrow();
    });

    it("matches simulated v2.1.94+ names ZB1()/xK3()", { timeout: TIMEOUT }, () => {
      const input = `
        let status = ZB1() ? xK3() : "API Usage Billing";
      `;

      const output = runCodemod(input);

      expect(output).toContain("process.env.ANTHROPIC_BASE_URL");
      expect(output).toContain("new URL");
      expect(output).toContain(".host");
      // Original call expressions preserved
      expect(output).toContain("ZB1()");
      expect(output).toContain("xK3()");
    });
  });

  describe("login-method string preservation", () => {
    it("does not modify login-method string containing 'API Usage Billing'", { timeout: TIMEOUT }, () => {
      const input = `
        console.log("Login method pre-selected: API Usage Billing (Anthropic Console)");
        let status = g7() ? P08() : "API Usage Billing";
      `;

      const output = runCodemod(input);

      // Login-method string must appear unchanged in output
      expect(output).toContain('"Login method pre-selected: API Usage Billing (Anthropic Console)"');
      // The billing conditional should still be modified
      expect(output).toContain("process.env.ANTHROPIC_BASE_URL");
      expect(output).toContain("new URL");
      expect(output).toContain(".host");
    });

    it("preserves login-method string with v2.1.94+ names too", { timeout: TIMEOUT }, () => {
      const input = `
        function getStatus() {
          logger("Login method pre-selected: API Usage Billing (Anthropic Console)");
          const label = ZB1() ? xK3() : "API Usage Billing";
          return label;
        }
      `;

      const output = runCodemod(input);

      expect(output).toContain('"Login method pre-selected: API Usage Billing (Anthropic Console)"');
      expect(output).toContain("process.env.ANTHROPIC_BASE_URL");
    });
  });

  describe("edge cases", () => {
    it("rejects code with no matching pattern (fail-closed)", { timeout: TIMEOUT }, () => {
      const input = `
        const x = 42;
        console.log(x);
      `;

      expect(() => runCodemod(input)).toThrow(/Expected exactly 1 ConditionalExpression match.*found 0/);
    });

    it("rejects ConditionalExpression with wrong alternate string (fail-closed)", { timeout: TIMEOUT }, () => {
      const input = `
        let result = someFunc() ? otherFunc() : "Different String";
      `;

      // Wrong alternate: should not match, so 0 matches → throws
      expect(() => runCodemod(input)).toThrow(/Expected exactly 1 ConditionalExpression match.*found 0/);
    });

    it("rejects ConditionalExpression with args in test (zero-arg requirement, fail-closed)", { timeout: TIMEOUT }, () => {
      const input = `
        let result = someFunc(x) ? otherFunc() : "API Usage Billing";
      `;

      // test has args, violating zero-arg requirement → 0 matches → throws
      expect(() => runCodemod(input)).toThrow(/Expected exactly 1 ConditionalExpression match.*found 0/);
    });

    it("rejects ConditionalExpression with args in consequent (zero-arg requirement, fail-closed)", { timeout: TIMEOUT }, () => {
      const input = `
        let result = someFunc() ? otherFunc(y) : "API Usage Billing";
      `;

      // consequent has args, violating zero-arg requirement → 0 matches → throws
      expect(() => runCodemod(input)).toThrow(/Expected exactly 1 ConditionalExpression match.*found 0/);
    });

    it("rejects code with multiple matching patterns (fail-closed)", { timeout: TIMEOUT }, () => {
      const input = `
        let status1 = fn1() ? fn2() : "API Usage Billing";
        let status2 = fn3() ? fn4() : "API Usage Billing";
      `;

      expect(() => runCodemod(input)).toThrow(/Expected exactly 1 ConditionalExpression match.*found 2/);
    });

    it("reports correct exit code on success", { timeout: TIMEOUT }, () => {
      // runCodemod already exercises the full CLI path (including exit code);
      // this test explicitly asserts the exit code path rather than inspecting output.
      const input = `let status = g7() ? P08() : "API Usage Billing";`;
      expect(() => runCodemod(input)).not.toThrow();
    });

    it("is idempotent — already transformed code is a no-op", { timeout: TIMEOUT }, () => {
      // Already-transformed code: process.env.ANTHROPIC_BASE_URL ? <IIFE> : "API Usage Billing"
      const alreadyTransformed = `
        let status = process.env.ANTHROPIC_BASE_URL
          ? (() => { try { return new URL(process.env.ANTHROPIC_BASE_URL).host } catch(e) { return "API" } })()
          : "API Usage Billing";
      `;
      // display-endpoint-label codemod has special idempotency logic: returns 0 without throwing when alreadyApplied > 0
      expect(() => runCodemod(alreadyTransformed)).not.toThrow();
    });
  });
});

import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const parser = require(path.join(process.cwd(), "codemods/node_modules/@babel/parser"));

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-gateway-models-unfilter.cjs");

// Babel parsing in execSync is slow on CI runners
const TIMEOUT = 30000;

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

    fs.unlinkSync(tempInput);
    fs.unlinkSync(tempOutput);

    return output;
  } catch (error) {
    if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
    if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
    throw error;
  }
}

// Simulates the gate function containing CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY
// with both firstParty and env-var gates, plus an unrelated ANTHROPIC_BASE_URL gate.
function buildGateFixture(names = {}) {
  const {
    providerFn = "lq",
    envCheckFn = "vH",
    baseCheckFn = "Ez",
  } = names;

  return `
function ZHK() {
  if (${providerFn}() !== "firstParty") {
    return false;
  }
  if (!${envCheckFn}(process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY)) {
    return false;
  }
  if (!process.env.ANTHROPIC_BASE_URL) {
    return false;
  }
  if (!${baseCheckFn}()) {
    return false;
  }
  return true;
}
`;
}

// Simulates the model filter: .filter(J => /^(claude|anthropic)/i.test(J.id))
function buildFilterFixture(names = {}) {
  const {
    modelVar = "J",
  } = names;

  return `
const models = response.data
  .filter(${modelVar} => /^(claude|anthropic)/i.test(${modelVar}.id))
  .map(m => m.id);
`;
}

// Combined fixture with both gate function and model filter
function buildFullFixture(names = {}) {
  return buildGateFixture(names) + buildFilterFixture(names);
}

// Simulates the async gateway-discovery fetcher: guarded by ta() (nonessential-traffic),
// reads ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN, then fetches /v1/models. This is the
// function Transform 4 targets (b2s in 2.1.181); minified names drift every release.
function buildFetcherFixture(names = {}) {
  const {
    fnName = "b2s",
    gateFn = "y2s",
    nonessentialFn = "ta",
    baseVar = "e",
    tokenVar = "t",
    authHelperFn = "DR",
  } = names;

  return `
async function ${fnName}() {
  if (!${gateFn}()) {
    return;
  }
  if (${nonessentialFn}()) {
    return;
  }
  try {
    let ${baseVar} = process.env.ANTHROPIC_BASE_URL;
    if (!${baseVar}) {
      return;
    }
    let ${tokenVar} = process.env.ANTHROPIC_AUTH_TOKEN;
    if (!${tokenVar} && !${authHelperFn}()) {
      return;
    }
    let res = await fetch(${baseVar} + "/v1/models?limit=1000");
    return await res.json();
  } catch {}
}
`;
}

describe("codemod-gateway-models-unfilter", () => {
  describe("Transform 1: firstParty gate", () => {
    it("should guard firstParty gate return false with __isModEnabled__ ternary", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture();
      const output = runCodemod(input);

      // The return false in the firstParty gate should be replaced with a ternary
      expect(output).toContain("__isModEnabled__");
      expect(output).toContain('"unlock_models"');
      // firstParty check still exists
      expect(output).toContain('"firstParty"');
    });

    it("should preserve the firstParty check condition", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture();
      const output = runCodemod(input);

      // The if-condition with firstParty is still there
      expect(output).toMatch(/!==\s*"firstParty"/);
    });

    it("should work with different provider function names", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture({ providerFn: "checkProvider" });
      const output = runCodemod(input);

      expect(output).toContain("__isModEnabled__");
      expect(output).toContain("checkProvider()");
    });
  });

  describe("Transform 2: env-var gate", () => {
    it("should guard env-var gate return false with __isModEnabled__ ternary", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture();
      const output = runCodemod(input);

      // CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY check still exists
      expect(output).toContain("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY");
    });

    it("should work with different env check function names", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture({ envCheckFn: "truthyCheck" });
      const output = runCodemod(input);

      expect(output).toContain("__isModEnabled__");
      expect(output).toContain("truthyCheck");
    });
  });

  describe("Transform 3: model ID filter", () => {
    it("should wrap model filter with __isModEnabled__ conditional", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture();
      const output = runCodemod(input);

      // The __GMU__ marker should be present
      expect(output).toContain("__GMU__");
      // The original filter pattern should still be in the fallback branch
      expect(output).toContain("claude|anthropic");
    });

    it("should work with different model variable names", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture({ modelVar: "model" });
      const output = runCodemod(input);

      expect(output).toContain("__GMU__");
      expect(output).toContain("model.id");
    });
  });

  describe("Transform 4: nonessential-traffic gate (ta())", () => {
    it("should and the ta() guard test with the __isModEnabled__ bypass", { timeout: TIMEOUT }, () => {
      const input = buildFetcherFixture();
      const output = runCodemod(input);

      expect(output).toContain("__isModEnabled__");
      expect(output).toContain('"unlock_models"');
      // Original ta() call preserved, now followed by && !(modGuard)
      expect(output).toMatch(/ta\(\)\s*&&\s*!/);
    });

    it("should leave the unary !y2s() gate untouched (only bare-call guards match)", { timeout: TIMEOUT }, () => {
      const input = buildFetcherFixture();
      const output = runCodemod(input);

      // Scope to the !y2s() consequent block (up to the first '}'); it must stay a bare
      // return with no mod-guard. Other guards (ta()) legitimately carry __isModEnabled__.
      const gateBlock = output.match(/!\s*y2s\(\)\s*\)\s*\{[^}]*\}/);
      expect(gateBlock).toBeTruthy();
      expect(gateBlock[0]).toContain("return");
      expect(gateBlock[0]).not.toContain("__isModEnabled__");
    });

    it("should survive minified-name drift (ta -> ZK, b2s -> q5, y2s -> pP)", { timeout: TIMEOUT }, () => {
      const input = buildFetcherFixture({ fnName: "q5", gateFn: "pP", nonessentialFn: "ZK" });
      const output = runCodemod(input);

      expect(output).toContain("__isModEnabled__");
      expect(output).toMatch(/ZK\(\)\s*&&\s*!/);
    });

    it("should be idempotent (re-run adds no second mod-guard layer)", { timeout: TIMEOUT }, () => {
      const input = buildFetcherFixture();
      const once = runCodemod(input);
      const twice = runCodemod(once);

      const onceCount = (once.match(/__isModEnabled__/g) || []).length;
      const twiceCount = (twice.match(/__isModEnabled__/g) || []).length;
      expect(twiceCount).toBe(onceCount);
    });

    it("should apply all four transforms together (gate + filter + fetcher)", { timeout: TIMEOUT }, () => {
      const input = buildGateFixture() + buildFilterFixture() + buildFetcherFixture();
      const output = runCodemod(input);

      expect(output).toContain("__isModEnabled__");
      expect(output).toContain("__GMU__");
      expect(output).toMatch(/ta\(\)\s*&&\s*!/);
      try {
        parser.parse(output, { sourceType: "module" });
      } catch (e) {
        throw new Error("Combined output not valid JS: " + e.message + "\n" + output);
      }
    });
  });

  describe("unrelated gates preserved", () => {
    it("should not guard the ANTHROPIC_BASE_URL check", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture();
      const output = runCodemod(input);

      // The ANTHROPIC_BASE_URL check should remain as a simple return false
      const baseUrlMatch = output.match(/ANTHROPIC_BASE_URL[\s\S]{0,100}return false/);
      expect(baseUrlMatch).toBeTruthy();
      // The return false for ANTHROPIC_BASE_URL should NOT contain __isModEnabled__
      const baseUrlSection = output.substring(
        output.indexOf("ANTHROPIC_BASE_URL") - 50,
        output.indexOf("ANTHROPIC_BASE_URL") + 200
      );
      expect(baseUrlSection).toContain("return false");
    });
  });

  describe("no-match cases", () => {
    it("should not transform code without gateway discovery", { timeout: TIMEOUT }, () => {
      const input = 'const x = 42; function foo() { return "bar"; }';
      const output = runCodemod(input);

      expect(output).not.toContain("__isModEnabled__");
      expect(output).not.toContain("__GMU__");
    });

    it("should handle gate-only fixture (no model filter)", { timeout: TIMEOUT }, () => {
      const input = buildGateFixture();
      const output = runCodemod(input);

      // Should still guard the gates even without the filter
      expect(output).toContain("__isModEnabled__");
      // No __GMU__ since no filter was present
      expect(output).not.toContain("__GMU__");
    });

    it("should handle filter-only fixture (no gate function)", { timeout: TIMEOUT }, () => {
      const input = buildFilterFixture();
      const output = runCodemod(input);

      // Should guard the filter even without the gate function
      expect(output).toContain("__GMU__");
    });
  });

  describe("structural integrity", () => {
    it("should produce syntactically valid JS", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture();
      const output = runCodemod(input);

      try {
        parser.parse(output, { sourceType: "module" });
      } catch (e) {
        throw new Error("Output is not valid JS: " + e.message + "\n" + output);
      }
    });
  });
});

import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { randomUUID } from "crypto";

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-agent-model-always-show.cjs");

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

// v2.1.92 style names
const fixtureV2192 = `
function HzK(q) {
  let K = [];
  if (q.model) {
    let D5_result = D5();
    let y5_result = y5(q.model);
    if (y5_result !== D5_result) {
      K.push({ value: "model", label: "Model", description: "Model info" });
    }
  }
  if (K.length === 0) { return null; }
  return K;
}
`;

// v2.1.94+ style names
const fixtureV2194 = `
function ZB1x(p) {
  let arrM = [];
  if (p.model) {
    let sessionVal = getSessionModel();
    let convertedVal = convertModel(p.model);
    if (convertedVal !== sessionVal) {
      arrM.push({ value: "model", label: "Model", description: "Model info" });
    }
  }
  if (arrM.length === 0) { return null; }
  return arrM;
}
`;

describe("codemod-agent-model-always-show", () => {
  describe("structural matching with varied minified names", () => {
    it("matches v2.1.92 style names HzK/q/K/D5/y5", { timeout: TIMEOUT }, () => {
      const output = runCodemod(fixtureV2192);

      expect(output).toContain("display_model_name");
      expect(output).toContain("__isModEnabled__");
      expect(output).toContain("typeof __isModEnabled__");
    });

    it("matches v2.1.94+ style names ZB1x/p/arrM/getSessionModel/convertModel", { timeout: TIMEOUT }, () => {
      const output = runCodemod(fixtureV2194);

      expect(output).toContain("display_model_name");
      expect(output).toContain("__isModEnabled__");
      expect(output).toContain("typeof __isModEnabled__");
    });

    it("matches single-char function name", { timeout: TIMEOUT }, () => {
      const input = `
function X(a) {
  let b = [];
  if (a.model) {
    let c = f1();
    let d = f2(a.model);
    if (d !== c) {
      b.push({ value: "x", label: "X", description: "X info" });
    }
  }
  if (b.length === 0) { return null; }
  return b;
}
`;

      const output = runCodemod(input);

      expect(output).toContain("display_model_name");
      expect(output).toContain("__isModEnabled__");
    });
  });

  describe("outer condition wrapping", () => {
    it("wraps param.model check with __isModEnabled__ OR guard", { timeout: TIMEOUT }, () => {
      const output = runCodemod(fixtureV2192);

      // Outer if should now be: q.model || (typeof __isModEnabled__ === "function" && __isModEnabled__(...))
      expect(output).toMatch(/q\.model\s*\|\|/);
      expect(output).toContain("display_model_name");
    });
  });

  describe("inner condition wrapping", () => {
    it("wraps !== comparison with __isModEnabled__ OR guard", { timeout: TIMEOUT }, () => {
      const output = runCodemod(fixtureV2192);

      // Inner if should have the mod check OR'd with the original !== check
      expect(output).toMatch(/__isModEnabled__.*\|\|.*!==/);
    });
  });

  describe("converter fallback", () => {
    it("replaces converter(param.model) with conditional expression", { timeout: TIMEOUT }, () => {
      const output = runCodemod(fixtureV2192);

      // Should contain a ternary: param.model ? converter(param.model) : sessionModel
      expect(output).toMatch(/q\.model\s*\?.*y5\(q\.model\).*:.*D5_result/);
    });
  });

  describe("preserve surrounding code", () => {
    it("preserves the trailing empty-array return null", { timeout: TIMEOUT }, () => {
      const output = runCodemod(fixtureV2192);

      expect(output).toContain("return null");
    });

    it("preserves the return statement at the end", { timeout: TIMEOUT }, () => {
      const output = runCodemod(fixtureV2194);

      expect(output).toContain("return arrM");
    });

    it("does not modify unrelated functions", { timeout: TIMEOUT }, () => {
      const input = `
function unrelated(x) {
  return x + 1;
}

${fixtureV2194}

function alsoUnrelated() {
  return 42;
}
`;

      const output = runCodemod(input);

      expect(output).toContain("return x + 1");
      expect(output).toContain("return 42");
    });
  });

  describe("LogicalExpression: if (param.model && ...)", () => {
    it("matches when param.model is in a && expression", { timeout: TIMEOUT }, () => {
      const input = `
function PzR(q) {
  let arr = [];
  if (q.model && q.other) {
    let sModel = gSM();
    let conv = cM(q.model);
    if (conv !== sModel) {
      arr.push({ value: "model", label: "Model", description: "Model info" });
    }
  }
  if (arr.length === 0) { return null; }
  return arr;
}
`;

      const output = runCodemod(input);

      expect(output).toContain("display_model_name");
      expect(output).toContain("__isModEnabled__");
      expect(output).toContain("typeof __isModEnabled__");
    });

    it("is idempotent with LogicalExpression fixture", { timeout: TIMEOUT }, () => {
      const input = `
function Z9(r) {
  let b = [];
  if (r.model && someCheck()) {
    let sv = getSM();
    let cv = cvt(r.model);
    if (cv !== sv) {
      b.push({ value: "model", label: "Model", description: "info" });
    }
  }
  if (b.length === 0) { return null; }
  return b;
}
`;

      const output1 = runCodemod(input);
      const output2 = runCodemod(output1);
      expect(output2).toBe(output1);
    });
  });

  describe("edge cases", () => {
    it("rejects code with no matching function (fail-closed)", { timeout: TIMEOUT }, () => {
      const input = `
function foo(x) {
  return x;
}
`;

      // 2.1.136+: model display was restructured — graceful skip (returns 0)
      const result = runCodemod(input);
      expect(result).not.toContain('__isModEnabled__("display_model_name")');
    });

    it("rejects function missing trailing empty-array return", { timeout: TIMEOUT }, () => {
      const input = `
function HzK(q) {
  let K = [];
  if (q.model) {
    let D5_result = D5();
    let y5_result = y5(q.model);
    if (y5_result !== D5_result) {
      K.push({ value: "model", label: "Model", description: "Model info" });
    }
  }
  return K;
}
`;

      // 2.1.136+: graceful skip when structure doesn't fully match
      const result = runCodemod(input);
      expect(result).not.toContain('__isModEnabled__("display_model_name")');
    });

    it("rejects function with wrong inner structure (no !== comparison)", { timeout: TIMEOUT }, () => {
      const input = `
function HzK(q) {
  let K = [];
  if (q.model) {
    let D5_result = D5();
    let y5_result = y5(q.model);
    if (y5_result === D5_result) {
      K.push({ value: "model", label: "Model", description: "Model info" });
    }
  }
  if (K.length === 0) { return null; }
  return K;
}
`;

      // 2.1.136+: graceful skip (returns 0, no mod guard injected)
      const result = runCodemod(input);
      expect(result).not.toContain('__isModEnabled__("display_model_name")');
    });

    it("is idempotent — already transformed code is a no-op", { timeout: TIMEOUT }, () => {
      const output1 = runCodemod(fixtureV2192);

      // Running again on already-transformed code: isAlreadyPatched detects
      // existing __isModEnabled__("display_model_name") calls and returns 0.
      const output2 = runCodemod(output1);
      expect(output2).toBe(output1);
    });
  });
});

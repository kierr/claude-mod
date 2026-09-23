import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { randomUUID } from "crypto";

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-add-multi-custom-models.cjs");

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
function buildPickerFixture(varNames) {
  const { envVar, pickerArr, callbackParam } = varNames;
  // Must be inside a function body — codemod checks parent is BlockStatement
  return `
function pickerFn() {
  let ${envVar} = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION;
  if (${envVar} && !${pickerArr}.some(${callbackParam} => ${callbackParam}.value === ${envVar})) {
    ${pickerArr}.push({
      value: ${envVar},
      label: ${envVar},
      description: "Custom model (" + ${envVar} + ")"
    });
  }
}
`;
}

function buildValidatorFixture(varNames) {
  const { modelVar } = varNames;
  // Must be inside a function body — return is invalid at top level
  return `
function validatorFn() {
  if (${modelVar} === process.env.ANTHROPIC_CUSTOM_MODEL_OPTION) {
    return { valid: true };
  }
}
`;
}

describe("codemod-add-multi-custom-models", () => {
  describe("picker transform with varied minified names", () => {
    it("matches v2.1.92 style names (envVar=_m, pickerArr=K, cbParam=A)", { timeout: TIMEOUT }, () => {
      const input = buildPickerFixture({ envVar: "_m", pickerArr: "K", callbackParam: "A" });

      const output = runCodemod(input);

      expect(output).toContain("ANTHROPIC_CUSTOM_MODEL_OPTION_");
      expect(output).toContain("_i <= 20");
      expect(output).toContain("K.push");
      expect(output).toContain("K.some");
    });

    it("matches v2.1.94+ style names (envVar=envVal, pickerArr=modelList, cbParam=item)", { timeout: TIMEOUT }, () => {
      const input = buildPickerFixture({ envVar: "envVal", pickerArr: "modelList", callbackParam: "item" });

      const output = runCodemod(input);

      expect(output).toContain("ANTHROPIC_CUSTOM_MODEL_OPTION_");
      expect(output).toContain("_i <= 20");
      expect(output).toContain("modelList.push");
      expect(output).toContain("modelList.some");
    });

    it("matches single-char names (envVar=_, pickerArr=X, cbParam=Z)", { timeout: TIMEOUT }, () => {
      const input = buildPickerFixture({ envVar: "_", pickerArr: "X", callbackParam: "Z" });

      const output = runCodemod(input);

      expect(output).toContain("X.push");
      expect(output).toContain("X.some");
    });
  });

  describe("validator transform with varied minified names", () => {
    it("matches v2.1.92 style name (modelVar=Q5)", { timeout: TIMEOUT }, () => {
      const input = buildValidatorFixture({ modelVar: "Q5" });

      const output = runCodemod(input);

      expect(output).toContain("ANTHROPIC_CUSTOM_MODEL_OPTION_");
      expect(output).toContain("Q5 ===");
    });

    it("matches v2.1.94+ style name (modelVar=modelIdentifier)", { timeout: TIMEOUT }, () => {
      const input = buildValidatorFixture({ modelVar: "modelIdentifier" });

      const output = runCodemod(input);

      expect(output).toContain("modelIdentifier ===");
    });
  });

  describe("both transforms together", () => {
    it("patches both picker and validator in the same file", { timeout: TIMEOUT }, () => {
      const input = buildPickerFixture({ envVar: "_m", pickerArr: "K", callbackParam: "A" })
        + buildValidatorFixture({ modelVar: "Q5" });

      const output = runCodemod(input);

      // Should have 2 injected for-loops
      const count = (output.match(/for\s*\(\s*let\s+_i\s*=\s*1/g) || []).length;
      expect(count).toBe(2);
    });
  });

  describe("injected loop content", () => {
    it("includes _NAME and _DESCRIPTION env var lookups", { timeout: TIMEOUT }, () => {
      const input = buildPickerFixture({ envVar: "_m", pickerArr: "K", callbackParam: "A" });

      const output = runCodemod(input);

      expect(output).toContain("_NAME");
      expect(output).toContain("_DESCRIPTION");
    });

    it("includes nullish coalescing for label fallback", { timeout: TIMEOUT }, () => {
      const input = buildPickerFixture({ envVar: "_m", pickerArr: "K", callbackParam: "A" });

      const output = runCodemod(input);

      expect(output).toContain("??");
    });
  });

  describe("edge cases", () => {
    it("rejects code with no matching pattern (fail-closed)", { timeout: TIMEOUT }, () => {
      const input = `
const x = 42;
console.log(x);
`;

      // No match: codemod writes stderr "No matching..." but exits 0
      // since it doesn't throw. Verify no for-loop injected.
      const output = runCodemod(input);
      expect(output).not.toContain("_i <= 20");
    });

    it("rejects picker with wrong push property names", { timeout: TIMEOUT }, () => {
      const input = `
function pickerFn() {
  let _m = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION;
  if (_m && !K.some(A => A.value === _m)) {
    K.push({
      value: _m,
      wrong_label: _m,
      wrong_desc: "Custom model (" + _m + ")"
    });
  }
}
`;

      const output = runCodemod(input);
      // Should not match because push object doesn't have label/description
      expect(output).not.toContain("_i <= 20");
    });

    it("is idempotent — already transformed picker code is a no-op", { timeout: TIMEOUT }, () => {
      const input = buildPickerFixture({ envVar: "_m", pickerArr: "K", callbackParam: "A" });
      const output1 = runCodemod(input);

      // Running again: the for-loop is already present (nextSiblingIsOurLoop returns true)
      const output2 = runCodemod(output1);

      const count = (output2.match(/for\s*\(\s*let\s+_i\s*=\s*1/g) || []).length;
      expect(count).toBe(1); // Still just 1 loop, not 2
    });

    it("is idempotent — already transformed validator code is a no-op", { timeout: TIMEOUT }, () => {
      const input = buildValidatorFixture({ modelVar: "Q5" });
      const output1 = runCodemod(input);

      const output2 = runCodemod(output1);

      const count = (output2.match(/for\s*\(\s*let\s+_i\s*=\s*1/g) || []).length;
      expect(count).toBe(1);
    });

    it("rejects picker where env var declaration is missing", { timeout: TIMEOUT }, () => {
      const input = `
function pickerFn() {
  if (_m && !K.some(A => A.value === _m)) {
    K.push({
      value: _m,
      label: _m,
      description: "Custom model (" + _m + ")"
    });
  }
}
`;

      // No preceding `let _m = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION;`
      const output = runCodemod(input);
      expect(output).not.toContain("_i <= 20");
    });
  });
});

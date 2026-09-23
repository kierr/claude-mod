import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { randomUUID } from "crypto";

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-model-full-list.cjs");

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

// Shared fixture with all 3 target patterns using v2.1.92-style names
function buildFullFixture(names) {
  const { wrapperFn, schemaFactory, memoizeReader, readerFactory, cachePathFn, pickerFn, pickerArr } = names;
  return `
// Transform 1 target: caching gate near model-capabilities.json
function ${cachePathFn}() {
  return path.join(os.homedir(), ".claude", "model-capabilities.json");
}

function cachingGateFn() {
  return false;
}

// Transform 2 target: schema factory inside lazy-init wrapper
var ${wrapperFn} = (function() {
  var ${memoizeReader};
  ${wrapperFn} = function(initFn) {
    initFn();
  };
  ${wrapperFn}(() => {
    var schema = ${schemaFactory}(() => h.object({
      id: h.string(),
      max_tokens: h.number().optional(),
      display_name: h.string().optional()
    }).strip());
    schema.safeParse({});
    ${memoizeReader} = ${readerFactory}(
      (cachePath, cacheKey) => null,
      (r, keyFn) => r
    );
  });
  return ${wrapperFn};
})();

// Transform 3 target: model picker function
function ${pickerFn}() {
  var ${pickerArr} = getDefaultModels();
  var _envVar = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION;
  if (_envVar && !${pickerArr}.some(function(_A) { return _A.value === _envVar; })) {
    ${pickerArr}.push({ value: _envVar, label: _envVar, description: "Custom model" });
  }
  if (typeof additionalModelOptionsCache !== "undefined") {
    ${pickerArr}.push({ value: "cached", label: "Cached", description: "Cached model" });
  }
  return ${pickerArr};
}
`;
}

describe("codemod-model-full-list", () => {
  describe("transform 1: caching gate", () => {
    it("flips return false → returns mod guard near model-capabilities.json", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture({
        wrapperFn: "L", schemaFactory: "ZI", memoizeReader: "reader",
        readerFactory: "MkReader", cachePathFn: "getCachePath", pickerFn: "getModelOptions",
        pickerArr: "modelOptions"
      });

      const output = runCodemod(input);

      // cachingGateFn should now return the mod guard expression
      expect(output).toContain('__isModEnabled__("unlock_models")');
      // Should NOT contain bare `return true` — replaced with mod guard
      expect(output).not.toMatch(/cachingGateFn\(\)\s*\{\s*\n?\s*return true/);
    });

    it("flips return false with varied function names", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture({
        wrapperFn: "initWrapper", schemaFactory: "makeSchema", memoizeReader: "cacheReader",
        readerFactory: "memoizeFn", cachePathFn: "resolveCachePath", pickerFn: "buildPickerList",
        pickerArr: "pickerItems"
      });

      const output = runCodemod(input);

      expect(output).toContain('__isModEnabled__("unlock_models")');
    });
  });

  describe("transform 2: schema extension", () => {
    it("adds display_name after id in schema", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture({
        wrapperFn: "L", schemaFactory: "ZI", memoizeReader: "reader",
        readerFactory: "MkReader", cachePathFn: "getCachePath", pickerFn: "getModelOptions",
        pickerArr: "modelOptions"
      });

      const output = runCodemod(input);

      // display_name is already in our fixture — codemod detects and skips.
      // This test verifies the fixture parses without error.
      expect(output).toContain("display_name");
    });

    it("adds display_name when not already present", { timeout: TIMEOUT }, () => {
      const input = `
var L = (function() {
  var reader;
  L = function(initFn) { initFn(); };
  L(() => {
    var schema = ZI(() => h.object({
      id: h.string(),
      max_tokens: h.number().optional()
    }).strip());
    schema.safeParse({});
    reader = MkReader(
      (cachePath, cacheKey) => null,
      (r, keyFn) => r
    );
  });
  return L;
})();

function getCachePath() {
  return path.join(os.homedir(), ".claude", "model-capabilities.json");
}

function cachingGateFn() { return false; }

function getModelOptions() {
  var modelOptions = getDefaultModels();
  var _envVar = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION;
  if (_envVar && !modelOptions.some(function(_A) { return _A.value === _envVar; })) {
    modelOptions.push({ value: _envVar, label: _envVar, description: "Custom model" });
  }
  if (typeof additionalModelOptionsCache !== "undefined") {}
  return modelOptions;
}
`;

      const output = runCodemod(input);

      expect(output).toContain("display_name");
      expect(output).toContain("h.string()");
    });

    // Regression: schema-library identifier must be captured dynamically.
    // Webcrack renames it every release (h → z → Ix9 → …). Hardcoding "h"
    // produces output that parses and passes status_tests but throws at
    // runtime when the renamed identifier is referenced.
    it("uses captured schema-lib name (not hardcoded 'h') when lib is renamed", { timeout: TIMEOUT }, () => {
      const input = `
var L = (function() {
  var reader;
  L = function(initFn) { initFn(); };
  L(() => {
    var schema = ZI(() => z.object({
      id: z.string(),
      max_tokens: z.number().optional()
    }).strip());
    schema.safeParse({});
    reader = MkReader(
      (cachePath, cacheKey) => null,
      (r, keyFn) => r
    );
  });
  return L;
})();

function getCachePath() {
  return path.join(os.homedir(), ".claude", "model-capabilities.json");
}

function cachingGateFn() { return false; }

function getModelOptions() {
  var modelOptions = getDefaultModels();
  return modelOptions;
}
`;

      const output = runCodemod(input);

      // display_name MUST use the captured schema lib (z), not a hardcoded h.
      expect(output).toContain("display_name: z.string().optional()");
      expect(output).not.toMatch(/display_name:\s*h\.string/);
    });
  });

  describe("transform 3: API models in picker", () => {
    it("injects try/catch block with cache reader", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture({
        wrapperFn: "L", schemaFactory: "ZI", memoizeReader: "reader",
        readerFactory: "MkReader", cachePathFn: "getCachePath", pickerFn: "getModelOptions",
        pickerArr: "modelOptions"
      });

      const output = runCodemod(input);

      expect(output).toContain("try");
      expect(output).toContain("_apiModels");
    });

    it("uses dynamically discovered memoized reader and cache path names", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture({
        wrapperFn: "initW", schemaFactory: "mkSchema", memoizeReader: "myReader",
        readerFactory: "memoizeFn", cachePathFn: "resolvePath", pickerFn: "buildList",
        pickerArr: "items"
      });

      const output = runCodemod(input);

      expect(output).toContain("myReader");
      expect(output).toContain("resolvePath");
    });
  });

  describe("edge cases", () => {
    it("rejects code with no matching patterns (fail-closed)", { timeout: TIMEOUT }, () => {
      const input = `
const x = 42;
console.log(x);
`;

      expect(() => runCodemod(input)).toThrow();
    });

    it("is idempotent — already transformed code exits gracefully", { timeout: TIMEOUT }, () => {
      const input = buildFullFixture({
        wrapperFn: "L", schemaFactory: "ZI", memoizeReader: "reader",
        readerFactory: "MkReader", cachePathFn: "getCachePath", pickerFn: "getModelOptions",
        pickerArr: "modelOptions"
      });

      const output1 = runCodemod(input);

      // Second run: all transforms get 0 matches, codemod exits 1
      expect(() => runCodemod(output1)).toThrow(/No matching patterns found/);

      // Verify first run produced mod guard output
      expect(output1).toContain('__isModEnabled__("unlock_models")');
    });
  });
});

import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { randomUUID } from "crypto";

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-inject-mods-runtime.cjs");

// Babel parsing in execSync is slow on CI runners — increase per-test timeout
// (bun:test default is 5000ms which is too tight for spawning Node + Babel).
const TIMEOUT = 30000;
const FIXTURES_DIR = path.join(process.cwd(), "test/fixtures");

// Wrap fixture code in the native-binary-era CJS wrapper so the codemod
// resolves bare require() as a wrapper parameter and injects at the top of
// the wrapper body.
function withCjsWrapper(code) {
  return `(function(exports, require, module, __filename, __dirname) {
${code}
})`;
}

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

describe("codemod-inject-mods-runtime", () => {
  describe("injection into CJS wrapper", () => {
    it("injects helpers at the top of the CJS wrapper body", { timeout: TIMEOUT }, () => {
      const input = withCjsWrapper(`
function main() {
  console.log("hello");
}
`);

      const output = runCodemod(input);

      expect(output).toContain("__modsLoad__");
      expect(output).toContain("__isModEnabled__");
      expect(output).toContain("__getModConfig__");
      expect(output).toContain("__mods_cache__");
      expect(output).toContain("mods.json");
      expect(output).toContain("CLAUDE_CONFIG_DIR");
      // The injected code calls bare require() (the wrapper parameter), not a
      // discovered/minified require function name.
      expect(output).toContain('require("fs")');
    });
  });

  describe("helper function content", () => {
    it("includes TTL cache with 2s expiry", { timeout: TIMEOUT }, () => {
      const input = withCjsWrapper("");

      const output = runCodemod(input);

      expect(output).toContain("2000");
      expect(output).toContain("__mods_cache_time__");
    });

    it("includes typeof guard in __isModEnabled__", { timeout: TIMEOUT }, () => {
      const input = withCjsWrapper("");

      const output = runCodemod(input);

      // __isModEnabled__ should check [id] === true
      expect(output).toMatch(/__isModEnabled__\(id\)/);
    });

    it("includes __getModConfig__ with fallback logic", { timeout: TIMEOUT }, () => {
      const input = withCjsWrapper("");

      const output = runCodemod(input);

      expect(output).toContain("fallback");
    });
  });

  describe("idempotency", () => {
    it("skips injection when __modsLoad__ already exists", { timeout: TIMEOUT }, () => {
      const input = withCjsWrapper(`
function __modsLoad__() {
  return {};
}

function __isModEnabled__(id) {
  return true;
}

function __getModConfig__(id, key, fallback) {
  return fallback;
}

function main() {
  console.log("already patched");
}
`);

      const output = runCodemod(input);

      // Should not duplicate helpers — __modsLoad__ should appear exactly once
      const count = (output.match(/function __modsLoad__\(\)/g) || []).length;
      expect(count).toBe(1);
    });
  });

  describe("__getModConfig__ behavior", () => {
    it("returns undefined when mod is not enabled", { timeout: TIMEOUT }, () => {
      const input = withCjsWrapper("");

      const output = runCodemod(input);

      // When mod is absent from config, __getModConfig__ must return undefined,
      // not fallback — this ensures dependent codemods don't activate by default.
      const fnMatch = output.match(/function __getModConfig__\(id, key, fallback\) \{[\s\S]*?\n\}/);
      expect(fnMatch).not.toBeNull();
      const fnBody = fnMatch[0];
      expect(fnBody).toMatch(/config\[id\]\s*!==\s*true\s*\)\s*return\s+undefined/);
    });
  });

  describe("edge cases", () => {
    it("inserts helpers immediately after the wrapper opening, before nested code", { timeout: TIMEOUT }, () => {
      const input = withCjsWrapper(`
const NESTED_MARKER = "after-helpers";
function lazy() {
  const x = require("lazy-module");
  return x;
}
`);

      const output = runCodemod(input);

      expect(output).toContain("__modsLoad__");
      // Injection point is insertIndex 0 — the top of the wrapper body — so the
      // helpers must precede any of the original nested code.
      const wrapperIdx = output.indexOf("(function(exports, require, module, __filename, __dirname) {");
      const modsIdx = output.indexOf("__modsLoad__");
      const nestedIdx = output.indexOf("NESTED_MARKER");
      expect(modsIdx).toBeGreaterThan(wrapperIdx);
      expect(modsIdx).toBeLessThan(nestedIdx);
    });

    it("skips injection when no CJS wrapper is found", { timeout: TIMEOUT }, () => {
      const input = `
function foo() {
  return 42;
}
`;

      const output = runCodemod(input);

      expect(output).not.toContain("__modsLoad__");
    });
  });
});

import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { randomUUID } from "crypto";

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-unlock-effort-instructions.cjs");
const { transform } = require(CODEMOD_PATH);

// Babel parsing in execSync is slow on CI runners — increase per-test timeout
// (bun:test default is 5000ms which is too tight for spawning Node + Babel).
const TIMEOUT = 30000;

describe("codemod-unlock-effort-instructions", () => {
  function runCodemod(inputCode, outputPath) {
    const tempInput = path.join(process.cwd(), "test/fixtures", `temp-effort-input-${randomUUID()}.js`);
    const tempOutput = outputPath || path.join(process.cwd(), "test/fixtures", `temp-effort-output-${randomUUID()}.js`);

    fs.mkdirSync(path.join(process.cwd(), "test/fixtures"), { recursive: true });
    fs.writeFileSync(tempInput, inputCode);

    try {
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

  // Minimal fixture with v2.1.92-style minified names
  function v2192Fixture() {
    return `
      function jx1() {
        return xy3(K.effortLevel);
      }

      function tL(model) {
        if (process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT === "1") return true;
        return false;
      }

      function f2Y(q) {
        if (!jo() || !q || !uz4(q)) {
          return [];
        }
        d("tengu_ultrathink", {});
        return [{
          type: "ultrathink_effort",
          level: "high"
        }];
      }

      function setupEvents(q) {
        var K = getContext();
        oY("ultrathink_effort", () => Promise.resolve(f2Y(q)));
        oY("other_event", () => K.options.mainLoopModel);
      }
    `;
  }

  // Same logic with different minified names (v2.1.94 style)
  function v2194Fixture() {
    return `
      function aB7() {
        return qR2(ctx.effortLevel);
      }

      function zK(model) {
        if (process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT === "1") return true;
        return false;
      }

      function xM3(q) {
        if (!pN() || !q || !vR9(q)) {
          return [];
        }
        h("tengu_ultrathink", {});
        return [{
          type: "ultrathink_effort",
          level: "high"
        }];
      }

      function setupEvents(q) {
        var Ctx = getContext();
        register("ultrathink_effort", () => Promise.resolve(xM3(q)));
        register("other", () => Ctx.options.mainLoopModel);
      }
    `;
  }

  // The getter requires a state argument. The wrapper supplies the required
  // cli and settings fields; injecting a bare call would fail at runtime.
  function v21178Fixture() {
    return `
      function c8() { return { effortLevel: "max", ultracode: false }; }
      function KC(v) { return v === undefined ? undefined : v; }
      function IMH(v) { return v; }

      function Zd9(H) {
        var _ = KC(H.cli.effort);
        if (_ !== undefined) { return _; }
        if (H.settings.ultracode === true) { return "xhigh"; }
        return IMH(H.settings.effortLevel);
      }

      function c08(H) {
        return Zd9({ cli: { effort: H }, env: process.env, settings: c8() });
      }

      function WP(model) {
        if (process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT === "1") return true;
        return false;
      }

      function WbO(q) {
        if (!jo() || !q || !xd9(q)) { return []; }
        c("tengu_ultrathink", {});
        return [{ type: "ultrathink_effort", level: "high" }];
      }

      function setupEvents(q) {
        var K = getContext();
        oY("ultrathink_effort", () => Promise.resolve(WbO(q)));
        oY("other_event", () => K.options.mainLoopModel);
      }
    `;
  }

  describe("function body transformation", () => {
    it("adds model + effort parameters to ultrathink detector", { timeout: TIMEOUT }, () => {
      const output = runCodemod(v2192Fixture());
      expect(output).toContain("function f2Y(q, model, effort)");
    });

    it("prefers the passed effort over the settings getter", { timeout: TIMEOUT }, () => {
      const output = runCodemod(v2192Fixture());
      // _patchEffort = effort !== undefined ? effort : jx1()
      expect(output).toMatch(/effort\s*!==\s*undefined\s*\?\s*effort\s*:/);
    });

    it("adds _patchResults accumulator", { timeout: TIMEOUT }, () => {
      const output = runCodemod(v2192Fixture());
      expect(output).toContain("_patchResults");
      expect(output).toContain("return _patchResults");
    });

    it("preserves original ultrathink detection logic", { timeout: TIMEOUT }, () => {
      const output = runCodemod(v2192Fixture());
      expect(output).toContain("tengu_ultrathink");
      expect(output).toContain("ultrathink_effort");
    });

    it("wraps effort fallback in __isModEnabled__ guard", { timeout: TIMEOUT }, () => {
      const output = runCodemod(v2192Fixture());
      expect(output).toContain('typeof __isModEnabled__ === "function"');
      expect(output).toContain('__isModEnabled__("unlock_effort_instructions")');
    });

    it("calls effort getter function", { timeout: TIMEOUT }, () => {
      const output = runCodemod(v2192Fixture());
      expect(output).toContain("jx1()");
    });

    it("calls effort support check with model", { timeout: TIMEOUT }, () => {
      const output = runCodemod(v2192Fixture());
      expect(output).toContain("tL(model)");
    });

    it("pushes spread elements, not nested array", { timeout: TIMEOUT }, () => {
      const output = runCodemod(v2192Fixture());
      // Spread: _patchResults.push(...[...])
      expect(output).toMatch(/_patchResults\.push\(\.\.\.\[/);
      // Must NOT push the array directly: _patchResults.push([...])
      expect(output).not.toMatch(/_patchResults\.push\(\[\{/);
    });
  });

  describe("call site transformation", () => {
    it("adds mainLoopModel + effortValue arguments to detector call", { timeout: TIMEOUT }, () => {
      const output = runCodemod(v2192Fixture());
      expect(output).toMatch(/f2Y\(q,\s*K\.options\.mainLoopModel,\s*K\.getAppState\?\.?\(\)\?\.effortValue\)/);
    });

    it("picks mainLoopModel from same scope as call site, not earlier global match", { timeout: TIMEOUT }, () => {
      const input = `
        function jx1() { return xy3(K.effortLevel); }
        function tL(model) { if (process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT === "1") return true; return false; }
        function f2Y(q) {
          if (!jo() || !q || !uz4(q)) { return []; }
          d("tengu_ultrathink", {});
          return [{ type: "ultrathink_effort", level: "high" }];
        }
        function unrelatedSetup() {
          var Z = getOther();
          doSomething(Z.options.mainLoopModel);
        }
        function setupEvents(q) {
          var K = getContext();
          oY("ultrathink_effort", () => Promise.resolve(f2Y(q)));
          oY("other_event", () => K.options.mainLoopModel);
        }
      `;
      const output = runCodemod(input);
      // Should use K (from setupEvents scope), not Z (from unrelatedSetup scope)
      expect(output).toMatch(/f2Y\(q,\s*K\.options\.mainLoopModel,/);
      expect(output).not.toMatch(/f2Y\(q,\s*Z\.options\.mainLoopModel/);
    });
  });

  describe("resilience to minifier renames", () => {
    it("works with v2.1.94-style minified names", { timeout: TIMEOUT }, () => {
      const output = runCodemod(v2194Fixture());
      expect(output).toContain("function xM3(q, model, effort)");
      expect(output).toContain("aB7()");
      expect(output).toContain("zK(model)");
      expect(output).toMatch(/xM3\(q,\s*Ctx\.options\.mainLoopModel,\s*Ctx\.getAppState\?\.?\(\)\?\.effortValue\)/);
    });

    it("uses generic callee names (not hardcoded)", { timeout: TIMEOUT }, () => {
      const input = `
        function getterFn() { return validator(obj.effortLevel); }
        function supportFn(m) { if (process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT === "1") return true; return false; }
        function detectorFn(q) {
          if (!guardA() || !q || !guardB(q)) { return []; }
          tele("tengu_ultrathink", {});
          return [{ type: "ultrathink_effort", level: "high" }];
        }
        function run(q) { var X = ctx(); reg("ultrathink_effort", () => Promise.resolve(detectorFn(q))); reg("m", () => X.options.mainLoopModel); }
      `;
      const output = runCodemod(input);
      expect(output).toContain("function detectorFn(q, model, effort)");
      expect(output).toContain("getterFn()");
      expect(output).toContain("supportFn(model)");
    });
  });

  describe("2.1.178+ state-argument getter (Zd9 refactor)", () => {
    it("passes a state object to the getter fallback, not a bare call", { timeout: TIMEOUT }, () => {
      const output = runCodemod(v21178Fixture());
      // Primary source is the passed effort; Zd9({...}) is the fallback.
      expect(output).toMatch(/effort\s*!==\s*undefined\s*\?\s*effort\s*:\s*Zd9\(\s*\{\s*/);
      expect(output).toContain("settings: c8()");
      expect(output).toContain("cli: {}");
      expect(output).toContain("env: process.env");
      // Must NOT emit the crashing bare call.
      expect(output).not.toMatch(/Zd9\(\s*\)/);
    });

    it("discovers the settings getter from the canonical call site", { timeout: TIMEOUT }, () => {
      const output = runCodemod(v21178Fixture());
      expect(output).toContain("settings: c8()");
    });

    it("adds the model + effort parameters and the call-site args", { timeout: TIMEOUT }, () => {
      const output = runCodemod(v21178Fixture());
      expect(output).toContain("function WbO(q, model, effort)");
      expect(output).toMatch(/WbO\(q,\s*K\.options\.mainLoopModel,\s*K\.getAppState\?\.?\(\)\?\.effortValue\)/);
    });

    it("returns changed > 0 when the getter takes a state arg but no canonical call site exists (partial)", { timeout: TIMEOUT }, () => {
      // Zd9(H) needs a state object, but no wrapper provides {settings: <getter>()}.
      // In code-split mode, partial application is OK — the codemod does what it can.
      const input = `
        function Zd9(H) { return IMH(H.settings.effortLevel); }
        function WP(model) { if (process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT === "1") return true; return false; }
        function WbO(q) {
          if (!jo() || !q || !xd9(q)) { return []; }
          c("tengu_ultrathink", {});
          return [{ type: "ultrathink_effort", level: "high" }];
        }
        function setupEvents(q) { var K = getContext(); oY("ultrathink_effort", () => Promise.resolve(WbO(q))); oY("x", () => K.options.mainLoopModel); }
      `;
      const result = transform(input);
      expect(result.changed).toBeGreaterThan(0);
    });
  });

  describe("fail-closed behavior", () => {
    it("returns changed: 0 when re-applied on already-transformed code", { timeout: TIMEOUT }, () => {
      const firstOutput = runCodemod(v2192Fixture());
      const result = transform(firstOutput);
      expect(result.changed).toBe(0);
    });
  });

  describe("error handling", () => {
    it("returns changed: 0 when ultrathink_effort pattern is missing", { timeout: TIMEOUT }, () => {
      const input = `function foo() { return []; }`;
      const result = transform(input);
      expect(result.changed).toBe(0);
    });

    it("returns changed > 0 when effort getter is missing (partial application)", { timeout: TIMEOUT }, () => {
      // In code-split mode, the effort getter may be in a different chunk.
      // The codemod does what it can (partial application is OK).
      const input = `
        function tL(m) { return false; }
        function f2Y(q) {
          if (!jo() || !q) { return []; }
          return [{ type: "ultrathink_effort", level: "high" }];
        }
      `;
      const result = transform(input);
      expect(result.changed).toBeGreaterThan(0);
    });

    it("returns changed > 0 when effort support check is missing (partial application)", { timeout: TIMEOUT }, () => {
      // In code-split mode, the effort support check may be in a different chunk.
      const input = `
        function jx1() { return xy3(K.effortLevel); }
        function f2Y(q) {
          if (!jo() || !q) { return []; }
          return [{ type: "ultrathink_effort", level: "high" }];
        }
      `;
      const result = transform(input);
      expect(result.changed).toBeGreaterThan(0);
    });

    it("returns changed > 0 when mainLoopModel reference is missing (partial application)", { timeout: TIMEOUT }, () => {
      // In code-split mode, the context may be in a different chunk.
      const input = `
        function jx1() { return xy3(K.effortLevel); }
        function tL(model) { if (process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT === "1") return true; return false; }
        function f2Y(q) {
          if (!jo() || !q || !uz4(q)) { return []; }
          d("tengu_ultrathink", {});
          return [{ type: "ultrathink_effort", level: "high" }];
        }
        function run(q) { reg("ultrathink_effort", () => Promise.resolve(f2Y(q))); }
      `;
      const result = transform(input);
      expect(result.changed).toBeGreaterThan(0);
    });
  });

  describe("structural preservation", () => {
    it("preserves unrelated code in the file", { timeout: TIMEOUT }, () => {
      const input = v2192Fixture() + `
        function unrelatedHelper(x, y) { return x + y; }
        const CONFIG = { version: "1.0" };
      `;
      const output = runCodemod(input);
      expect(output).toContain("function unrelatedHelper(x, y)");
      expect(output).toContain("version: \"1.0\"");
    });

    it("preserves effort getter and support functions unchanged", { timeout: TIMEOUT }, () => {
      const output = runCodemod(v2192Fixture());
      expect(output).toContain("function jx1()");
      expect(output).toContain("function tL(model)");
    });
  });
});

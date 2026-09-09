import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-fix-file-cache.cjs");

// Babel parsing in execSync is slow on CI runners — increase per-test timeout
// (bun:test default is 5000ms which is too tight for spawning Node + Babel).
const TIMEOUT = 30000;

describe("codemod-fix-file-cache", () => {
  function runCodemod(inputCode, outputPath) {
    const tempInput = path.join(process.cwd(), "test/fixtures", `temp-input-${randomUUID()}.js`);
    const tempOutput = outputPath || path.join(process.cwd(), "test/fixtures", `temp-output-${randomUUID()}.js`);

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

  describe("compaction clear() wrapping", () => {
    it("wraps clear() after sm1() snapshot with identifier K", { timeout: TIMEOUT }, () => {
      const input = `
        let v = sm1(K.readFileState);
        K.readFileState.clear();
        K.loadedNestedMemoryPaths?.clear();
      `;

      const output = runCodemod(input);

      // clear() should now be wrapped in a guard, not bare
      expect(output).toContain("__isModEnabled__");
      expect(output).toContain("fix_file_cache");
      expect(output).toContain("K.readFileState.clear()");
      expect(output).toContain("K.loadedNestedMemoryPaths?.clear()");
      expect(output).toContain("sm1(K.readFileState)");
    });

    it("wraps clear() after sm1() snapshot with identifier _", { timeout: TIMEOUT }, () => {
      const input = `
        let Z = sm1(_.readFileState);
        _.readFileState.clear();
        _.loadedNestedMemoryPaths?.clear();
      `;

      const output = runCodemod(input);

      expect(output).toContain("__isModEnabled__");
      expect(output).toContain("_.readFileState.clear()");
      expect(output).toContain("_.loadedNestedMemoryPaths?.clear()");
    });

    it("wraps clear() after snapshot with callee ZB1 (v2.1.94 style)", { timeout: TIMEOUT }, () => {
      const input = `
        let v = ZB1(K.readFileState);
        K.readFileState.clear();
        K.loadedNestedMemoryPaths?.clear();
      `;

      const output = runCodemod(input);

      expect(output).toContain("__isModEnabled__");
      expect(output).toContain("K.readFileState.clear()");
      expect(output).toContain("K.loadedNestedMemoryPaths?.clear()");
      expect(output).toContain("ZB1(K.readFileState)");
    });

    it("wraps clear() after snapshot with generic callee name snapshotFn", { timeout: TIMEOUT }, () => {
      const input = `
        let v = snapshotFn(_.readFileState);
        _.readFileState.clear();
        _.loadedNestedMemoryPaths?.clear();
      `;

      const output = runCodemod(input);

      expect(output).toContain("__isModEnabled__");
      expect(output).toContain("_.readFileState.clear()");
      expect(output).toContain("_.loadedNestedMemoryPaths?.clear()");
      expect(output).toContain("snapshotFn(_.readFileState)");
    });
  });

  describe("finally block preservation", () => {
    it("preserves clear() without preceding snapshot", { timeout: TIMEOUT }, () => {
      const input = `
        function cleanup() { try { work(); } finally {
          Z.readFileState.clear();
          v.length = 0;
        }}
      `;

      const output = runCodemod(input);

      // No __isModEnabled__ wrapping for finally blocks without preceding snapshot
      expect(output).toContain("Z.readFileState.clear()");
    });

    it("preserves clear() in finally block even when snapshot exists elsewhere", { timeout: TIMEOUT }, () => {
      const input = `
        let v = sm1(K.readFileState);
        K.readFileState.clear();
        K.loadedNestedMemoryPaths?.clear();
        function cleanup() { try { work(); } finally {
          G6.readFileState.clear();
          I.length = 0;
        }}
      `;

      const output = runCodemod(input);

      // Compaction clear wrapped
      expect(output).toContain("__isModEnabled__");
      // Finally block clear preserved (no guard wrapping)
      expect(output).toContain("G6.readFileState.clear()");
    });
  });

  describe("identifier matching", () => {
    it("preserves clear() when object identifier doesn't match snapshot argument", { timeout: TIMEOUT }, () => {
      const input = `
        let v = sm1(K.readFileState);
        _.readFileState.clear();
      `;

      const output = runCodemod(input);

      // Different identifier: should NOT be wrapped
      expect(output).toContain("_.readFileState.clear()");
    });
  });

  describe("real-world patterns", () => {
    it("handles first compaction pattern (v2.1.92 line 497382)", { timeout: TIMEOUT }, () => {
      const input = `
        if (G) { throw Error(G); }
        let v = sm1(K.readFileState);
        K.readFileState.clear();
        K.loadedNestedMemoryPaths?.clear();
        Sa6(K.memorySelector);
        let [k, V] = await Promise.all([sGK(v, K, cGK), qvK(K)]);
      `;

      const output = runCodemod(input);

      // clear() wrapped in guard
      expect(output).toContain("__isModEnabled__");
      expect(output).toContain("K.readFileState.clear()");
      expect(output).toContain("K.loadedNestedMemoryPaths?.clear()");
      expect(output).toContain("sm1(K.readFileState)");
      expect(output).toContain("Sa6(K.memorySelector)");
    });

    it("handles second compaction pattern (v2.1.92 line 497596)", { timeout: TIMEOUT }, () => {
      const input = `
        if (f) { throw Error(f); }
        let Z = sm1(_.readFileState);
        _.readFileState.clear();
        _.loadedNestedMemoryPaths?.clear();
        Sa6(_.memorySelector);
        let [v, k] = await Promise.all([sGK(Z, _, cGK, $), qvK(_)]);
      `;

      const output = runCodemod(input);

      // clear() wrapped in guard
      expect(output).toContain("__isModEnabled__");
      expect(output).toContain("_.readFileState.clear()");
      expect(output).toContain("_.loadedNestedMemoryPaths?.clear()");
      expect(output).toContain("sm1(_.readFileState)");
      expect(output).toContain("Sa6(_.memorySelector)");
    });

    it("handles v2.1.94 style with renamed callee ZB1", { timeout: TIMEOUT }, () => {
      const input = `
        if (G) { throw Error(G); }
        let v = ZB1(K.readFileState);
        K.readFileState.clear();
        K.loadedNestedMemoryPaths?.clear();
        pQ2(K.memorySelector);
        let [k, V] = await Promise.all([aM3(v, K, xR1), nV7(K)]);
      `;

      const output = runCodemod(input);

      expect(output).toContain("__isModEnabled__");
      expect(output).toContain("K.readFileState.clear()");
      expect(output).toContain("K.loadedNestedMemoryPaths?.clear()");
      expect(output).toContain("ZB1(K.readFileState)");
    });

    it("handles both compaction patterns together with finally blocks", { timeout: TIMEOUT }, () => {
      const input = `
        let v = sm1(K.readFileState);
        K.readFileState.clear();
        K.loadedNestedMemoryPaths?.clear();
        Sa6(K.memorySelector);
        function cleanup1() { try { work(); } finally {
          Z.readFileState.clear();
          v.length = 0;
        }}
        let Z = sm1(_.readFileState);
        _.readFileState.clear();
        _.loadedNestedMemoryPaths?.clear();
        Sa6(_.memorySelector);
        async function cleanup2() { try { work(); } finally {
          await c();
          G6.readFileState.clear();
          I.length = 0;
        }}
      `;

      const output = runCodemod(input);

      // Both compaction clears wrapped in guard
      expect(output).toContain("K.readFileState.clear()");
      expect(output).toContain("_.readFileState.clear()");

      // Both finally block clears preserved (no guard wrapping)
      expect(output).toContain("Z.readFileState.clear()");
      expect(output).toContain("G6.readFileState.clear()");

      // LoadedNestedMemoryPaths preserved
      expect(output).toContain("K.loadedNestedMemoryPaths?.clear()");
      expect(output).toContain("_.loadedNestedMemoryPaths?.clear()");
    });
  });

  describe("edge cases", () => {
    it("handles code with no matching patterns", { timeout: TIMEOUT }, () => {
      const input = `
        const x = 42;
        console.log(x);
      `;

      const output = runCodemod(input);

      expect(output).toContain("const x = 42");
    });

    it("does not remove snapshot call itself", { timeout: TIMEOUT }, () => {
      const input = `
        let v = sm1(K.readFileState);
        K.readFileState.clear();
      `;

      const output = runCodemod(input);

      expect(output).toContain("sm1(K.readFileState)");
      // clear() is wrapped, not removed
      expect(output).toContain("K.readFileState.clear()");
      expect(output).toContain("__isModEnabled__");
    });

    it("does not match calls with wrong argument count", { timeout: TIMEOUT }, () => {
      const input = `
        let v = someFn(K.readFileState, extra);
        K.readFileState.clear();
      `;

      const output = runCodemod(input);

      // Two-arg call should not trigger wrapping
      expect(output).toContain("K.readFileState.clear()");
      expect(output).not.toContain("__isModEnabled__");
    });

    it("does not match calls with non-readFileState property", { timeout: TIMEOUT }, () => {
      const input = `
        let v = someFn(K.otherState);
        K.otherState.clear();
      `;

      const output = runCodemod(input);

      // Not readFileState — should not wrap
      expect(output).toContain("K.otherState.clear()");
      expect(output).not.toContain("__isModEnabled__");
    });
  });
});

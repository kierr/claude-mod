import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-add-cache-keepalive.cjs");
const TIMEOUT = 30000;
const SENTINEL = "__CACHE_KEEPALIVE_INSTALLED__";

function runCodemod(inputCode) {
  const tempInput = path.join(process.cwd(), "test/fixtures", `temp-input-${randomUUID()}.js`);
  const tempOutput = path.join(process.cwd(), "test/fixtures", `temp-output-${randomUUID()}.js`);

  fs.mkdirSync(path.join(process.cwd(), "test/fixtures"), { recursive: true });
  fs.writeFileSync(tempInput, inputCode);

  try {
    const { execSync } = require("child_process");
    execSync(`node "${CODEMOD_PATH}" "${tempInput}" "${tempOutput}"`, {
      stdio: "pipe",
      cwd: process.cwd(),
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

// Build a fixture with parametrized minified names. Every anchor the codemod
// matches on is exercised: the completion setter (START + MODULE site), the
// request-id setter (STOP site), the markPostCompaction impl (INVALIDATE site),
// and the fetch chokepoint (CAPTURE site).
function buildFixture(n) {
  const { stateObj, setterParam, url, reqOpts, fetchInit, fetchHolder } = n;
  return `
function setCompletion(${setterParam}) { ${stateObj}.lastApiCompletionTimestamp = ${setterParam}; }
function setRequestId(${setterParam}) { ${stateObj}.lastMainRequestId = ${setterParam}; }
function markPostCompaction() { ${stateObj}.pendingPostCompaction = true; }
async function fetchWithTimeout(${url}, ${reqOpts}) {
  var ${fetchInit} = { method: "POST", headers: ${reqOpts}.headers, body: ${reqOpts}.body };
  try { return await ${fetchHolder}.fetch.call(undefined, ${url}, ${fetchInit}); }
  finally { clearTimeout(t); }
}
`;
}

describe("codemod-add-cache-keepalive", () => {
  describe("five-site injection", () => {
    it("injects CAPTURE, START, STOP, MODULE, and INVALIDATE (fixture A)", { timeout: TIMEOUT }, () => {
      const input = buildFixture({ stateObj: "B_", setterParam: "H", url: "U", reqOpts: "z", fetchInit: "w", fetchHolder: "this" });
      const output = runCodemod(input);

      // Sentinel — the applied status_test anchor (present as both comment + string literal).
      expect(output).toContain(SENTINEL);

      // CAPTURE: guard + call, referencing the URL arg, fetch-init's headers/body,
      // and the actual fetch holder (this.fetch for fixture A).
      expect(output).toContain("typeof __ckCapture");
      expect(output).toContain("__ckCapture(U, w.headers, w.body, this.fetch)");

      // START / STOP guarded calls land after the respective setters.
      expect(output).toContain("typeof __ckStart");
      expect(output).toContain("__ckStart()");
      expect(output).toContain("typeof __ckStop");
      expect(output).toContain("__ckStop()");

      // INVALIDATE: guarded call injected FIRST in markPostCompaction's body,
      // before the pendingPostCompaction=true assignment (codegen puts them on
      // separate lines, so match with whitespace tolerance).
      expect(output).toContain("typeof __ckInvalidate");
      expect(output).toMatch(/__ckInvalidate\(\);\s+B_\.pendingPostCompaction\s*=\s*true/);

      // MODULE: the runtime IIFE defines its globals on globalThis.
      expect(output).toContain("globalThis.__ckCapture");
      expect(output).toContain("globalThis.__ckStart");
      expect(output).toContain("globalThis.__ckStop");
      expect(output).toContain("globalThis.__ckInvalidate");
    });

    it("survives different minified names + a non-this fetch holder (fixture B)", { timeout: TIMEOUT }, () => {
      // All names rotated; fetch holder this -> self. `self.fetch.call` still matches
      // (callee.object.property === "fetch"), and the captured fetchFn must be
      // self.fetch — proving the holder is taken from the matched site, not hardcoded.
      const input = buildFixture({ stateObj: "Z9", setterParam: "Q", url: "P", reqOpts: "r", fetchInit: "opts", fetchHolder: "self" });
      const output = runCodemod(input);

      expect(output).toContain(SENTINEL);
      expect(output).toContain("__ckCapture(P, opts.headers, opts.body, self.fetch)");
      expect(output).toContain("__ckStart()");
      expect(output).toContain("__ckStop()");
      expect(output).toMatch(/__ckInvalidate\(\);\s+Z9\.pendingPostCompaction\s*=\s*true/);
      expect(output).toContain("globalThis.__ckStart");
    });
  });

  describe("CAPTURE site filters and shape", () => {
    it("only matches <holder>.fetch.call(undefined, ID, ID) with >=3 args", { timeout: TIMEOUT }, () => {
      // Two-arg call must NOT capture (no opts to stash). Include the setters + the
      // markPostCompaction marker so MODULE/START/STOP/INVALIDATE still match.
      const input = `
function setCompletion(H) { B_.lastApiCompletionTimestamp = H; }
function setRequestId(H) { B_.lastMainRequestId = H; }
function markPostCompaction() { B_.pendingPostCompaction = true; }
async function badFetch(H) { return await this.fetch.call(undefined, H); }
`;
      const output = runCodemod(input);

      // The bad fetch site is NOT captured — no __ckCapture call emitted.
      expect(output).not.toContain("__ckCapture(");
      // But START/STOP/MODULE/INVALIDATE still landed.
      expect(output).toContain("__ckStart()");
      expect(output).toContain("__ckStop()");
      expect(output).toContain("__ckInvalidate()");
      expect(output).toContain(SENTINEL);
    });
  });

  describe("INVALIDATE site precision", () => {
    it("invalidates markPostCompaction (= true) but not the resetter (= false)", { timeout: TIMEOUT }, () => {
      // The resetter reads then assigns false — must NOT be invalidated. Only the
      // single-statement `pendingPostCompaction = true` setter qualifies.
      const input = `
function markPostCompaction() { B_.pendingPostCompaction = true; }
function consumePostCompaction() { let H = B_.pendingPostCompaction; B_.pendingPostCompaction = false; return H; }
function setCompletion(H) { B_.lastApiCompletionTimestamp = H; }
`;
      const output = runCodemod(input);

      // Exactly one __ckInvalidate call site (in markPostCompaction).
      const invalidateCalls = (output.match(/__ckInvalidate\(\)/g) || []).length;
      expect(invalidateCalls).toBe(1);
      // The true-setter got it; the false-resetter did not.
      expect(output).toMatch(/__ckInvalidate\(\);\s+B_\.pendingPostCompaction\s*=\s*true/);
      expect(output).not.toMatch(/__ckInvalidate\(\);\s+B_\.pendingPostCompaction\s*=\s*false/);
    });
  });

  describe("idempotency", () => {
    it("does not double-inject already-patched code", { timeout: TIMEOUT }, () => {
      const input = buildFixture({ stateObj: "B_", param: "H", fetchInit: "w", fetchFnObj: "this" });
      const firstPass = runCodemod(input);

      // Re-running on patched output: sentinel is present, transform returns 0,
      // main() exits 1 (fail-closed standalone).
      expect(() => runCodemod(firstPass)).toThrow();
    });
  });

  describe("fail-closed on zero matches", () => {
    it("throws when no anchors are present", { timeout: TIMEOUT }, () => {
      const input = `const x = 42; console.log("nothing relevant here");`;
      expect(() => runCodemod(input)).toThrow();
    });
  });
});

import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const CODEMOD_PATH = path.join(process.cwd(), "codemods", "codemod-set-model-limits.cjs");
const TIMEOUT = 30000;

function runCodemod(inputCode) {
  const tempInput = path.join(process.cwd(), "test/fixtures", `temp-input-${crypto.randomUUID()}.js`);
  const tempOutput = path.join(process.cwd(), "test/fixtures", `temp-output-${crypto.randomUUID()}.js`);
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

// Exercise the output-limit resolver shape.
const CXH_FIXTURE = `
  function T9(h){return h;}
  function CXH(H){
    let _, q;
    let K = T9(H);
    if (K === "claude-opus-4-6"){ _ = 64000; q = 128000; }
    else { _ = 32000; q = 128000; }
    let O = $37(H);
    if (O?.max_tokens && O.max_tokens >= 4096) {
      q = O.max_tokens;
      _ = Math.min(_, q);
    }
    return { default: _, upperLimit: q };
  }
`;

// Faithful getContextWindowForModel (w37) shape: multiple `return 1000000`.
const W37_FIXTURE = `
  function Jf(h){return /\\[1m\\]/i.test(h);}
  function w37(H, _){
    if (Jf(H)) { return 1000000; }
    if (_?.includes("context-1m") && H) { return 1000000; }
    if (H) { return 1000000; }
    return fallback;
  }
`;

// Faithful getMaxOutputTokensForModel (S$H) shape: returns
// s7H("CLAUDE_CODE_MAX_OUTPUT_TOKENS", env, default, upperLimit).effective —
// the EFFECTIVE site where the global env var caps the value.
const EFF_FIXTURE = `
  function s7H(name, v, d, u){ return { effective: v ? Math.min(parseInt(v,10), u) : d }; }
  function getEff(H){
    let r = CXH(H);
    return s7H("CLAUDE_CODE_MAX_OUTPUT_TOKENS", process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, r.default, r.upperLimit).effective;
  }
`;

// CJS wrapper + mods_runtime helpers (so the helper injects).
const WRAPPER_FIXTURE = `
  (function(exports, require, module, __filename, __dirname){
    function __modsLoad__() { return {}; }
    function __isModEnabled__(id) { return __modsLoad__()[id] === true; }
    function __getModConfig__(id, key, fb) { return fb; }
    ${CXH_FIXTURE}
    ${W37_FIXTURE}
  })();
`;

describe("codemod-set-model-limits", () => {
  it("injects the CXH output override before the {default, upperLimit} return", { timeout: TIMEOUT }, () => {
    const out = runCodemod(CXH_FIXTURE);
    expect(out).toContain("model_limits_out");
    expect(out).toMatch(/__modelCaps__\(\s*\w+\s*\)/);
    // original max_tokens branch preserved
    expect(out).toContain("O?.max_tokens");
    expect(out).toContain("O.max_tokens >= 4096");
    // override sits before the return (marker precedes "default:")
    expect(out.indexOf("model_limits_out")).toBeLessThan(out.indexOf("default:"));
    // guard present
    expect(out).toContain('__isModEnabled__("set_model_limits")');
  });

  it("injects the w37 context override at the top of the function body", { timeout: TIMEOUT }, () => {
    const out = runCodemod(W37_FIXTURE);
    expect(out).toContain("model_limits_ctx");
    expect(out).toMatch(/__modelCaps__\(\s*\w+\s*\)/);
    // override precedes the first `return 1000000`
    expect(out.indexOf("model_limits_ctx")).toBeLessThan(out.indexOf("return 1000000"));
    // it returns the context value
    expect(out).toMatch(/return\s+__mcCtx\.context/);
  });

  it("injects the effective-output override at S$H (beats the global env cap)", { timeout: TIMEOUT }, () => {
    // CXH precedes the effective site; CXH gains a __modelCaps__ call from
    // Transform 2, so this also verifies the order-independence fix (the guard
    // must skip only CXH, not arm the global flag and skip S$H).
    const out = runCodemod(CXH_FIXTURE + "\n" + EFF_FIXTURE);
    expect(out).toContain("model_limits_out_eff");
    expect(out.indexOf("model_limits_out_eff")).toBeLessThan(
      out.indexOf('"CLAUDE_CODE_MAX_OUTPUT_TOKENS"')
    );
    expect(out).toMatch(/return\s+__mcEff\.output/);
  });

  it("injects the __modelCaps__ helper alongside __modsLoad__ in the CJS wrapper", { timeout: TIMEOUT }, () => {
    const out = runCodemod(WRAPPER_FIXTURE);
    expect(out).toContain("function __modelCaps__(");
    // both overrides also landed
    expect(out).toContain("model_limits_out");
    expect(out).toContain("model_limits_ctx");
  });

  it("is idempotent (running twice yields one marker each)", { timeout: TIMEOUT }, () => {
    const once = runCodemod(CXH_FIXTURE + "\n" + W37_FIXTURE);
    const twice = runCodemod(once);
    const count = (str, marker) => (str.match(new RegExp(marker, "g")) || []).length;
    expect(count(once, "model_limits_out")).toBe(1);
    expect(count(once, "model_limits_ctx")).toBe(1);
    expect(count(twice, "model_limits_out")).toBe(1);
    expect(count(twice, "model_limits_ctx")).toBe(1);
    expect(twice).toBe(once);
  });

  it("matches structurally under varied minified names (single-letter, $, _)", { timeout: TIMEOUT }, () => {
    const cxh = `
      function f($m){
        let _d, _u;
        let Z = cap($m);
        if (Z?.max_tokens && Z.max_tokens >= 4096) { _u = Z.max_tokens; _d = Math.min(_d, _u); }
        return { default: _d, upperLimit: _u };
      }
    `;
    const w37 = `
      function g(x){ if (x) { return 1000000; } if (!x) { return 1000000; } return 200000; }
    `;
    const out = runCodemod(cxh + "\n" + w37);
    expect(out).toContain("model_limits_out");
    expect(out).toContain("model_limits_ctx");
    // lookup keyed on the discovered param ($m and x), not a hardcoded name
    expect(out).toMatch(/__modelCaps__\(\s*\$m\s*\)/);
    expect(out).toMatch(/__modelCaps__\(\s*x\s*\)/);
  });

  it("leaves code without the anchors untouched", { timeout: TIMEOUT }, () => {
    const input = `
      function unrelated(H){
        let O = other(H);
        if (O?.size && O.size >= 10) { return { default: O.size, upperLimit: 99 }; }
        return 0;
      }
    `;
    const out = runCodemod(input);
    expect(out).not.toContain("model_limits_out");
    expect(out).not.toContain("model_limits_ctx");
    expect(out).not.toContain("__modelCaps__");
  });
});

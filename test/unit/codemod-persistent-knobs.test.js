import { describe, it, expect } from "bun:test";
import { transform } from "../../codemods/codemod-persistent-knobs.cjs";

function fixture(opts = {}) {
  const {
    pd3 = "pD3",
    capVar = "lU8",
    delayFn = "HKH",
    a = "Y", b = "R", backoff = "Qv7",
    resetVar = "K",
  } = opts;
  return `
  function ${pd3}(H) {
    let _ = H.headers?.get?.("anthropic-ratelimit-unified-reset");
    if (!_) return null;
    let q = Number(_);
    if (!Number.isFinite(q)) return null;
    let ${resetVar} = q * 1000 - Date.now();
    if (${resetVar} <= 0) return null;
    return Math.min(${resetVar}, ${capVar});
  }
  var ${capVar} = 21600000;
  if (W && P instanceof oq && P.status === 429) {
    h = ${pd3}(P) ?? Math.min(${delayFn}(${a}, ${b}, ${backoff}), ${capVar});
  } else if (W) {
    h = Math.min(${delayFn}(${a}, ${b}, ${backoff}), ${capVar});
  }`;
}

describe("codemod-persistent-knobs", () => {
  it("injects __apiResCap__ and __apiResBackoff__ helpers", () => {
    const out = transform(fixture());
    expect(out.changed).toBeGreaterThan(0);
    expect(out.code).toContain("function __apiResCap__(_default)");
    expect(out.code).toContain("function __apiResBackoff__(_default)");
  });

  it("wraps the cap (CAPVAR) at pD3 and both H26 persistent sites", () => {
    const out = transform(fixture());
    // pD3 site
    expect(out.code).toContain("Math.min(K, __apiResCap__(lU8))");
    // H26 sites — backoff wrapped AND cap wrapped
    expect(out.code).toContain("Math.min(HKH(Y, R, __apiResBackoff__(Qv7)), __apiResCap__(lU8))");
    const capWrapCount = (out.code.match(/__apiResCap__\(lU8\)/g) || []).length;
    expect(capWrapCount).toBe(3); // pD3 + 2 H26 sites
  });

  it("leaves the bare CAPVAR definition untouched (only wraps its use as a cap arg)", () => {
    const out = transform(fixture());
    expect(out.code).toContain("var lU8 = 21600000;");
  });

  it("works with different minified names incl. dollar-bearing cap var", () => {
    const out = transform(fixture({ capVar: "c$p", delayFn: "gR", a: "y", b: "r", backoff: "b$k", resetVar: "kk" }));
    expect(out.changed).toBeGreaterThan(0);
    expect(out.code).toContain("__apiResCap__(c$p)");
    expect(out.code).toContain("__apiResBackoff__(b$k)");
  });

  it("is idempotent", () => {
    const once = transform(fixture());
    const twice = transform(once.code);
    expect(twice.changed).toBe(0);
    expect(twice.code).toBe(once.code);
  });

  it("does not transform code without pD3 (reset-header reader)", () => {
    const out = transform("function lv7(H) { return H.status === 429; }");
    expect(out.changed).toBe(0);
  });

  it("produces syntactically valid JS", () => {
    const parser = require("../../codemods/node_modules/@babel/parser");
    const out = transform(fixture());
    expect(() =>
      parser.parse(out.code, { sourceType: "unambiguous", plugins: ["jsx", "typescript"] })
    ).not.toThrow();
  });
});

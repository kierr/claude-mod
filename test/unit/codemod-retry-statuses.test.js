import { describe, it, expect } from "bun:test";
import { transform } from "../../codemods/codemod-retry-statuses.cjs";

function lv7Fixture(overloadedFn = "MWH", param = "H", errCls = "oq") {
  return `  function lv7(${param}) {
    return ${overloadedFn}(${param}) || ${param} instanceof ${errCls} && ${param}.status === 429;
  }`;
}

describe("codemod-retry-statuses", () => {
  it("appends __apiResRetryExtra__ to lv7 and injects the helper", () => {
    const out = transform(lv7Fixture());
    expect(out.changed).toBe(1);
    expect(out.code).toContain("function __apiResRetryExtra__(_e)");
    expect(out.code).toContain("|| __apiResRetryExtra__(H)");
    // Original predicates preserved as the leading disjuncts.
    expect(out.code).toContain("MWH(H)");
    expect(out.code).toContain("H.status === 429");
  });

  it("helper checks both retry_extra_statuses and retry_extra_patterns", () => {
    const out = transform(lv7Fixture());
    expect(out.code).toContain('"retry_extra_statuses"');
    expect(out.code).toContain('"retry_extra_patterns"');
    // Default statuses/patterns baked in (user's observed transient errors).
    expect(out.code).toContain("408,502,503,504");
    expect(out.code).toContain("Invalid HTTP request received");
    expect(out.code).toContain("ConnectionInputs.RECV_DATA in state ConnectionState.CLOSED");
  });

  it("works with different minified names (release A)", () => {
    const out = transform(lv7Fixture("isOverloaded", "err", "APIError"));
    expect(out.changed).toBe(1);
    expect(out.code).toContain("|| __apiResRetryExtra__(err)");
    expect(out.code).toContain("isOverloaded(err)");
  });

  it("works with single-letter / dollar minified names", () => {
    const out = transform(lv7Fixture("a", "x", "oq"));
    expect(out.changed).toBe(1);
    expect(out.code).toContain("|| __apiResRetryExtra__(x)");
    // Dollar-bearing names survive (no String.replace $ corruption — helper uses concat).
    const out2 = transform(lv7Fixture("l$6", "e$", "oq"));
    expect(out2.changed).toBe(1);
    expect(out2.code).toContain("__apiResRetryExtra__(e$)");
  });

  it("is idempotent (second run is a no-op)", () => {
    const once = transform(lv7Fixture());
    const twice = transform(once.code);
    expect(twice.changed).toBe(0);
    expect(twice.code).toBe(once.code);
  });

  it("does not transform code without the lv7 shape", () => {
    const input = "function unrelated(H) { return H.status === 404; }";
    const out = transform(input);
    expect(out.changed).toBe(0);
    expect(out.code).toBe(input);
  });

  it("produces syntactically valid JS", () => {
    const parser = require("../../codemods/node_modules/@babel/parser");
    const out = transform(lv7Fixture());
    expect(() =>
      parser.parse(out.code, { sourceType: "unambiguous", plugins: ["jsx", "typescript"] })
    ).not.toThrow();
  });
});

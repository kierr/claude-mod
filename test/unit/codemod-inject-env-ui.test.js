import { describe, it, expect } from "bun:test";

const parser = require("@babel/parser");
const generate = require("@babel/generator").default;
const { transform, getEnvCatalog, buildEnvTabExpression } = require("../../codemods/codemod-inject-env-ui.cjs");

/**
 * Minimal /config panel shape: a Stats tab createElement, a tab array with a
 * SpreadElement, a CJS IIFE wrapper (so requireFnName resolves to `require`),
 * and a Box/Text export pattern (so ink discovery resolves). All identifiers
 * configurable to prove name-agnostic matching.
 */
function buildConfigFixture(names = {}) {
  const react = names.react || "X1";
  const tabComp = names.tabComp || "Y1";
  const box = names.box || "BX";
  const text = names.text || "TX";
  return `(function(exports, require, module, __filename, __dirname) {
  var ${react} = {};
  function __export(target, all) { for (var k in all) { target[k] = all[k]; } }
  __export(${react}, { Box: () => ${box}, Text: () => ${text}, createElement: () => CE });
  var ${box} = function(){};
  var ${text} = function(){};
  var pluginTabs = [];
  function Panel() {
    var tabs = [
      ${react}.createElement(${tabComp}, { key: "stats", title: "Stats" }, null),
      ...pluginTabs
    ];
    return tabs;
  }
})();`;
}

function applyTransform(code) {
  const ast = parser.parse(code, { sourceType: "unambiguous", plugins: ["jsx", "typescript"] });
  const changed = transform(ast);
  const output = generate(ast, { retainLines: false }, code).code;
  return { changed, output };
}

describe("codemod-inject-env-ui transform", () => {
  it("injects the Environment tab and the __EnvTab__ function", () => {
    const { changed, output } = applyTransform(buildConfigFixture());
    expect(changed).toBe(2);
    expect(output).toContain('title: "Environment"');
    expect(output).toContain("function __EnvTab__");
  });

  it("matches with renamed minified identifiers (name-agnostic)", () => {
    const { changed, output } = ApplyWithNames({ react: "Q9", tabComp: "ZZ", box: "Bb", text: "Tt" });
    expect(changed).toBe(2);
    expect(output).toContain('title: "Environment"');
  });
  function ApplyWithNames(names) {
    return applyTransform(buildConfigFixture(names));
  }

  it("is idempotent — a second pass is a no-op", () => {
    const first = applyTransform(buildConfigFixture());
    const ast2 = parser.parse(first.output, { sourceType: "unambiguous", plugins: ["jsx", "typescript"] });
    const changed2 = transform(ast2);
    const output2 = generate(ast2, { retainLines: false }, first.output).code;
    expect(changed2).toBe(0);
    expect(output2).toBe(first.output);
  });

  it("is a no-op when there is no Stats tab", () => {
    const noStats = `(function(exports, require){ function P(){ var t = [ ...x ]; return t; } })();`;
    const { changed, output } = applyTransform(noStats);
    expect(changed).toBe(0);
    expect(output).not.toContain("__EnvTab__");
  });
});

describe("codemod-inject-env-ui getEnvCatalog", () => {
  const cat = getEnvCatalog();

  it("loads every curated entry and rule without a discovery snapshot", () => {
    const curated = require("../../patches/env-catalog.json");
    const withoutDiscovery = getEnvCatalog((file) => file === "env-catalog.json" ? curated : null);
    expect(withoutDiscovery.entries.map((entry) => entry.name).sort()).toEqual(
      curated.curated.map((entry) => entry.name).sort()
    );
    expect(withoutDiscovery.rules).toEqual(curated.rules);
    expect(cat.entries.filter((entry) => entry.tier === "curated").map((entry) => entry.name).sort()).toEqual(
      curated.curated.map((entry) => entry.name).sort()
    );
  });

  it("curated entries carry rich metadata and tier:curated", () => {
    const base = cat.entries.find((e) => e.name === "ANTHROPIC_BASE_URL");
    expect(base).toBeDefined();
    expect(base.tier).toBe("curated");
    expect(typeof base.summary).toBe("string");
    expect(base.summary.length).toBeGreaterThan(0);
  });

  it("merges discovered entries while preserving curated precedence", () => {
    const fixtures = {
      "env-catalog.json": {
        curated: [{ name: "EXAMPLE_SHARED", summary: "Documented", type: "boolean" }],
        rules: [{ id: "example-rule" }],
      },
      "env-catalog.discovered.json": {
        entries: [{ name: "EXAMPLE_SHARED", reads: 2 }, { name: "EXAMPLE_DISCOVERED", reads: 3 }],
      },
    };
    const merged = getEnvCatalog((file) => fixtures[file]);
    expect(merged.entries).toHaveLength(2);
    expect(merged.entries.find((entry) => entry.name === "EXAMPLE_SHARED")).toMatchObject({
      tier: "curated", summary: "Documented", type: "boolean",
    });
    expect(merged.entries.find((entry) => entry.name === "EXAMPLE_DISCOVERED")).toMatchObject({
      tier: "discovered", detail: "Read 3× in the baseline.", live: "restart",
    });
    expect(merged.rules).toEqual(fixtures["env-catalog.json"].rules);
  });

  it("every entry badges live:restart (env vars do not hot-reload)", () => {
    for (const e of cat.entries) expect(e.live).toBe("restart");
  });
});

describe("codemod-inject-env-ui buildEnvTabExpression", () => {
  it("produces parseable runtime code after placeholder substitution", () => {
    let code = buildEnvTabExpression();
    code = code.replace(/__REACT_REF__/g, "R")
      .replace(/__REQUIRE_FN__/g, "require")
      .replace(/__INK_BOX__/g, "B")
      .replace(/__INK_TEXT__/g, "V");
    expect(() => parser.parse(code, { sourceType: "unambiguous", plugins: ["jsx", "typescript"] })).not.toThrow();
  });

  it("renders readable source labels, provenance, and bounded row text", () => {
    const code = buildEnvTabExpression();
    expect(code).toContain('source === "env" ? "shell" : "default"');
    expect(code).toContain('ent.tier === "curated" ? "documented" : "discovered"');
    expect(code).toContain('shortText(e.name, 43)');
    expect(code).toContain("Search \" + total + \"/\" + CATALOG.length + \" env vars");
    expect(code).toContain("Space toggle booleans");
  });

  it("only lets Space toggle boolean detail rows", () => {
    const code = buildEnvTabExpression();
    expect(code).toContain('isReturn || (input === " " && ent.type === "boolean")');
    expect(code).not.toContain('isReturn || input === " ")');
  });
});

describe("codemod-inject-env-ui status regexes", () => {
  it("applied matches patched output and applicable matches the fixture", () => {
    const appliedRe = /title:\s*"Environment"/;
    const applicableRe = /title:\s*"Stats"/;
    const { output } = applyTransform(buildConfigFixture());
    const fixture = buildConfigFixture();
    expect(appliedRe.test(output)).toBe(true);
    expect(applicableRe.test(fixture)).toBe(true);
    expect(appliedRe.test(fixture)).toBe(false);
  });
});

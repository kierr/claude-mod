import { describe, it, expect } from "bun:test";
import { transform } from "../../codemods/codemod-add-auth-token-as-api-key.cjs";

function buildFixture(variants = {}) {
  const {
    apiKeyHelperParam = "skipRetrievingKeyFromApiKeyHelper",
    bareModeFn = "$1",
    ulFn = "UL",
    jeHFn = "jeH",
    shFn = "SH",
    apiKeyHelperFn = "_u",
  } = variants;

  return `  function A$(H = {}) {
    if (${bareModeFn}()) {
      if (process.env.ANTHROPIC_API_KEY) {
        return {
          key: process.env.ANTHROPIC_API_KEY,
          source: "ANTHROPIC_API_KEY"
        };
      }
      if (${apiKeyHelperFn}()) {
        return {
          key: H.${apiKeyHelperParam} ? null : dH8(),
          source: "apiKeyHelper"
        };
      }
      return {
        key: null,
        source: "none"
      };
    }
    let _ = ${ulFn}() ? undefined : process.env.ANTHROPIC_API_KEY;
    if (${jeHFn}() && _) {
      return {
        key: _,
        source: "ANTHROPIC_API_KEY"
      };
    }
    return {
      key: null,
      source: "none"
    };
  }`;
}

describe("codemod-add-auth-token-as-api-key", () => {
  it("injects ANTHROPIC_AUTH_TOKEN check into A$() with mod guard", () => {
    const code = buildFixture();
    const { code: result, changed } = transform(code);

    expect(changed).toBe(1);
    expect(result).toContain("__ATAK__");
    expect(result).toContain('__isModEnabled__("add_auth_token_as_api_key")');
    expect(result).toContain("process.env.ANTHROPIC_AUTH_TOKEN");
    expect(result).toContain('source: "ANTHROPIC_AUTH_TOKEN"');
    expect(result).toContain("process.env.ANTHROPIC_API_KEY");

    // Verify the injection appears before the normal resolution `let _ = ...`
    const authCheck = result.indexOf("__ATAK__");
    const letStatement = result.indexOf("let _ =");
    expect(authCheck).toBeLessThan(letStatement);
  });

  it("is idempotent — does not apply twice", () => {
    const code = buildFixture();
    const { code: first } = transform(code);
    const { code: second, changed } = transform(first);

    expect(changed).toBe(0);
    expect(first).toBe(second);
  });

  it("survives minified function name changes", () => {
    const code = buildFixture({
      bareModeFn: "ZB1",
      ulFn: "x9K",
      jeHFn: "mQ2",
      shFn: "pR4",
      apiKeyHelperFn: "aT7",
    });
    const { changed } = transform(code);
    expect(changed).toBe(1);
  });

  it("returns no match when anchor is missing", () => {
    const code = `function foo() { return "bar"; }`;
    const { changed } = transform(code);
    expect(changed).toBe(0);
  });

  it("rejects wrong context — anchor not near match", () => {
    // Has the structural pattern but skipRetrievingKeyFromApiKeyHelper is far away
    const code = `
      // ... 500+ chars of unrelated code ...
      ${" ".repeat(600)}
      return {
        key: null,
        source: "none"
      };
    }
    let _ = UL() ? undefined : process.env.ANTHROPIC_API_KEY;
    `;
    const { changed } = transform(code);
    expect(changed).toBe(0);
  });

  it("handles $ in minified names without corruption", () => {
    // Minified names like $1, $2 contain $ which would be interpreted as
    // backreferences by String.prototype.replace if passed as a string arg.
    const code = buildFixture({ ulFn: "$1" });
    const { code: result, changed } = transform(code);
    expect(changed).toBe(1);
    // $1 function name in the let statement must be preserved verbatim
    expect(result).toContain("let _ = $1() ? undefined : process.env.ANTHROPIC_API_KEY;");
    expect(result).toContain("__ATAK__");
  });

  it("suppresses the both-auth-methods false-positive warning (guard rider)", () => {
    // The auth-token injection makes both resolvers report ANTHROPIC_AUTH_TOKEN,
    // tripping both-auth-methods. The rider generalizes the guard to fire only
    // when the two resolvers report DIFFERENT sources.
    const code = buildFixture() + [
      '  function bothAuth() {',
      '    let { source: e } = A$({ skipRetrievingKeyFromApiKeyHelper: true });',
      '    let t = sK();',
      '    return e !== "none" && t.source !== "none" && (e !== "apiKeyHelper" || t.source !== "apiKeyHelper");',
      '  }',
    ].join("\n");
    const { code: result, changed } = transform(code);
    expect(changed).toBe(2);
    expect(result).toContain("__ATAK__");
    expect(result).toContain("__BAM__");
    // new guard form: (X !== Y.source), original double-apiKeyHelper guard gone
    expect(result).toMatch(/\([\w$]+ !== [\w$]+\.source\) \/\* __BAM__ \*\//);
    expect(result).not.toContain('!== "apiKeyHelper" ||');
  });

  it("survives minified guard-identifier changes (backrefs are structural)", () => {
    const code = buildFixture() + [
      '  function bothAuth() {',
      '    let { source: Zq } = A$({ skipRetrievingKeyFromApiKeyHelper: true });',
      '    let tt = sK();',
      '    return Zq !== "none" && tt.source !== "none" && (Zq !== "apiKeyHelper" || tt.source !== "apiKeyHelper");',
      '  }',
    ].join("\n");
    const { code: result, changed } = transform(code);
    expect(changed).toBe(2);
    expect(result).toContain("(Zq !== tt.source)");
    expect(result).not.toContain('!== "apiKeyHelper" ||');
  });
});

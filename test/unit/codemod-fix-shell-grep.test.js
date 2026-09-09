import { describe, it, expect } from "bun:test";
import path from "path";
import { transform } from "../../codemods/codemod-fix-shell-grep.cjs";

const parser = require(path.join(process.cwd(), "codemods/node_modules/@babel/parser"));

// Build a fixture matching the deobfuscated qo5() function.
// Uses string concat to avoid template literal escaping issues with
// nested backticks and quotes.
function buildFixture(names = {}) {
  const {
    fnName = "qo5",
    helperFn = "lw",
    innerFn = "tk8",
    excludeDirs = "_o5",
    helperParam = "H",
  } = names;

  const NL = "\n";
  const Q = '"';
  const BT = "`";

  return (
    "  function " + fnName + "() {" + NL +
    "    if (!" + helperFn + "()) {" + NL +
    "      return null;" + NL +
    "    }" + NL +
    "    return [" + Q + "unalias find 2>/dev/null || true" + Q + ", " +
    Q + "unalias grep 2>/dev/null || true" + Q + ", " +
    innerFn + "(" + Q + "find" + Q + ", " + Q + "bfs" + Q + ", [" + Q + "-regextype" + Q + ", " + Q + "findutils-default" + Q + "]), " +
    innerFn + "(" + Q + "grep" + Q + ", " + Q + "ugrep" + Q + ", [" + Q + "-G" + Q + ", " + Q + "--ignore-files" + Q + ", " + Q + "--hidden" + Q + ", " + Q + "-I" + Q + ", ..." + excludeDirs + ".map(" + helperParam + " => " + BT + "--exclude-dir=${" + helperParam + "}" + BT + ")], [" + Q + "-*-filter*" + Q + ", " + Q + "-*-pager*" + Q + "])].join(" + BT + NL + BT + ");" + NL +
    "  }"
  );
}

describe("codemod-fix-shell-grep", () => {
  describe("basic transformation", () => {
    it("prepends mod-guard return null and preserves original body", () => {
      const code = buildFixture();
      const { code: result, changed } = transform(code);

      expect(changed).toBe(1);
      expect(result).toContain("__DUS__");
      expect(result).toContain('__isModEnabled__("fix_shell_grep")');
      expect(result).toContain("typeof __isModEnabled__");
      // Mod guard return null is present
      expect(result).toMatch(/return null;\s*\/\* __DUS__ \*\//);
      // Original body is preserved
      expect(result).toContain('"ugrep"');
      expect(result).toContain('"unalias grep');
    });

    it("preserves the original function name", () => {
      const code = buildFixture({ fnName: "qo5" });
      const { code: result } = transform(code);

      expect(result).toMatch(/function qo5\(\)/);
    });

    it("preserves ugrep and bfs references in original body", () => {
      const code = buildFixture();
      const { code: result } = transform(code);

      // Original body is preserved below the mod guard
      expect(result).toContain('"ugrep"');
      expect(result).toContain('"bfs"');
      expect(result).toContain('"unalias grep');
    });
  });

  describe("minified name resilience", () => {
    it("works with different function names", () => {
      const code = buildFixture({ fnName: "Z9k" });
      const { changed, code: result } = transform(code);

      expect(changed).toBe(1);
      expect(result).toMatch(/function Z9k\(\)/);
    });

    it("works with different helper function names", () => {
      const code = buildFixture({ helperFn: "checkShell", innerFn: "genSnippet" });
      const { changed } = transform(code);

      expect(changed).toBe(1);
    });

    it("works with single-letter names", () => {
      const code = buildFixture({ fnName: "q", helperFn: "l", innerFn: "t" });
      const { changed } = transform(code);

      expect(changed).toBe(1);
    });

    it("works with dollar-sign names", () => {
      const code = buildFixture({ fnName: "$qo", helperFn: "$lw" });
      const { changed } = transform(code);

      expect(changed).toBe(1);
    });
  });

  describe("idempotency", () => {
    it("does not apply twice", () => {
      const code = buildFixture();
      const { code: first } = transform(code);
      const { code: second, changed } = transform(first);

      expect(changed).toBe(0);
      expect(first).toBe(second);
    });

    it("produces stable output on repeated runs", () => {
      const code = buildFixture();
      const { code: once } = transform(code);
      const { code: twice } = transform(once);
      const { code: thrice } = transform(twice);

      expect(once).toBe(twice);
      expect(twice).toBe(thrice);
    });
  });

  describe("no-match cases", () => {
    it("does not transform code without ugrep", () => {
      const code = 'function foo() { return "bar"; }';
      const { changed } = transform(code);

      expect(changed).toBe(0);
    });

    it("does not transform code with ugrep but without unalias grep", () => {
      const code = 'function setup() { return ["ugrep"]; }';
      const { changed } = transform(code);

      expect(changed).toBe(0);
    });

    it("does not transform empty code", () => {
      const { changed, code: result } = transform("");

      expect(changed).toBe(0);
      expect(result).toBe("");
    });
  });

  describe("structural integrity", () => {
    it("produces syntactically valid JS", () => {
      const code = buildFixture();
      const { code: result } = transform(code);

      try {
        parser.parse(result, { sourceType: "module" });
      } catch (e) {
        throw new Error("Output is not valid JS: " + e.message + "\n" + result);
      }
    });

    it("contains both mod guard and original body", () => {
      const code = buildFixture();
      const { code: result } = transform(code);

      // Should have the mod guard at the top of the function
      const dusIdx = result.indexOf("__DUS__");
      // Original body content appears after the marker
      const ugrepIdx = result.indexOf('"ugrep"');
      expect(ugrepIdx).toBeGreaterThan(dusIdx);
    });
  });
});

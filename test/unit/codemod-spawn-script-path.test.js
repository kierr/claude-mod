import { describe, it, expect } from "bun:test";
import path from "path";

const parser = require(path.join(process.cwd(), "codemods/node_modules/@babel/parser"));

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-spawn-script-path.cjs");
const { transform } = require(CODEMOD_PATH);

const PATCH_ID = "spawn_script_path";
const TIMEOUT = 5000;

function buildFixture(names = {}) {
  const {
    nativeFn = "EA",      // the native-binary check
    argvVar = "t",        // QF's `let t = process.argv[1]`
    innerVar = "e",       // posix_spawn's binary-path var
    letVar = "l",         // posix_spawn's argv-array var
  } = names;

  return `  function ${nativeFn}() {
    return Array.isArray(Bun.embeddedFiles) && Bun.embeddedFiles.length > 0;
  }
  function eBn() {
    if (!${nativeFn}()) { return false; }
    return process.execPath.startsWith("x");
  }
  function QF(e = {}) {
    if (!e.pinToCurrentBinary && eBn()) {
      return { cmd: "claude", prefixArgs: [] };
    }
    if (${nativeFn}()) {
      return {
        cmd: process.execPath,
        prefixArgs: []
      };
    }
    let ${argvVar} = process.argv[1];
    if (!${argvVar}) {
      return { cmd: process.execPath, prefixArgs: [] };
    }
    return { cmd: process.execPath, prefixArgs: [${argvVar}] };
  }
  function u3m() {
    if (${nativeFn}()) {
      return [process.execPath];
    } else {
      return [process.execPath, process.argv[1]];
    }
  }
  function spawnTcc(${innerVar}) {
    let ${letVar} = ${nativeFn}() ? [${innerVar}] : [${innerVar}, process.argv[1]];
    let c = Buffer.from(${innerVar} + "\\0", "utf8");
    return { ${letVar}, c };
  }
`;
}

describe("codemod-spawn-script-path", () => {
  describe("site 1 — QF dispatch spawn", () => {
    it("should guard the native branch prefixArgs with the script path", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code, changed } = transform(input);

      expect(changed).toBe(3);
      // default-ON guard: on unless spawn_script_path is explicitly false
      expect(code).toContain(
        'prefixArgs: typeof __modsLoad__ !== "function" || __modsLoad__()["spawn_script_path"] !== false ? [process.argv[1]] : []',
      );
    });

    it("should leave the no-argv and versioned branches untouched", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);

      // The versioned-install branch (cmd: "claude") and the `if (!t)` branch keep prefixArgs: []
      // unguarded — only the native-binary branch is guarded.
      const unguarded = code.match(/prefixArgs: \[\]/g) || [];
      expect(unguarded.length).toBe(2);
    });
  });

  describe("site 2 — u3m spare-pool spawn", () => {
    it("should guard return [process.execPath] with the script path", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);

      expect(code).toContain(
        '!== false ? [process.execPath, process.argv[1]] : [process.execPath];',
      );
    });
  });

  describe("site 3 — posix_spawn TCC", () => {
    it("should guard the ternary to always include the script path", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);

      expect(code).toContain('["spawn_script_path"] !== false ? [e, process.argv[1]]');
      // original ternary preserved in the fallback
      expect(code).toContain("(EA() ? [e] : [e, process.argv[1]])");
    });
  });

  describe("resilience", () => {
    it("should work with dollar-bearing minified names", { timeout: TIMEOUT }, () => {
      const input = buildFixture({ nativeFn: "$EA", argvVar: "$t", innerVar: "$e", letVar: "$l" });
      const { changed } = transform(input);
      expect(changed).toBe(3);
    });

    it("should produce syntactically valid JS", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);
      expect(() => parser.parse(code, { sourceType: "module" })).not.toThrow();
    });
  });

  describe("idempotency", () => {
    it("should return changed=0 on second application", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const first = transform(input);
      expect(first.changed).toBe(3);
      expect(transform(first.code).changed).toBe(0);
    });

    it("should produce identical output on repeated runs", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const once = transform(input).code;
      const twice = transform(once).code;
      expect(once).toBe(twice);
    });
  });

  describe("no-match cases", () => {
    it("should not transform code without the targets", { timeout: TIMEOUT }, () => {
      const input = `function test() { return true; }`;
      const { code, changed } = transform(input);
      expect(changed).toBe(0);
      expect(code).toBe(input);
    });

    it("should report 0 on empty code", { timeout: TIMEOUT }, () => {
      const { changed } = transform("");
      expect(changed).toBe(0);
    });
  });

  describe("patch YAML status_test regex round-trip", () => {
    const { assertAppliedRegex, getApplicableRegex } = require("./test-helpers.cjs");

    it("applied regex should match patched output", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);
      assertAppliedRegex(PATCH_ID, code);
    });

    it("applicable regex should match unpatched fixture", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const re = getApplicableRegex(PATCH_ID);
      expect(re).not.toBeNull();
      expect(re.test(input)).toBe(true);
    });
  });
});

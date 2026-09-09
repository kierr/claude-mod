import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const ENGINE_PATH = path.join(process.cwd(), "lib/engine.cjs");

describe("engine", () => {
  let tmpDir;
  let patchesDir;
  let codemodsDir;
  let inputPath;

  beforeEach(() => {
    tmpDir = path.join(process.cwd(), "test/fixtures", `engine-${randomUUID()}`);
    patchesDir = path.join(tmpDir, "patches");
    codemodsDir = path.join(tmpDir, "codemods");
    fs.mkdirSync(patchesDir, { recursive: true });
    fs.mkdirSync(codemodsDir, { recursive: true });
    inputPath = path.join(tmpDir, "input.js");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeYAML(name, content) {
    fs.writeFileSync(path.join(patchesDir, `${name}.yaml`), content);
  }

  function writeCodemod(name, code) {
    fs.writeFileSync(path.join(codemodsDir, `codemod-${name}.cjs`), code);
  }

  function writeInput(code) {
    fs.writeFileSync(inputPath, code);
  }

  // Engine resolves scripts as: path.join(path.dirname(codemodsDir), script)
  // So "codemods/codemod-X.cjs" resolves correctly relative to tmpDir.
  function mkYAML(name, order, applied, applicable, engine) {
    const lines = [
      `id: "${name}"`,
      `order: ${order}`,
      `status_tests:`,
      `  applied: '${applied}'`,
    ];
    if (applicable) lines.push(`  applicable: '${applicable}'`);
    lines.push(`codemod:`);
    lines.push(`  type: "node_script"`);
    lines.push(`  engine: "${engine || "regex"}"`);
    lines.push(`  script: "codemods/codemod-${name}.cjs"`);
    return lines.join("\n");
  }

  // Regex codemod: appends "// PATCHED" to output
  const REGEX_CODEMOD = `module.exports = {
  transform(code) {
    return { code: code + "\\n// PATCHED", changed: true };
  }
};`;

  // Regex codemod: replaces "foo" with "bar"
  const REPLACE_CODEMOD = `module.exports = {
  transform(code) {
    const out = code.replace(/foo/g, "bar");
    return { code: out, changed: out !== code };
  }
};`;

  describe("ordered application", () => {
    it("should apply patches in ascending order", () => {
      writeInput("foo baz");
      writeCodemod("alpha", REGEX_CODEMOD);
      writeCodemod("beta", REPLACE_CODEMOD);
      writeYAML("alpha", mkYAML("alpha", 10, "PATCHED"));
      writeYAML("beta", mkYAML("beta", 20, "bar", "foo"));

      const { applyPatches } = require(ENGINE_PATH);
      const result = applyPatches({
        filePath: inputPath,
        patchNames: ["beta", "alpha"],
        patchesDir,
        codemodsDir,
      });

      expect(result.applied).toBe(2);
      expect(result.failed).toBe(0);
      const output = fs.readFileSync(inputPath, "utf8");
      expect(output).toContain("PATCHED");
      expect(output).toContain("bar");
    });

    it("should handle single patch", () => {
      writeInput("const x = 1;");
      writeCodemod("single", REGEX_CODEMOD);
      writeYAML("single", mkYAML("single", 50, "PATCHED"));

      const { applyPatches } = require(ENGINE_PATH);
      const result = applyPatches({
        filePath: inputPath,
        patchNames: ["single"],
        patchesDir,
        codemodsDir,
      });

      expect(result.applied).toBe(1);
      expect(result.failed).toBe(0);
    });
  });

  describe("skip logic", () => {
    it("should skip patches already applied", () => {
      writeInput("const x = 1;\n// PATCHED");
      writeCodemod("skip_me", REGEX_CODEMOD);
      writeYAML("skip_me", mkYAML("skip_me", 50, "PATCHED"));

      const { applyPatches } = require(ENGINE_PATH);
      const result = applyPatches({
        filePath: inputPath,
        patchNames: ["skip_me"],
        patchesDir,
        codemodsDir,
      });

      expect(result.applied).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.patches["skip_me"].status).toBe("already_applied");
      const content = fs.readFileSync(inputPath, "utf8");
      expect(content.match(/PATCHED/g).length).toBe(1);
    });

    it("should skip patches not applicable", () => {
      writeInput("const x = 1;");
      writeCodemod("nope", REGEX_CODEMOD);
      writeYAML("nope", mkYAML("nope", 50, "PATCHED", "MUST_HAVE_THIS_PATTERN"));

      const { applyPatches } = require(ENGINE_PATH);
      const result = applyPatches({
        filePath: inputPath,
        patchNames: ["nope"],
        patchesDir,
        codemodsDir,
      });

      expect(result.applied).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.patches["nope"].status).toBe("not_applicable");
    });
  });

  describe("all-or-nothing write", () => {
    it("should NOT write to disk if verification fails", () => {
      const originalContent = "const x = 'hello';";
      writeInput(originalContent);
      writeCodemod("bad", `module.exports = {
  transform(code) {
    return { code: code.replace("hello", "world"), changed: true };
  }
};`);
      writeYAML("bad", mkYAML("bad", 50, "THIS_PATTERN_WILL_NEVER_MATCH", undefined, "regex"));

      // Suppress engine diagnostic output (✗, FAILED_PATCHES) — this test
      // intentionally triggers a verification failure; the diagnostics are
      // noise in test output, not real failures.
      const origError = console.error;
      const captured = [];
      console.error = (...args) => captured.push(args.join(" "));

      try {
        const { applyPatches } = require(ENGINE_PATH);
        const result = applyPatches({
          filePath: inputPath,
          patchNames: ["bad"],
          patchesDir,
          codemodsDir,
        });

        expect(result.failed).toBe(1);
        expect(result.patches["bad"].status).toBe("verification_failed");
        const onDisk = fs.readFileSync(inputPath, "utf8");
        expect(onDisk).toBe(originalContent);
      } finally {
        console.error = origError;
      }
    });
  });

  describe("structured result shape", () => {
    it("should return applied, skipped, failed, patches map", () => {
      writeInput("const x = 1;");
      writeCodemod("simple", REGEX_CODEMOD);
      writeYAML("simple", mkYAML("simple", 50, "PATCHED"));

      const { applyPatches } = require(ENGINE_PATH);
      const result = applyPatches({
        filePath: inputPath,
        patchNames: ["simple"],
        patchesDir,
        codemodsDir,
      });

      expect(result).toHaveProperty("applied");
      expect(result).toHaveProperty("skipped");
      expect(result).toHaveProperty("failed");
      expect(result).toHaveProperty("patches");
      expect(typeof result.applied).toBe("number");
      expect(typeof result.skipped).toBe("number");
      expect(typeof result.failed).toBe("number");
      expect(typeof result.patches).toBe("object");
    });

    it("should record error for missing patch YAML", () => {
      writeInput("const x = 1;");

      const { applyPatches } = require(ENGINE_PATH);
      const result = applyPatches({
        filePath: inputPath,
        patchNames: ["nonexistent"],
        patchesDir,
        codemodsDir,
      });

      expect(result.failed).toBe(1);
      expect(result.patches["nonexistent"].status).toBe("error");
      expect(result.patches["nonexistent"].error.message).toContain("Patch not found");
    });
  });

  describe("dry-run mode", () => {
    it("should classify without transforming", () => {
      writeInput("const x = 1;");
      writeCodemod("dry", REGEX_CODEMOD);
      writeYAML("dry", mkYAML("dry", 50, "PATCHED"));

      const { applyPatches } = require(ENGINE_PATH);
      const result = applyPatches({
        filePath: inputPath,
        patchNames: ["dry"],
        dryRun: true,
        patchesDir,
        codemodsDir,
      });

      expect(result.applied).toBe(1);
      expect(result.output).toBeDefined();
      const onDisk = fs.readFileSync(inputPath, "utf8");
      expect(onDisk).toBe("const x = 1;");
    });

    it("should classify already-applied in dry-run", () => {
      writeInput("const x = 1;\n// PATCHED");
      writeCodemod("dry_skip", REGEX_CODEMOD);
      writeYAML("dry_skip", mkYAML("dry_skip", 50, "PATCHED"));

      const { applyPatches } = require(ENGINE_PATH);
      const result = applyPatches({
        filePath: inputPath,
        patchNames: ["dry_skip"],
        dryRun: true,
        patchesDir,
        codemodsDir,
      });

      expect(result.skipped).toBe(1);
      expect(result.patches["dry_skip"].status).toBe("already_applied");
    });
  });
});

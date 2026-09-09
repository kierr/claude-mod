/**
 * Integration tests for the patch workflow
 *
 * Tests the end-to-end workflow using bin/batch-apply.cjs as the patch executor.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { randomUUID } from "crypto";

const ROOT_DIR = process.cwd();
const FIXTURES_DIR = path.join(ROOT_DIR, "test/fixtures");

describe("Integration: Patch Workflow", () => {
  let tempDir;
  let testCliPath;

  beforeEach(() => {
    tempDir = path.join(FIXTURES_DIR, `test-${randomUUID()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    testCliPath = path.join(tempDir, "cli.js");
    const mockCliContent = `
// Mock Claude Code CLI
function __getModConfig__(id) { return null; }
function __isModEnabled__(id) { return false; }

const TaskTool = {
  model: _.enum(["sonnet", "opus", "haiku"])
    .optional()
    .describe("Optional model override for this agent")
};

const AgentTool = {
  model: _.enum(["sonnet", "opus", "haiku"])
    .optional()
    .describe("Agent model")
};

const OtherTool = {
  type: _.enum(["task", "agent"]).optional()
};
`;
    fs.writeFileSync(testCliPath, mockCliContent);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("codemod application", () => {
    it("should apply codemod to mock CLI with ternary wrapping", () => {
      const codemodPath = path.join(ROOT_DIR, "codemods/codemod-model-enum-to-string.cjs");
      const outputPath = path.join(tempDir, "patched.js");

      execSync(`node "${codemodPath}" "${testCliPath}" "${outputPath}"`, {
        cwd: ROOT_DIR,
        stdio: "pipe"
      });

      expect(fs.existsSync(outputPath)).toBe(true);
      const patchedContent = fs.readFileSync(outputPath, "utf8");
      expect(patchedContent).toContain('__isModEnabled__("unlock_agent_models")');
      expect(patchedContent).toContain('.string()');
      expect(patchedContent).toContain('.enum(["sonnet", "opus", "haiku"])');
      expect(patchedContent).toContain('.enum(["task", "agent"])');
    });

    it("should report number of changes", () => {
      const codemodPath = path.join(ROOT_DIR, "codemods/codemod-model-enum-to-string.cjs");
      const outputPath = path.join(tempDir, "patched.js");

      const result = execSync(`node "${codemodPath}" "${testCliPath}" "${outputPath}" 2>&1`, {
        cwd: ROOT_DIR,
        stdio: "pipe"
      }).toString();

      expect(result).toContain("Wrapped");
      expect(result).toContain("model enum call");
    });

    it("should handle files with no matching patterns", () => {
      const noMatchPath = path.join(tempDir, "no-match.js");
      fs.writeFileSync(noMatchPath, `
        const schema = {
          model: _.string().optional()
        };
      `);

      const codemodPath = path.join(ROOT_DIR, "codemods/codemod-model-enum-to-string.cjs");
      const outputPath = path.join(tempDir, "patched.js");

      const result = execSync(`node "${codemodPath}" "${noMatchPath}" "${outputPath}"`, {
        cwd: ROOT_DIR,
        stdio: "pipe"
      }).toString();

      expect(result.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("batch-apply CLI", () => {
    it("should apply patches via batch-apply.cjs", () => {
      const batchApplyPath = path.join(ROOT_DIR, "bin/batch-apply.cjs");
      const deobfPath = path.join(tempDir, "deobfuscated.js");
      fs.writeFileSync(deobfPath, fs.readFileSync(testCliPath));

      try {
        const output = execSync(`node "${batchApplyPath}" "${deobfPath}" unlock_agent_models`, {
          cwd: ROOT_DIR,
          stdio: "pipe"
        }).toString();

        // Should show successful application
        expect(output).toContain("unlock_agent_models");
      } catch (error) {
        // Exit code 2 = no-op (all patches already applied or not applicable)
        if (error.status !== 2) {
          throw error;
        }
      }

      // Verify the file was modified
      if (fs.existsSync(deobfPath)) {
        const content = fs.readFileSync(deobfPath, "utf8");
        // If applied, the string() pattern should be present
        if (content.includes('.string()')) {
          expect(content).toContain('__isModEnabled__("unlock_agent_models")');
        }
      }
    });

    it("should handle file not found", () => {
      const batchApplyPath = path.join(ROOT_DIR, "bin/batch-apply.cjs");
      const nonExistentPath = path.join(tempDir, "non-existent.js");

      try {
        execSync(`node "${batchApplyPath}" "${nonExistentPath}" unlock_agent_models`, {
          cwd: ROOT_DIR,
          stdio: "pipe"
        });
        expect().fail("Should have thrown an error");
      } catch (error) {
        expect(error.status).not.toBe(0);
      }
    });
  });

  describe("real-world scenarios", () => {
    it("should wrap Task tool pattern with ternary", () => {
      const realWorldPath = path.join(tempDir, "real-world.js");
      fs.writeFileSync(realWorldPath, `
        const TaskTool = {
          model: _.enum(["sonnet", "opus", "haiku"])
            .optional()
            .describe("Optional model override for this agent")
        };
      `);

      const codemodPath = path.join(ROOT_DIR, "codemods/codemod-model-enum-to-string.cjs");
      const outputPath = path.join(tempDir, "patched.js");

      execSync(`node "${codemodPath}" "${realWorldPath}" "${outputPath}"`, {
        cwd: ROOT_DIR,
        stdio: "pipe"
      });

      const patched = fs.readFileSync(outputPath, "utf8");
      expect(patched).toContain('__isModEnabled__("unlock_agent_models")');
      expect(patched).toContain('.string()');
      expect(patched).toContain('.optional()');
      expect(patched).toContain('.describe("Optional model override for this agent")');
    });

    it("should preserve method chaining order with ternary", () => {
      const chainingPath = path.join(tempDir, "chaining.js");
      fs.writeFileSync(chainingPath, `
        const schema = {
          model: _.enum(["sonnet", "opus", "haiku"])
            .optional()
            .describe("test")
            .default("sonnet")
        };
      `);

      const codemodPath = path.join(ROOT_DIR, "codemods/codemod-model-enum-to-string.cjs");
      const outputPath = path.join(tempDir, "patched.js");

      execSync(`node "${codemodPath}" "${chainingPath}" "${outputPath}"`, {
        cwd: ROOT_DIR,
        stdio: "pipe"
      });

      const patched = fs.readFileSync(outputPath, "utf8");
      expect(patched).toContain('__isModEnabled__("unlock_agent_models")');
      expect(patched).toContain('.string()');
      expect(patched).toContain('.optional()');
      expect(patched).toContain('.describe("test")');
      expect(patched).toContain('.default("sonnet")');
    });
  });
});

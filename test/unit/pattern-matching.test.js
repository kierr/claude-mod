import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { patternExists, countMatches, patternExistsIn, countMatchesIn } from "../../lib/utils.cjs";

const FIXTURES_DIR = path.join(process.cwd(), "test/fixtures");

describe("Pattern Matching", () => {
  let testFilePath;

  beforeEach(() => {
    // Create a temporary test file
    testFilePath = path.join(FIXTURES_DIR, `test-${randomUUID()}.js`);
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  });

  afterEach(() => {
    // Clean up test file
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
  });

  describe("patternExists", () => {
    it("should return true when pattern exists", () => {
      const content = `
        const schema = {
          model: _.string().optional().describe("Optional model override")
        };
      `;
      fs.writeFileSync(testFilePath, content);

      const result = patternExists(testFilePath, 'model:\\s*\\w+\\.string\\(\\)');
      expect(result).toBe(true);
    });

    it("should return false when pattern does not exist", () => {
      const content = `
        const schema = {
          model: _.enum(["sonnet", "opus"]).optional()
        };
      `;
      fs.writeFileSync(testFilePath, content);

      const result = patternExists(testFilePath, 'model:\\\\s*\\\\w+\\\\.string\\\\(\\\\)');
      expect(result).toBe(false);
    });

    it("should handle complex regex patterns", () => {
      const content = `
        const TaskTool = {
          model: _.enum(["sonnet", "opus", "haiku"])
            .optional()
            .describe("Optional model override for this agent")
        };
      `;
      fs.writeFileSync(testFilePath, content);

      const pattern = 'model:\\s*\\w+\\.enum\\(\\[\\s*"sonnet"\\s*,\\s*"opus"\\s*,\\s*"haiku"\\s*\\]\\)';
      const result = patternExists(testFilePath, pattern);
      expect(result).toBe(true);
    });

    it("should return false for non-existent file", () => {
      const result = patternExists("/non/existent/file.js", 'pattern');
      expect(result).toBe(false);
    });

    it("should handle flexible whitespace", () => {
      const content = `
        const schema = {
          model:_.string().optional()
        };
      `;
      fs.writeFileSync(testFilePath, content);

      const result = patternExists(testFilePath, 'model:\\s*\\w+\\.string\\(\\)');
      expect(result).toBe(true);
    });
  });

  describe("countMatches", () => {
    it("should count single occurrence", () => {
      const content = `
        const schema = {
          model: _.string().optional()
        };
      `;
      fs.writeFileSync(testFilePath, content);

      const count = countMatches(testFilePath, 'model:\\s*\\w+\\.string\\(\\)');
      expect(count).toBe(1);
    });

    it("should count multiple occurrences", () => {
      const content = `
        const schema1 = {
          model: _.string().optional()
        };
        const schema2 = {
          model: _.string().optional()
        };
        const schema3 = {
          model: _.string().optional()
        };
      `;
      fs.writeFileSync(testFilePath, content);

      const count = countMatches(testFilePath, 'model:\\s*\\w+\\.string\\(\\)');
      expect(count).toBe(3);
    });

    it("should return 0 when no matches", () => {
      const content = `
        const schema = {
          model: _.enum(["a", "b", "c"]).optional()
        };
      `;
      fs.writeFileSync(testFilePath, content);

      const count = countMatches(testFilePath, 'model:\\s*\\w+\\.string\\(\\)');
      expect(count).toBe(0);
    });

    it("should return 0 for non-existent file", () => {
      const count = countMatches("/non/existent/file.js", 'pattern');
      expect(count).toBe(0);
    });

    it("should handle overlapping patterns correctly", () => {
      const content = `
        model: _.string().optional().describe("test")
      `;
      fs.writeFileSync(testFilePath, content);

      // Each method call is a separate pattern
      const stringCount = countMatches(testFilePath, '\\.string\\(\\)');
      const optionalCount = countMatches(testFilePath, '\\.optional\\(\\)');
      const describeCount = countMatches(testFilePath, '\\.describe\\(');

      expect(stringCount).toBe(1);
      expect(optionalCount).toBe(1);
      expect(describeCount).toBe(1);
    });
  });

  describe("real-world patterns", () => {
    it("should detect applied patch pattern", () => {
      const content = `
        const TaskTool = {
          model: _.string()
            .optional()
            .describe("Optional model override for this agent")
        };
      `;
      fs.writeFileSync(testFilePath, content);

      const appliedPattern = 'model:\\s*\\w+\\.string\\(\\)';
      const result = patternExists(testFilePath, appliedPattern);
      expect(result).toBe(true);

      const count = countMatches(testFilePath, appliedPattern);
      expect(count).toBe(1);
    });

    it("should detect applicable patch pattern", () => {
      const content = `
        const TaskTool = {
          model: _.enum(["sonnet", "opus", "haiku"])
            .optional()
            .describe("Optional model override for this agent")
        };
      `;
      fs.writeFileSync(testFilePath, content);

      const applicablePattern = 'model:\\s*\\w+\\.enum\\(\\[\\s*"sonnet"';
      const result = patternExists(testFilePath, applicablePattern);
      expect(result).toBe(true);

      const count = countMatches(testFilePath, applicablePattern);
      expect(count).toBe(1);
    });

    it("should distinguish between applied and applicable patterns", () => {
      const content = `
        const TaskTool = {
          model: _.string().optional().describe("Optional model override")
        };
      `;
      fs.writeFileSync(testFilePath, content);

      const appliedPattern = 'model:\\s*\\w+\\.string\\(\\)';
      const applicablePattern = 'model:\\s*\\w+\\.enum\\(\\["sonnet"';

      expect(patternExists(testFilePath, appliedPattern)).toBe(true);
      expect(patternExists(testFilePath, applicablePattern)).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("should handle empty file", () => {
      fs.writeFileSync(testFilePath, "");

      const count = countMatches(testFilePath, 'pattern');
      expect(count).toBe(0);
    });

    it("should handle special regex characters in pattern", () => {
      const content = `
        const test = "test[]{}";
      `;
      fs.writeFileSync(testFilePath, content);

      const count = countMatches(testFilePath, 'test\\[\\]\\{\\}');
      expect(count).toBe(1);
    });

    it("should handle multiline content", () => {
      const content = `
        const schema = {
          model:
            _.string()
              .optional()
              .describe("test")
        };
      `;
      fs.writeFileSync(testFilePath, content);

      const result = patternExists(testFilePath, 'model:\\s*\\w+\\.string\\(\\)');
      expect(result).toBe(true);
    });

    it("should handle unicode characters", () => {
      const content = `
        const schema = {
          model: _.string().describe("Test with emoji: 🎉")
        };
      `;
      fs.writeFileSync(testFilePath, content);

      const result = patternExists(testFilePath, 'model:\\s*\\w+\\.string\\(\\)');
      expect(result).toBe(true);
    });
  });

  describe("patternExistsIn", () => {
    it("should return true when pattern exists in string", () => {
      const content = 'const schema = { model: _.string().optional() };';
      const result = patternExistsIn(content, 'model:\\s*\\w+\\.string\\(\\)');
      expect(result).toBe(true);
    });

    it("should return false when pattern does not exist in string", () => {
      const content = 'const schema = { model: _.enum(["sonnet"]) };';
      const result = patternExistsIn(content, 'model:\\s*\\w+\\.string\\(\\)');
      expect(result).toBe(false);
    });

    it("should handle complex regex patterns", () => {
      const content = `
        const TaskTool = {
          model: _.enum(["sonnet", "opus", "haiku"])
            .optional()
            .describe("Optional model override for this agent")
        };
      `;
      const pattern = 'model:\\s*\\w+\\.enum\\(\\[\\s*"sonnet"\\s*,\\s*"opus"\\s*,\\s*"haiku"\\s*\\]\\)';
      const result = patternExistsIn(content, pattern);
      expect(result).toBe(true);
    });

    it("should handle empty string", () => {
      const result = patternExistsIn("", "pattern");
      expect(result).toBe(false);
    });
  });

  describe("countMatchesIn", () => {
    it("should count single occurrence", () => {
      const count = countMatchesIn("hello", "l");
      expect(count).toBe(2);
    });

    it("should count multiple occurrences", () => {
      const content = `
        const schema1 = {
          model: _.string().optional()
        };
        const schema2 = {
          model: _.string().optional()
        };
        const schema3 = {
          model: _.string().optional()
        };
      `;
      const count = countMatchesIn(content, 'model:\\s*\\w+\\.string\\(\\)');
      expect(count).toBe(3);
    });

    it("should return 0 when no matches", () => {
      const count = countMatchesIn("hello", "z");
      expect(count).toBe(0);
    });

    it("should handle empty string", () => {
      const count = countMatchesIn("", "pattern");
      expect(count).toBe(0);
    });
  });
});

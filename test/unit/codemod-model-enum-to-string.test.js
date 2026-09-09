import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-model-enum-to-string.cjs");

// Babel parsing in execSync is slow on CI runners — increase per-test timeout
// (bun:test default is 5000ms which is too tight for spawning Node + Babel).
const TIMEOUT = 30000;

describe("codemod-model-enum-to-string", () => {
  // Helper to run the codemod via CLI
  function runCodemod(inputCode, outputPath) {
    const tempInput = path.join(process.cwd(), "test/fixtures", `temp-input-${randomUUID()}.js`);
    const tempOutput = outputPath || path.join(process.cwd(), "test/fixtures", `temp-output-${randomUUID()}.js`);

    fs.mkdirSync(path.join(process.cwd(), "test/fixtures"), { recursive: true });
    fs.writeFileSync(tempInput, inputCode);

    try {
      const { execSync } = require("child_process");
      execSync(`node "${CODEMOD_PATH}" "${tempInput}" "${tempOutput}"`, {
        stdio: "pipe",
        cwd: process.cwd()
      });

      const output = fs.readFileSync(tempOutput, "utf8");

      // Cleanup
      fs.unlinkSync(tempInput);
      fs.unlinkSync(tempOutput);

      return output;
    } catch (error) {
      // Cleanup on error
      if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
      if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
      throw error;
    }
  }

  describe("enum detection", () => {
    it("should wrap enum with target models in ternary", { timeout: TIMEOUT }, () => {
      const input = `
        const schema = {
          model: _.enum(["sonnet", "opus", "haiku"])
            .optional()
            .describe("Optional model override")
        };
      `;

      const output = runCodemod(input);

      // Ternary wrapping present
      expect(output).toContain('__isModEnabled__("unlock_agent_models")');
      expect(output).toContain('.string()');
      // Enum is preserved as the fallback branch
      expect(output).toContain('.enum(["sonnet", "opus", "haiku"])');
    });

    it("should wrap enum with different receiver name h", { timeout: TIMEOUT }, () => {
      const input = `
        const schema = {
          model: h.enum(["sonnet", "opus", "haiku"])
            .optional()
            .describe("Optional model override")
        };
      `;

      const output = runCodemod(input);
      expect(output).toContain('__isModEnabled__("unlock_agent_models")');
      expect(output).toContain('h.string()');
      expect(output).toContain('h.enum(["sonnet", "opus", "haiku"])');
    });

    it("should wrap enum with extra models", { timeout: TIMEOUT }, () => {
      const input = `
        const schema = {
          model: _.enum(["sonnet", "opus", "haiku", "custom"])
            .optional()
        };
      `;

      const output = runCodemod(input);
      expect(output).toContain('__isModEnabled__("unlock_agent_models")');
      expect(output).toContain('.string()');
    });

    it("should NOT transform enum missing required models", { timeout: TIMEOUT }, () => {
      const input = `
        const schema = {
          model: _.enum(["sonnet", "opus"])
            .optional()
        };
      `;

      const output = runCodemod(input);
      expect(output).toContain('.enum([');
      expect(output).not.toContain('__isModEnabled__("unlock_agent_models")');
    });

    it("should NOT transform completely different enum", { timeout: TIMEOUT }, () => {
      const input = `
        const schema = {
          status: _.enum(["active", "inactive"])
        };
      `;

      const output = runCodemod(input);
      expect(output).toContain('.enum([');
      expect(output).not.toContain('__isModEnabled__("unlock_agent_models")');
    });
  });

  describe("property name filtering", () => {
    it("should only transform properties named 'model'", { timeout: TIMEOUT }, () => {
      const input = `
        const schema = {
          model: _.enum(["sonnet", "opus", "haiku"]).optional(),
          other: _.enum(["sonnet", "opus", "haiku"]).optional(),
        };
      `;

      const output = runCodemod(input);

      // model property has ternary wrapper
      expect(output).toContain('__isModEnabled__("unlock_agent_models")');
      // other property keeps its enum unchanged
      expect(output).toMatch(/other:\s*\w+\.enum\(\[/);
    });

    it("should handle string literal property names", { timeout: TIMEOUT }, () => {
      const input = `
        const schema = {
          "model": _.enum(["sonnet", "opus", "haiku"]).optional()
        };
      `;

      const output = runCodemod(input);
      expect(output).toContain('__isModEnabled__("unlock_agent_models")');
      expect(output).toContain('.string()');
    });

    it("should NOT transform non-model properties", { timeout: TIMEOUT }, () => {
      const input = `
        const schema = {
          tool: _.enum(["sonnet", "opus", "haiku"]).optional()
        };
      `;

      const output = runCodemod(input);
      expect(output).toContain('.enum([');
      expect(output).not.toContain('__isModEnabled__("unlock_agent_models")');
    });

    it("should NOT transform substring keys like submodel", { timeout: TIMEOUT }, () => {
      const input = `
        const schema = {
          submodel: _.enum(["sonnet", "opus", "haiku"]).optional()
        };
      `;

      const output = runCodemod(input);
      expect(output).toContain('.enum([');
      expect(output).not.toContain('__isModEnabled__("unlock_agent_models")');
      expect(output).not.toContain('.string()');
    });
  });

  describe("chaining preservation", () => {
    it("should preserve .optional() chaining", { timeout: TIMEOUT }, () => {
      const input = `
        const schema = {
          model: _.enum(["sonnet", "opus", "haiku"])
            .optional()
        };
      `;

      const output = runCodemod(input);
      expect(output).toContain('.optional()');
      expect(output).toContain('__isModEnabled__("unlock_agent_models")');
    });

    it("should preserve .describe() chaining", { timeout: TIMEOUT }, () => {
      const input = `
        const schema = {
          model: _.enum(["sonnet", "opus", "haiku"])
            .optional()
            .describe("Optional model override")
        };
      `;

      const output = runCodemod(input);
      expect(output).toContain('.optional()');
      expect(output).toContain('.describe("Optional model override")');
      expect(output).toContain('__isModEnabled__("unlock_agent_models")');
    });

    it("should preserve complex chaining", { timeout: TIMEOUT }, () => {
      const input = `
        const schema = {
          model: _.enum(["sonnet", "opus", "haiku"])
            .optional()
            .describe("Optional model override")
            .default("sonnet")
        };
      `;

      const output = runCodemod(input);
      expect(output).toContain('.string()');
      expect(output).toContain('.optional()');
      expect(output).toContain('.describe(');
      expect(output).toContain('.default(');
      expect(output).toContain('__isModEnabled__("unlock_agent_models")');
    });
  });

  describe("whitespace and formatting", () => {
    it("should handle flexible whitespace in enum arrays", { timeout: TIMEOUT }, () => {
      const input = `
        const schema = {
          model: _.enum([
            "sonnet",
            "opus",
            "haiku"
          ]).optional()
        };
      `;

      const output = runCodemod(input);
      expect(output).toContain('__isModEnabled__("unlock_agent_models")');
      expect(output).toContain('.string()');
    });

    it("should handle compact enum arrays", { timeout: TIMEOUT }, () => {
      const input = `
        const schema = {
          model: _.enum(["sonnet","opus","haiku"]).optional()
        };
      `;

      const output = runCodemod(input);
      expect(output).toContain('__isModEnabled__("unlock_agent_models")');
      expect(output).toContain('.string()');
    });
  });

  describe("multiple occurrences", () => {
    it("should wrap multiple model enum occurrences", { timeout: TIMEOUT }, () => {
      const input = `
        const schema1 = {
          model: _.enum(["sonnet", "opus", "haiku"]).optional()
        };
        const schema2 = {
          model: _.enum(["sonnet", "opus", "haiku"]).optional()
        };
      `;

      const output = runCodemod(input);

      // Count occurrences of __isModEnabled__
      const matches = output.match(/__isModEnabled__\("unlock_agent_models"\)/g);
      expect(matches && matches.length).toBeGreaterThanOrEqual(2);
    });

    it("should handle nested objects with model properties", { timeout: TIMEOUT }, () => {
      const input = `
        const config = {
          tools: {
            task: {
              model: _.enum(["sonnet", "opus", "haiku"]).optional()
            }
          }
        };
      `;

      const output = runCodemod(input);
      expect(output).toContain('__isModEnabled__("unlock_agent_models")');
      expect(output).toContain('.string()');
    });
  });

  describe("edge cases", () => {
    it("should handle empty schema", { timeout: TIMEOUT }, () => {
      const input = `
        const schema = {};
      `;

      const output = runCodemod(input);
      expect(output).not.toContain('__isModEnabled__("unlock_agent_models")');
    });

    it("should handle model property without enum", { timeout: TIMEOUT }, () => {
      const input = `
        const schema = {
          model: _.string().optional()
        };
      `;

      const output = runCodemod(input);
      // Should remain unchanged — no __isModEnabled__ wrapping
      expect(output).toContain('.string()');
      expect(output).not.toContain('__isModEnabled__("unlock_agent_models")');
    });
  });

  describe("real-world patterns", () => {
    it("should handle Task tool schema pattern", { timeout: TIMEOUT }, () => {
      const input = `
        const TaskTool = {
          model: _.enum(["sonnet", "opus", "haiku"])
            .optional()
            .describe("Optional model override for this agent")
        };
      `;

      const output = runCodemod(input);

      expect(output).toContain('__isModEnabled__("unlock_agent_models")');
      expect(output).toContain('.string()');
      expect(output).toContain('.optional()');
      expect(output).toContain('.describe("Optional model override for this agent")');
    });

    it("should handle multiple similar tools", { timeout: TIMEOUT }, () => {
      const input = `
        const TaskTool = {
          model: _.enum(["sonnet", "opus", "haiku"]).optional()
        };
        const AgentTool = {
          model: _.enum(["sonnet", "opus", "haiku"]).optional()
        };
        const OtherTool = {
          type: _.enum(["a", "b", "c"]).optional()
        };
      `;

      const output = runCodemod(input);

      // Count __isModEnabled__ occurrences for model properties
      const modMatches = output.match(/__isModEnabled__\("unlock_agent_models"\)/g);
      expect(modMatches && modMatches.length).toBeGreaterThanOrEqual(2);

      // OtherTool's enum should remain unchanged
      expect(output).toContain('type: _.enum(["a", "b", "c"])');
    });
  });
});

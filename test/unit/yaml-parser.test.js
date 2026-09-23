import { describe, it, expect } from "bun:test";
import { parseYAML } from "../../lib/utils.cjs";

describe("YAML Parser", () => {
  describe("basic parsing", () => {
    it("should parse simple key-value pairs", () => {
      const yaml = `
id: "test_patch"
name: "Test Patch"
description: "A test patch"
`;
      const result = parseYAML(yaml);

      expect(result.id).toBe("test_patch");
      expect(result.name).toBe("Test Patch");
      expect(result.description).toBe("A test patch");
    });

    it("should handle both single and double quotes", () => {
      const yaml = `
name: 'Single Quotes'
description: "Double Quotes"
`;
      const result = parseYAML(yaml);

      expect(result.name).toBe("Single Quotes");
      expect(result.description).toBe("Double Quotes");
    });

    it("should handle unquoted values", () => {
      const yaml = `
target: claude-code
file_id: cli
`;
      const result = parseYAML(yaml);

      expect(result.target).toBe("claude-code");
      expect(result.file_id).toBe("cli");
    });
  });

  describe("nested sections", () => {
    it("should parse status_tests section", () => {
      const yaml = `
status_tests:
  applied: 'some\\.pattern'
  applicable: 'another\\.pattern'
`;
      const result = parseYAML(yaml);

      expect(result.status_tests).toBeDefined();
      expect(result.status_tests.applied).toBe('some\\.pattern');
      expect(result.status_tests.applicable).toBe('another\\.pattern');
    });

    it("should parse codemod section", () => {
      const yaml = `
codemod:
  type: "node_script"
  script: "codemods/test.cjs"
`;
      const result = parseYAML(yaml);

      expect(result.codemod).toBeDefined();
      expect(result.codemod.type).toBe("node_script");
      expect(result.codemod.script).toBe("codemods/test.cjs");
    });

    it("should parse generic top-level arrays", () => {
      const yaml = `
some_list:
  - "item1"
  - "item2"
`;
      const result = parseYAML(yaml);

      expect(result.some_list).toBeDefined();
      expect(Array.isArray(result.some_list)).toBe(true);
      expect(result.some_list).toEqual(["item1", "item2"]);
    });

    it("should parse generic nested key-value sections", () => {
      const yaml = `
custom_section:
  key1: "value1"
  key2: "value2"
`;
      const result = parseYAML(yaml);

      expect(result.custom_section).toBeDefined();
      expect(result.custom_section.key1).toBe("value1");
      expect(result.custom_section.key2).toBe("value2");
    });
  });

  describe("comments and empty lines", () => {
    it("should ignore comment lines", () => {
      const yaml = `
# This is a comment
id: "test"
# Another comment
name: "Test"
`;
      const result = parseYAML(yaml);

      expect(result.id).toBe("test");
      expect(result.name).toBe("Test");
    });

    it("should ignore empty lines", () => {
      const yaml = `
id: "test"

name: "Test"


description: "Description"
`;
      const result = parseYAML(yaml);

      expect(result.id).toBe("test");
      expect(result.name).toBe("Test");
      expect(result.description).toBe("Description");
    });
  });

  describe("whitespace handling", () => {
    it("should normalize tabs to spaces", () => {
      const yaml = `
status_tests:
\tapplied: 'pattern'
`;
      const result = parseYAML(yaml);

      expect(result.status_tests.applied).toBe('pattern');
    });

    it("should handle extra spaces in values", () => {
      const yaml = `
name:  "Test"
description:  "Description"
`;
      const result = parseYAML(yaml);

      expect(result.name).toBe("Test");
      expect(result.description).toBe("Description");
    });
  });

  describe("special characters", () => {
    it("should handle regex patterns with escapes", () => {
      const yaml = `
status_tests:
  applied: 'model:\\\\s*\\\\w+\\\\.string\\\\(\\\\)'
  applicable: 'model:\\\\s*\\\\w+\\\\.enum'
`;
      const result = parseYAML(yaml);

      expect(result.status_tests.applied).toBe('model:\\\\s*\\\\w+\\\\.string\\\\(\\\\)');
      expect(result.status_tests.applicable).toBe('model:\\\\s*\\\\w+\\\\.enum');
    });

    it("should handle quotes inside quoted strings", () => {
      const yaml = `
description: "This has 'quotes' inside"
`;
      const result = parseYAML(yaml);

      expect(result.description).toBe("This has 'quotes' inside");
    });
  });

  describe("real-world patch files", () => {
    it("should parse unlock_agent_models.yaml", () => {
      const yaml = `
id: "unlock_agent_models"
target: "claude-code"
name: "Custom Models in Agent Tool"
description: "Allow any model name in the Agent tool and show provider models in the parameter description."
file_id: "cli"
order: 5

status_tests:
  applied: '__isModEnabled__\\(\\s*["\\x27]unlock_agent_models["\\x27]\\s*\\)'
  applicable: 'model:\\\\s*\\\\w+\\\\.enum\\\\(\\\\[\\\\s*"sonnet"\\\\s*,\\\\s*"opus"\\\\s*,\\\\s*"haiku"\\\\s*\\\\]\\\\)\\\\.optional\\\\(\\\\)\\\\.describe\\("Optional model override'

codemod:
  type: "node_script"
  engine: "regex"
  script: "codemods/codemod-unlock-agent-models.cjs"
`;
      const result = parseYAML(yaml);

      expect(result.id).toBe("unlock_agent_models");
      expect(result.target).toBe("claude-code");
      expect(result.name).toBe("Custom Models in Agent Tool");
      expect(result.order).toBe(5);
      expect(result.status_tests.applied).toContain('__isModEnabled__');
      expect(result.status_tests.applicable).toContain('model:');
      expect(result.codemod.type).toBe("node_script");
      expect(result.codemod.engine).toBe("regex");
      expect(result.codemod.script).toBe("codemods/codemod-unlock-agent-models.cjs");
    });
  });

  describe("edge cases", () => {
    it("should handle empty file", () => {
      const result = parseYAML("");
      expect(Object.keys(result).length).toBe(0);
    });

    it("should handle file with only comments", () => {
      const yaml = `
# Comment 1
# Comment 2
`;
      const result = parseYAML(yaml);
      expect(Object.keys(result).length).toBe(0);
    });

    it("should handle mixed quote styles", () => {
      const yaml = `
name: "Double"
description: 'Single'
target: unquoted
`;
      const result = parseYAML(yaml);

      expect(result.name).toBe("Double");
      expect(result.description).toBe("Single");
      expect(result.target).toBe("unquoted");
    });

    it("should handle colons inside quoted strings", () => {
      const yaml = `
description: "Time: 10:30 AM"
`;
      const result = parseYAML(yaml);

      expect(result.description).toBe("Time: 10:30 AM");
    });
  });

  describe("4-level nesting (sub-arrays within list items)", () => {
    it("should parse nested options arrays within config items", () => {
      const yaml = `
mod:
  live: true
  category: "features"
  config:
    - key: "select_field"
      type: "select"
      default: "granular"
      options:
        - value: "granular"
          label: "Granular"
        - value: "custom"
          label: "Custom text"
      label: "Mode"
    - key: "text_field"
      type: "string"
      default: ""
      label: "Text"
`;

      const result = parseYAML(yaml);
      const config = result.mod.config;

      // Two config items (not leaked sub-array items)
      expect(config.length).toBe(2);

      // First item has nested options
      expect(config[0].key).toBe("select_field");
      expect(config[0].type).toBe("select");
      expect(config[0].default).toBe("granular");
      expect(config[0].label).toBe("Mode");
      expect(Array.isArray(config[0].options)).toBe(true);
      expect(config[0].options.length).toBe(2);
      expect(config[0].options[0]).toEqual({ value: "granular", label: "Granular" });
      expect(config[0].options[1]).toEqual({ value: "custom", label: "Custom text" });

      // Second item is unaffected — default: "" stays as string, not corrupted to []
      expect(config[1].key).toBe("text_field");
      expect(config[1].type).toBe("string");
      expect(config[1].default).toBe("");
    });
  });
});

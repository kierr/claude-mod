import { describe, it, expect } from "bun:test";
import path from "path";

const parser = require(path.join(process.cwd(), "codemods/node_modules/@babel/parser"));

const { runCodemod, assertAppliedRegex, getApplicableRegex } = require("./test-helpers.cjs");

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-custom-model-descriptions.cjs");
const PATCH_ID = "unlock_agent_models";
const TIMEOUT = 30000;

const SHORT_TEXT = "Optional model override for this agent. Takes precedence over the agent definition's model frontmatter.";
// Exercise a template description with appended text and embedded quotes.
const REAL_218_TEXT = 'Optional model override for this agent. Takes precedence over the agent definition\'s model frontmatter. If omitted, uses the agent definition\'s model, or inherits from the parent. Ignored for subagent_type: "fork" \\u2014 forks always inherit the parent model.';

function buildFixture(opts = {}) {
  const { ident = "N", quote = '"', text = SHORT_TEXT, prefix = "", suffix = "" } = opts;
  return `${prefix}model: ${ident}.enum(["sonnet", "opus", "haiku"]).optional().describe(${quote}${text}${quote}),${suffix}`;
}

describe("codemod-custom-model-descriptions", () => {
  function run(inputCode) {
    return runCodemod(CODEMOD_PATH, inputCode);
  }

  describe("basic transformation", () => {
    it("should inject __isModEnabled__ guard with mod id", { timeout: TIMEOUT }, () => {
      const output = run(buildFixture());
      expect(output).toContain('__isModEnabled__("unlock_agent_models")');
    });

    it("should include typeof safety guard", { timeout: TIMEOUT }, () => {
      const output = run(buildFixture());
      expect(output).toContain('typeof __isModEnabled__ === "function"');
    });

    it("should preserve original describe text", { timeout: TIMEOUT }, () => {
      const output = run(buildFixture());
      expect(output).toContain(SHORT_TEXT);
    });

    it("should read models from __getModConfig__ (config-driven)", { timeout: TIMEOUT }, () => {
      const output = run(buildFixture());
      expect(output).toContain("typeof __getModConfig__ === \"function\"");
      expect(output).toContain('__getModConfig__("unlock_agent_models", "models", "")');
      expect(output).toContain("Available models: ");
    });

    it("must NOT use curl / execFileSync / network", { timeout: TIMEOUT }, () => {
      const output = run(buildFixture());
      expect(output).not.toContain("execFileSync");
      expect(output).not.toContain("curl");
      expect(output).not.toContain("/v1/models");
    });

    it("must NOT reference ANTHROPIC env vars or API keys", { timeout: TIMEOUT }, () => {
      const output = run(buildFixture());
      expect(output).not.toContain("ANTHROPIC_AUTH_TOKEN");
      expect(output).not.toContain("ANTHROPIC_API_KEY");
      expect(output).not.toContain("ANTHROPIC_BASE_URL");
    });
  });

  describe("quote tolerance (resilience to upstream quote drift)", () => {
    it("should match a double-quoted describe", { timeout: TIMEOUT }, () => {
      const output = run(buildFixture({ quote: '"' }));
      expect(output).toContain('__isModEnabled__("unlock_agent_models")');
      expect(output).toContain(SHORT_TEXT);
    });

    it("should match a single-quoted describe", { timeout: TIMEOUT }, () => {
      const output = run(buildFixture({ quote: "'" }));
      expect(output).toContain('__isModEnabled__("unlock_agent_models")');
    });

    it("should match a backtick template-literal describe (2.1.178+ shape)", { timeout: TIMEOUT }, () => {
      const output = run(buildFixture({ quote: "`", text: REAL_218_TEXT }));
      expect(output).toContain('__isModEnabled__("unlock_agent_models")');
      expect(output).toContain(REAL_218_TEXT);
      // The original backtick quote is preserved in the output.
      expect(output).toContain("`" + REAL_218_TEXT + "`");
    });
  });

  describe("minified name resilience", () => {
    // The codemod anchors on the describe string, so the identifier preceding
    // .enum() must not affect matching.
    for (const ident of ["z", "K", "sm1", "ZI", "longIdentifier"]) {
      it(`should work with identifier "${ident}"`, { timeout: TIMEOUT }, () => {
        const output = run(buildFixture({ ident }));
        expect(output).toContain('__isModEnabled__("unlock_agent_models")');
        expect(output).toContain(SHORT_TEXT);
      });
    }
  });

  describe("idempotency", () => {
    it("should not double-inject on second run", { timeout: TIMEOUT }, () => {
      const once = run(buildFixture());
      const twice = run(once);
      const onceCount = (once.match(/__isModEnabled__/g) || []).length;
      const twiceCount = (twice.match(/__isModEnabled__/g) || []).length;
      expect(twiceCount).toBe(onceCount);
    });

    it("should produce stable output across repeated runs", { timeout: TIMEOUT }, () => {
      const once = run(buildFixture());
      const twice = run(once);
      expect(once).toBe(twice);
    });
  });

  describe("no-match cases", () => {
    it("should not transform unrelated describe calls", { timeout: TIMEOUT }, () => {
      const input = `const x = schema.describe("Something else entirely");`;
      const output = run(input);
      expect(output).not.toContain("unlock_agent_models");
      expect(output).toBe(input);
    });

    it("should not transform empty code", { timeout: TIMEOUT }, () => {
      const output = run("");
      expect(output).toBe("");
    });

    it("should not transform partial describe text", { timeout: TIMEOUT }, () => {
      const input = `.describe("Optional model override for something else")`;
      const output = run(input);
      expect(output).not.toContain("unlock_agent_models");
    });

    it("should not transform a multi-line describe (fail-safe, no over-match)", { timeout: TIMEOUT }, () => {
      // The anchor is same-line-bounded ([^\n]*?); a multi-line literal must NOT
      // match (and must NOT over-match across lines). This guards against the
      // [\s\S]*? catastrophic-overmatch class.
      const input = `.describe("Optional model override for this agent\nsecond line")`;
      const output = run(input);
      expect(output).not.toContain("unlock_agent_models");
      expect(output).toBe(input);
    });
  });

  describe("structural integrity", () => {
    it("should produce syntactically valid JS (double-quote)", { timeout: TIMEOUT }, () => {
      const input = buildFixture({
        prefix: "const tool = {\n  ",
        suffix: "\n  other: true\n};",
      });
      const output = run(input);
      try {
        parser.parse(output, { sourceType: "module" });
      } catch (e) {
        throw new Error(`Output is not valid JS: ${e.message}\n${output}`);
      }
    });

    it("should produce syntactically valid JS (backtick, 2.1.178 shape)", { timeout: TIMEOUT }, () => {
      const input = buildFixture({
        quote: "`",
        text: REAL_218_TEXT,
        prefix: "const tool = {\n  ",
        suffix: "\n  other: true\n};",
      });
      const output = run(input);
      try {
        parser.parse(output, { sourceType: "module" });
      } catch (e) {
        throw new Error(`Output is not valid JS: ${e.message}\n${output}`);
      }
    });
  });

  describe("YAML status_test regexes", () => {
    it("applied regex should match codemod output", { timeout: TIMEOUT }, () => {
      const output = run(buildFixture());
      assertAppliedRegex(PATCH_ID, output);
    });

    it("applicable regex should match unpatched input (enum + .optional, describe-independent)", { timeout: TIMEOUT }, () => {
      // The applicable regex anchors on the model enum + .optional() shape and
      // must NOT depend on the describe text/quote (that dependency is what made
      // the patch silently not-applicable on 2.1.178). Verify it matches a
      // backtick-describe fixture — the case that previously broke.
      const input = buildFixture({ quote: "`", text: REAL_218_TEXT });
      const regex = getApplicableRegex(PATCH_ID);
      expect(regex).not.toBeNull();
      expect(regex.test(input)).toBe(true);
    });
  });
});

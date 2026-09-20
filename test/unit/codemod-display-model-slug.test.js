import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const { getAppliedRegex, getApplicableRegex } = require("./test-helpers.cjs");

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-display-model-slug.cjs");

// Babel parsing in execSync is slow on CI runners — increase per-test timeout
// (bun:test default is 5000ms which is too tight for spawning Node + Babel).
const TIMEOUT = 30000;

// Full slug resolver fixture — switch-in-function form (older versions)
const SLUG_RESOLVER_FIXTURE = `
function slugResolver(model) {
  switch (model) {
    case "opus": return "claude-opus-4-6";
    case "sonnet": return "claude-sonnet-4-6";
    case "haiku": return "claude-haiku-4-5";
    default: return model;
  }
}`;

// Object literal slug map fixture (2.1.97+ form)
const OBJECT_SLUG_MAP_FIXTURE = `
const eO7 = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001"
};`;

// A description-returning function with same switch cases — should NOT match as slug resolver
const DESCRIPTION_RESOLVER_FIXTURE = `
function $5(model) {
  switch (model) {
    case "opus": return "Opus 4.6 · Most capable for complex work";
    case "sonnet": return "Sonnet 4.6 · Best for everyday tasks";
    case "haiku": return "Haiku 4.5 · Fast and affordable";
    default: return model;
  }
}`;

describe("codemod-display-model-slug", () => {
  function runCodemod(inputCode) {
    const tempInput = path.join(process.cwd(), "test/fixtures", `temp-input-${randomUUID()}.js`);
    const tempOutput = path.join(process.cwd(), "test/fixtures", `temp-output-${randomUUID()}.js`);

    fs.mkdirSync(path.join(process.cwd(), "test/fixtures"), { recursive: true });
    fs.writeFileSync(tempInput, inputCode);

    // Safe cleanup that won't mask test errors
    function cleanup() {
      for (const p of [tempInput, tempOutput]) {
        try { fs.rmSync(p, { force: true }); } catch { /* ignore cleanup failure */ }
      }
    }

    try {
      const { execSync } = require("child_process");
      execSync(`node "${CODEMOD_PATH}" "${tempInput}" "${tempOutput}"`, {
        stdio: "pipe",
        cwd: process.cwd()
      });

      const output = fs.readFileSync(tempOutput, "utf8");

      cleanup();
      return output;
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  // Object literal form (2.1.97+)

  describe("object literal slug map detection", () => {
    it("finds object literal slug map", { timeout: TIMEOUT }, () => {
      const input = OBJECT_SLUG_MAP_FIXTURE + `
        const items = [
          { label: "Sonnet", description: \`Sonnet 4.6 · Best \${cost()}\` },
          { label: "Opus", description: \`Opus 4.6 · Most capable \${cost()}\` },
          { label: "Haiku", description: "Haiku 4.5 · Fast" },
        ];
      `;
      expect(() => runCodemod(input)).not.toThrow();
    });

    it("uses computed member access for object form", { timeout: TIMEOUT }, () => {
      const input = OBJECT_SLUG_MAP_FIXTURE + `
        const items = [
          { label: "Sonnet", description: \`Sonnet 4.6 · Best \${cost()}\` },
          { label: "Opus", description: \`Opus 4.6 · Most \${cost()}\` },
          { label: "Haiku", description: "Haiku 4.5 · Fast" },
        ];
      `;
      const output = runCodemod(input);
      // Object form emits eO7?.["sonnet"] — optional computed member access
      expect(output).toContain("eO7?.[\"sonnet\"]");
      expect(output).toContain("eO7?.[\"opus\"]");
      expect(output).toContain("eO7?.[\"haiku\"]");
      // The ?? "" fallback prevents " (undefined)" when the slug map hasn't been
      // lazily initialized yet. A regression dropping it would still pass the
      // optional chaining assertions above.
      expect(output).toContain("?? \"\"");
    });

    it("finds object literal with $-prefixed name", { timeout: TIMEOUT }, () => {
      const fixture = `
const $map = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5"
};`;
      const input = fixture + `
        const items = [
          { label: "Sonnet", description: \`Sonnet 4.6 · Best \${cost()}\` },
          { label: "Opus", description: \`Opus 4.6 · Most \${cost()}\` },
          { label: "Haiku", description: "Haiku 4.5 · Fast" },
        ];
      `;
      const output = runCodemod(input);
      expect(output).toContain("$map?.[\"sonnet\"]");
      expect(output).toContain('__isModEnabled__("display_model_slug")');
      expect(output).toContain("$map?.[\"opus\"]");
      expect(output).toContain("$map?.[\"haiku\"]");
    });

    it("rejects object literal slug map inside nested function scope", { timeout: TIMEOUT }, () => {
      const input = `
// Nested inside a function — should NOT match
function wrapper() {
  const nestedMap = {
    opus: "claude-opus-4-6",
    sonnet: "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5"
  };
  return nestedMap;
}
// Program-level slug map — should match this one
const eO7 = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001"
};
const items = [
  { label: "Sonnet", description: \`Sonnet 4.6 · Best \${cost()}\` },
  { label: "Opus", description: \`Opus 4.6 · Most \${cost()}\` },
  { label: "Haiku", description: "Haiku 4.5 · Fast" },
];
`;
      const output = runCodemod(input);
      // Should use the program-level eO7, not the nested nestedMap
      expect(output).toContain("eO7?.[\"sonnet\"]");
      expect(output).not.toContain("nestedMap[");
      expect(output).not.toContain("nestedMap?.[");
    });
  });

  // Switch-in-function form (older versions)

  describe("switch slug resolver detection", () => {
    it("finds slug resolver by switch cases", { timeout: TIMEOUT }, () => {
      const input = SLUG_RESOLVER_FIXTURE + `
        const items = [
          { label: "Sonnet", description: \`Sonnet 4.6 · Best \${cost()}\` },
          { label: "Opus", description: \`Opus 4.6 · Most capable \${cost()}\` },
          { label: "Haiku", description: "Haiku 4.5 · Fast" },
        ];
      `;
      // Should not throw - finds resolver correctly
      expect(() => runCodemod(input)).not.toThrow();
    });

    it("throws when slug resolver not found", { timeout: TIMEOUT }, () => {
      const input = `
        const items = [
          { label: "Sonnet", description: \`Sonnet 4.6 · Best \${cost()}\` },
          { label: "Opus", description: \`Opus 4.6 · Most capable \${cost()}\` },
          { label: "Haiku", description: "Haiku 4.5 · Fast" },
        ];
      `;
      // Should throw because there's no slug map or resolver
      expect(() => runCodemod(input)).toThrow(/Could not find slug resolver/);
    });

    it("finds slug resolver with minified name", { timeout: TIMEOUT }, () => {
      const minifiedFixture = `
function z(a) {
  switch (a) {
    case "opus": return "claude-opus-4-6";
    case "sonnet": return "claude-sonnet-4-6";
    case "haiku": return "claude-haiku-4-5";
    default: return a;
  }
}`;
      const input = minifiedFixture + `
        const items = [
          { label: "Sonnet", description: \`Sonnet 4.6 · Best \${cost()}\` },
          { label: "Opus", description: \`Opus 4.6 · Most \${cost()}\` },
          { label: "Haiku", description: "Haiku 4.5 · Fast" },
        ];
      `;
      const output = runCodemod(input);
      // The injected calls should reference the minified binding, not slugResolver
      expect(output).toContain("z(");
      expect(output).toContain('__isModEnabled__("display_model_slug")');
    });

    it("rejects description-returning switch as slug resolver", { timeout: TIMEOUT }, () => {
      // $5() returns display descriptions, not API slugs — should be rejected
      const input = DESCRIPTION_RESOLVER_FIXTURE + `
        const items = [
          { label: "Sonnet", description: \`Sonnet 4.6 · Best \${cost()}\` },
          { label: "Opus", description: \`Opus 4.6 · Most \${cost()}\` },
          { label: "Haiku", description: "Haiku 4.5 · Fast" },
        ];
      `;
      // Should throw because the only switch returns descriptions, not slugs
      expect(() => runCodemod(input)).toThrow(/Could not find slug resolver/);
    });

    it("handles default case returning string literal without crashing", { timeout: TIMEOUT }, () => {
      // default: case has c.test === null — must not throw TypeError
      const fixture = `
function resolve(model) {
  switch (model) {
    case "opus": return "claude-opus-4-6";
    case "sonnet": return "claude-sonnet-4-6";
    case "haiku": return "claude-haiku-4-5";
    default: return "claude-sonnet-4-6";
  }
}`;
      const input = fixture + `
        const items = [
          { label: "Sonnet", description: "Sonnet 4.6 · Best for everyday tasks" },
          { label: "Opus", description: \`Opus 4.6 · Most \${cost()}\` },
          { label: "Haiku", description: "Haiku 4.5 · Fast" },
        ];
      `;
      const output = runCodemod(input);
      expect(output).toBeDefined();
      expect(output).toContain('__isModEnabled__("display_model_slug")');
    });

    it("rejects switch resolver inside nested function scope", { timeout: TIMEOUT }, () => {
      const input = `
// Nested inside a function — should NOT match
function outer() {
  function nestedResolver(model) {
    switch (model) {
      case "opus": return "claude-opus-4-6";
      case "sonnet": return "claude-sonnet-4-6";
      case "haiku": return "claude-haiku-4-5";
      default: return model;
    }
  }
  return nestedResolver;
}
// Program-level resolver — should match this one
function slugResolver(model) {
  switch (model) {
    case "opus": return "claude-opus-4-6";
    case "sonnet": return "claude-sonnet-4-6";
    case "haiku": return "claude-haiku-4-5";
    default: return model;
  }
}
const items = [
  { label: "Sonnet", description: \`Sonnet 4.6 · Best \${cost()}\` },
  { label: "Opus", description: \`Opus 4.6 · Most \${cost()}\` },
  { label: "Haiku", description: "Haiku 4.5 · Fast" },
];
`;
      const output = runCodemod(input);
      // Should use the program-level slugResolver, not the nested one
      // Check the generated descriptions specifically (source definitions also contain the name)
      expect(output).toMatch(/description:.*slugResolver\("sonnet"\)/);
      expect(output).not.toMatch(/description:.*nestedResolver\(/);
    });
  });

  // Object literal preferred over switch

  describe("resolver priority", () => {
    it("prefers object literal when both exist", { timeout: TIMEOUT }, () => {
      const input = OBJECT_SLUG_MAP_FIXTURE + SLUG_RESOLVER_FIXTURE + `
        const items = [
          { label: "Sonnet", description: \`Sonnet 4.6 · Best \${cost()}\` },
          { label: "Opus", description: \`Opus 4.6 · Most \${cost()}\` },
          { label: "Haiku", description: "Haiku 4.5 · Fast" },
        ];
      `;
      const output = runCodemod(input);
      // Should use object form (member access) in the generated descriptions
      expect(output).toContain("eO7?.[\"sonnet\"]");
      // The function definition is still in the output, but descriptions should
      // not contain calls to slugResolver — only member access on eO7
      expect(output).not.toContain("slugResolver(\"sonnet\")");
      expect(output).not.toContain("slugResolver(\"opus\")");
      expect(output).not.toContain("slugResolver(\"haiku\")");
    });
  });

  describe("template literal transformation", () => {
    it("transforms sonnet template literal with single expression", { timeout: TIMEOUT }, () => {
      const input = SLUG_RESOLVER_FIXTURE + `
        const items = [
          { label: "Sonnet", description: \`Sonnet 4.6 · Best for everyday \${cost()}\` },
          { label: "Opus", description: \`Opus 4.6 · Most capable \${cost()}\` },
          { label: "Haiku", description: "Haiku 4.5 · Fast" },
        ];
      `;
      const output = runCodemod(input);
      // Check that slug call is present in the sonnet description
      expect(output).toContain("slugResolver");
      expect(output).toContain('__isModEnabled__("display_model_slug")');
      expect(output).toContain("${cost()}");
    });

    it("transforms opus template literal with multiple expressions", { timeout: TIMEOUT }, () => {
      const input = SLUG_RESOLVER_FIXTURE + `
        const items = [
          { label: "Sonnet", description: \`Sonnet 4.6 · Best \${cost()}\` },
          { label: "Opus", description: \`Opus 4.6 · Most capable \${cost()} per \${token()}\` },
          { label: "Haiku", description: "Haiku 4.5 · Fast" },
        ];
      `;
      const output = runCodemod(input);
      // Check that slug call is present
      expect(output).toContain("slugResolver");
      expect(output).toContain('__isModEnabled__("display_model_slug")');
      expect(output).toContain("${cost()}");
      expect(output).toContain("${token()}");
    });

    it("transforms haiku template literal", { timeout: TIMEOUT }, () => {
      const input = SLUG_RESOLVER_FIXTURE + `
        const items = [
          { label: "Sonnet", description: \`Sonnet 4.6 · Best \${cost()}\` },
          { label: "Opus", description: \`Opus 4.6 · Most capable \${cost()}\` },
          { label: "Haiku", description: \`Haiku 4.5 · Fast \${speed()}\` },
        ];
      `;
      const output = runCodemod(input);
      expect(output).toContain("slugResolver");
      expect(output).toContain('__isModEnabled__("display_model_slug")');
      expect(output).toContain("${speed()}");
    });

    it("does not transform non-matching template literals", { timeout: TIMEOUT }, () => {
      const input = SLUG_RESOLVER_FIXTURE + `
        const items = [
          { label: "Custom", description: \`Custom model · Some description \${cost()}\` },
          { label: "Sonnet", description: \`Sonnet 4.6 · Best \${cost()}\` },
          { label: "Opus", description: \`Opus 4.6 · Most capable \${cost()}\` },
          { label: "Haiku", description: "Haiku 4.5 · Fast" },
        ];
      `;
      const output = runCodemod(input);
      // Custom model should not be transformed
      expect(output).not.toContain("Custom model · (slugResolver");
      expect(output).toContain("Custom model · Some description");
    });

    it("does not transform already-transformed descriptions", { timeout: TIMEOUT }, () => {
      const input = SLUG_RESOLVER_FIXTURE + `
        const items = [
          { label: "Sonnet", description: \`Sonnet 4.6 (slugResolver(\"sonnet\")) · Already transformed \${cost()}\` },
          { label: "Opus", description: \`Opus 4.6 · Most capable \${cost()}\` },
          { label: "Haiku", description: "Haiku 4.5 · Fast" },
          { label: "Sonnet2", description: \`Sonnet 4.6 · Extra item \${cost()}\` },
        ];
      `;
      // Should not throw - already transformed (prefix check prevents re-transform)
      expect(() => runCodemod(input)).not.toThrow();
    });
  });

  describe("string literal transformation", () => {
    it("transforms haiku string literal", { timeout: TIMEOUT }, () => {
      const input = SLUG_RESOLVER_FIXTURE + `
        const items = [
          { label: "Sonnet", description: \`Sonnet 4.6 · Best \${cost()}\` },
          { label: "Opus", description: \`Opus 4.6 · Most capable \${cost()}\` },
          { label: "Haiku", description: "Haiku 4.5 · Fast and affordable" },
        ];
      `;
      const output = runCodemod(input);
      expect(output).toContain("slugResolver");
      expect(output).toContain('__isModEnabled__("display_model_slug")');
      expect(output).toContain("Fast and affordable");
      // Should be a template literal now
      expect(output).toContain("`");
    });

    it("transforms sonnet string literal", { timeout: TIMEOUT }, () => {
      const input = SLUG_RESOLVER_FIXTURE + `
        const items = [
          { label: "Sonnet", description: "Sonnet 4.6 · Best for everyday tasks" },
          { label: "Opus", description: \`Opus 4.6 · Most capable \${cost()}\` },
          { label: "Haiku", description: "Haiku 4.5 · Fast" },
        ];
      `;
      const output = runCodemod(input);
      expect(output).toContain("slugResolver");
      expect(output).toContain('__isModEnabled__("display_model_slug")');
      expect(output).toContain("Best for everyday tasks");
    });

    it("does not transform non-matching string literals", { timeout: TIMEOUT }, () => {
      const input = SLUG_RESOLVER_FIXTURE + `
        const items = [
          { label: "Custom", description: "Custom model · Some description" },
          { label: "Sonnet", description: \`Sonnet 4.6 · Best \${cost()}\` },
          { label: "Opus", description: \`Opus 4.6 · Most capable \${cost()}\` },
          { label: "Haiku", description: "Haiku 4.5 · Fast" },
        ];
      `;
      const output = runCodemod(input);
      // Custom model should not be transformed
      expect(output).not.toContain("Custom model · (slugResolver");
      expect(output).toContain("Custom model · Some description");
    });
  });

  describe("all model types", () => {
    it("transforms all three model types together", { timeout: TIMEOUT }, () => {
      const input = SLUG_RESOLVER_FIXTURE + `
        const items = [
          { label: "Sonnet", description: \`Sonnet 4.6 · Best \${cost()}\` },
          { label: "Opus", description: \`Opus 4.6 · Most capable \${cost()}\` },
          { label: "Haiku", description: "Haiku 4.5 · Fast" },
        ];
      `;
      const output = runCodemod(input);
      // Check mod guard is present — slug display is conditional on mod being enabled
      expect(output).toContain('__isModEnabled__("display_model_slug")');
      // All three slug resolver calls should be present
      expect(output).toContain('slugResolver("sonnet")');
      expect(output).toContain('slugResolver("opus")');
      expect(output).toContain('slugResolver("haiku")');
    });

    it("succeeds with partial transforms (warns instead of throwing)", { timeout: TIMEOUT }, () => {
      const input = SLUG_RESOLVER_FIXTURE + `
        const items = [
          { label: "Sonnet", description: \`Sonnet 4.6 · Best \${cost()}\` },
          { label: "Opus", description: \`Opus 4.6 · Most capable \${cost()}\` },
          // Missing Haiku
        ];
      `;
      // Should NOT throw — partial success is allowed for reruns on partially-patched code
      const output = runCodemod(input);
      expect(output).toContain('__isModEnabled__("display_model_slug")');
      expect(output).toContain('slugResolver("sonnet")');
      expect(output).toContain('slugResolver("opus")');
    });

    it("succeeds with partial transforms in CJS wrapper bundle", { timeout: TIMEOUT }, () => {
      const input = `
(function(require, module, exports) {
  function slugResolver(model) {
    switch (model) {
      case "opus": return "claude-opus-4-6";
      case "sonnet": return "claude-sonnet-4-6";
      case "haiku": return "claude-haiku-4-5";
      default: return model;
    }
  }
  const items = [
    { label: "Sonnet", description: \`Sonnet 4.6 · Best \${cost()}\` },
    { label: "Opus", description: \`Opus 4.6 · Most capable \${cost()}\` },
    // Missing Haiku — partial run inside CJS wrapper
  ];
});
`;
      const output = runCodemod(input);
      expect(output).toContain('__isModEnabled__("display_model_slug")');
      expect(output).toContain('slugResolver("sonnet")');
      expect(output).toContain('slugResolver("opus")');
    });

    it("succeeds with partial transforms using AssignmentExpression slug map", { timeout: TIMEOUT }, () => {
      const input = `
var vP8;
(function() {
  vP8 = {
    opus: "claude-opus-4-7",
    sonnet: "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5"
  };
})();
const items = [
  { label: "Sonnet", description: \`Sonnet 4.6 · Best \${cost()}\` },
  // Missing Opus and Haiku — partial run with lazy-init slug map
];
`;
      const output = runCodemod(input);
      expect(output).toContain('__isModEnabled__("display_model_slug")');
      expect(output).toContain('vP8?.["sonnet"]');
    });

    it("succeeds with Opus 4.7 description in partial transform", { timeout: TIMEOUT }, () => {
      const input = OBJECT_SLUG_MAP_FIXTURE + `
        const items = [
          { label: "Opus", description: \`Opus 4.7 · Most capable \${cost()}\` },
          // Missing Sonnet and Haiku — partial run targeting only Opus 4.7
        ];
      `;
      const output = runCodemod(input);
      expect(output).toContain('__isModEnabled__("display_model_slug")');
      expect(output).toContain('eO7?.["opus"]');
    });
  });

  describe("property name filtering", () => {
    it("only transforms properties named 'description'", { timeout: TIMEOUT }, () => {
      const input = SLUG_RESOLVER_FIXTURE + `
        const item = {
          description: \`Sonnet 4.6 · Best \${cost()}\`,
          label: "Sonnet 4.6 · Should not transform",
        };
        const items2 = [
          { label: "Opus", description: \`Opus 4.6 · Most capable \${cost()}\` },
          { label: "Haiku", description: "Haiku 4.5 · Fast" },
        ];
      `;
      const output = runCodemod(input);
      expect(output).toContain("slugResolver");
      // Label should not be transformed
      expect(output).toContain("Sonnet 4.6 · Should not transform");
      expect(output).not.toContain("label: `Sonnet 4.6 · (slugResolver");
    });
  });

  describe("idempotency", () => {
    it("is safe to run twice on same input", { timeout: TIMEOUT }, () => {
      const input = SLUG_RESOLVER_FIXTURE + `
        const items = [
          { label: "Sonnet", description: \`Sonnet 4.6 · Best \${cost()}\` },
          { label: "Opus", description: \`Opus 4.6 · Most capable \${cost()}\` },
          { label: "Haiku", description: "Haiku 4.5 · Fast" },
          { label: "Sonnet2", description: \`Sonnet 4.6 · Extra \${cost()}\` },
        ];
      `;
      // First run
      const output1 = runCodemod(input);
      expect(output1).toContain('__isModEnabled__("display_model_slug")');

      // Second run on already-transformed code is a no-op (exits 0, no changes)
      // and does not modify the code — output remains identical
      const output2 = runCodemod(output1);
      expect(output2).toBe(output1);
      expect(output2).toContain('__isModEnabled__("display_model_slug")');
    });
  });

  describe("applied regex round-trip", () => {
    // Load regexes directly from YAML to catch codemod/regex drift
    const appliedRegex = getAppliedRegex("display_model_slug");
    const applicableRegex = getApplicableRegex("display_model_slug");

    it("matches function-call form output", { timeout: TIMEOUT }, () => {
      const input = SLUG_RESOLVER_FIXTURE + `
        const items = [
          { label: "Sonnet", description: "Sonnet 4.6 · Best for everyday tasks" },
          { label: "Opus", description: \`Opus 4.6 · Most \${cost()}\` },
          { label: "Haiku", description: "Haiku 4.5 · Fast" },
        ];
      `;
      const output = runCodemod(input);
      expect(appliedRegex.test(output)).toBe(true);
      expect(applicableRegex.test(output)).toBe(true); // broadened for code-split
    });

    it("matches object-member form output", { timeout: TIMEOUT }, () => {
      const input = OBJECT_SLUG_MAP_FIXTURE + `
        const items = [
          { label: "Sonnet", description: "Sonnet 4.6 · Best for everyday tasks" },
          { label: "Opus", description: \`Opus 4.6 · Most \${cost()}\` },
          { label: "Haiku", description: "Haiku 4.5 · Fast" },
        ];
      `;
      const output = runCodemod(input);
      expect(appliedRegex.test(output)).toBe(true);
      expect(applicableRegex.test(output)).toBe(true); // broadened for code-split
    });

    it("matches $-prefixed function name output", { timeout: TIMEOUT }, () => {
      const fixture = `
function $5(a) {
  switch (a) {
    case "opus": return "claude-opus-4-6";
    case "sonnet": return "claude-sonnet-4-6";
    case "haiku": return "claude-haiku-4-5";
    default: return a;
  }
}`;
      const input = fixture + `
        const items = [
          { label: "Sonnet", description: "Sonnet 4.6 · Best for everyday tasks" },
          { label: "Opus", description: \`Opus 4.6 · Most \${cost()}\` },
          { label: "Haiku", description: "Haiku 4.5 · Fast" },
        ];
      `;
      const output = runCodemod(input);
      expect(appliedRegex.test(output)).toBe(true);
      expect(applicableRegex.test(output)).toBe(true); // broadened for code-split
    });

    it("matches $-prefixed object name output", { timeout: TIMEOUT }, () => {
      const fixture = `
const $map = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5"
};`;
      const input = fixture + `
        const items = [
          { label: "Sonnet", description: "Sonnet 4.6 · Best for everyday tasks" },
          { label: "Opus", description: \`Opus 4.6 · Most \${cost()}\` },
          { label: "Haiku", description: "Haiku 4.5 · Fast" },
        ];
      `;
      const output = runCodemod(input);
      expect(appliedRegex.test(output)).toBe(true);
      expect(applicableRegex.test(output)).toBe(true); // broadened for code-split
    });
  });

  // CJS wrapper bundle (native binary, >= 2.1.113)

  describe("CJS wrapper bundle detection", () => {
    // CJS wrapper: the entire module is wrapped in (function(require, module, exports) { ... })
    const CJS_WRAPPER_SLUG_MAP = `
(function(require, module, exports) {
  const eO7 = {
    opus: "claude-opus-4-6",
    sonnet: "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5"
  };
  const items = [
    { label: "Sonnet", description: \`Sonnet 4.6 · Best \${cost()}\` },
    { label: "Opus", description: \`Opus 4.6 · Most capable \${cost()}\` },
    { label: "Haiku", description: "Haiku 4.5 · Fast" },
  ];
});
`;

    it("finds object literal slug map inside CJS wrapper", { timeout: TIMEOUT }, () => {
      const output = runCodemod(CJS_WRAPPER_SLUG_MAP);
      expect(output).toContain("eO7?.[\"sonnet\"]");
      expect(output).toContain("eO7?.[\"opus\"]");
      expect(output).toContain("eO7?.[\"haiku\"]");
      expect(output).toContain('__isModEnabled__("display_model_slug")');
    });

    it("finds switch resolver inside CJS wrapper", { timeout: TIMEOUT }, () => {
      const input = `
(function(require, module, exports) {
  function slugResolver(model) {
    switch (model) {
      case "opus": return "claude-opus-4-6";
      case "sonnet": return "claude-sonnet-4-6";
      case "haiku": return "claude-haiku-4-5";
      default: return model;
    }
  }
  const items = [
    { label: "Sonnet", description: \`Sonnet 4.6 · Best \${cost()}\` },
    { label: "Opus", description: \`Opus 4.6 · Most capable \${cost()}\` },
    { label: "Haiku", description: "Haiku 4.5 · Fast" },
  ];
});
`;
      const output = runCodemod(input);
      expect(output).toContain("slugResolver(\"sonnet\")");
      expect(output).toContain("slugResolver(\"opus\")");
      expect(output).toContain("slugResolver(\"haiku\")");
    });
  });

  // AssignmentExpression slug map (lazy init)

  describe("AssignmentExpression slug map detection", () => {
    it("finds slug map assigned via AssignmentExpression", { timeout: TIMEOUT }, () => {
      const input = `
var vP8;
(function() {
  vP8 = {
    opus: "claude-opus-4-7",
    sonnet: "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5"
  };
})();
const items = [
  { label: "Sonnet", description: \`Sonnet 4.6 · Best \${cost()}\` },
  { label: "Opus", description: \`Opus 4.7 · Most capable \${cost()}\` },
  { label: "Haiku", description: "Haiku 4.5 · Fast" },
];
`;
      const output = runCodemod(input);
      expect(output).toContain("vP8?.[\"sonnet\"]");
      expect(output).toContain("vP8?.[\"opus\"]");
      expect(output).toContain("vP8?.[\"haiku\"]");
      expect(output).toContain('__isModEnabled__("display_model_slug")');
    });
  });

  // Opus 4.7 description variant

  describe("Opus 4.7 description string", () => {
    it("transforms Opus 4.7 description with updated version number", { timeout: TIMEOUT }, () => {
      const input = OBJECT_SLUG_MAP_FIXTURE + `
        const items = [
          { label: "Sonnet", description: \`Sonnet 4.6 · Best \${cost()}\` },
          { label: "Opus", description: \`Opus 4.7 · Most capable \${cost()}\` },
          { label: "Haiku", description: "Haiku 4.5 · Fast" },
        ];
      `;
      const output = runCodemod(input);
      expect(output).toContain("eO7?.[\"opus\"]");
      expect(output).toContain("Opus 4.7");
      expect(output).toContain('__isModEnabled__("display_model_slug")');
    });
  });
});

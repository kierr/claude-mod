import { describe, it, expect } from "bun:test";

const { transform } = require("../../codemods/codemod-set-env-info-prompt.cjs");
const { assertAppliedRegex, assertNotApplicable } = require("./test-helpers.cjs");

function buildFixture({ opusVar = "vtH" } = {}) {
  // The template literal below embeds ${opusVar} inside a backtick string that
  // is itself inside backticks — the outer backticks are the test fixture,
  // the inner ${opusVar} resolves at fixture-build time. When the fixture is
  // parsed by the codemod, ${opusVar} has already been substituted with the
  // minified name (e.g., vtH), so the codemod sees the actual property access
  // like vtH.opus — not the template variable.
  return `
async function _Q3(H, _) {
  let Y = [
    \`Primary working directory: \${z}\`,
    \`Platform: \${S8.platform}\`,
    O, $,
    \`The most recent Claude model family is Claude 4.X. Model IDs — Opus 4.7: '\${${opusVar}.opus}', Sonnet 4.6: '\${${opusVar}.sonnet}', Haiku 4.5: '\${${opusVar}.haiku}'. When building AI applications, default to the latest and most capable Claude models.\`,
    "Claude Code is available as a CLI in the terminal, desktop app (Mac/Windows), web app (claude.ai/code), and IDE extensions (VS Code, JetBrains).",
    "Fast mode for Claude Code uses Claude Opus with faster output (it does not downgrade to a smaller model). It can be toggled with /fast and is available on Opus 4.6 and Opus 4.7."
  ].filter(w => w !== null);
  return ["# Environment", ...Y].join("\\n");
}

function qQ3(H) {
  let K = [
    \`You are powered by the model \${H}.\`,
    \`The most recent Claude model family is Claude 4.X. Model IDs — Opus 4.7: '\${${opusVar}.opus}', Sonnet 4.6: '\${${opusVar}.sonnet}', Haiku 4.5: '\${${opusVar}.haiku}'. When building AI applications, default to the latest and most capable Claude models.\`,
    "Claude Code is available as a CLI in the terminal, desktop app (Mac/Windows), web app (claude.ai/code), and IDE extensions (VS Code, JetBrains).",
    "Fast mode for Claude Code uses Claude Opus with faster output (it does not downgrade to a smaller model). It can be toggled with /fast and is available on Opus 4.6 and Opus 4.7."
  ].filter(O => O !== null);
  return ["# Environment", ...K].join("\\n");
}
`.trim();
}

describe("codemod-set-env-info-prompt", () => {
  it("replaces the 3-entry block with guarded ENV var override", () => {
    const { code } = transform(buildFixture());
    expect(code).toContain('__getModConfig__("set_env_info_prompt","prompt")');
    expect(code).not.toContain("CLAUDE_CODE_ENV_INFO_PROMPT");
    expect(code).not.toContain("The most recent Claude model family is Claude");
  });

  it("is idempotent", () => {
    const once = transform(buildFixture());
    const twice = transform(once.code);
    expect(twice.code).toBe(once.code);
    expect(twice.changed).toBe(0);
  });

  it("preserves surrounding code", () => {
    const { code } = transform(buildFixture());
    expect(code).toContain("Primary working directory");
    expect(code).toContain("You are powered by the model");
    expect(code).toContain(".filter(w => w !== null)");
  });

  it("matches the applied status_test regex", () => {
    const { code } = transform(buildFixture());
    expect(() => assertAppliedRegex("set_env_info_prompt", code)).not.toThrow();
  });

  it("replaces all 6 individual strings across both blocks", () => {
    const { code, changed } = transform(buildFixture());
    expect(changed).toBe(6);
    const count = (code.match(/__getModConfig__\("set_env_info_prompt"/g) || []).length;
    expect(count).toBe(6);
  });

  it("handles backtick-quoted middle entry", () => {
    const fixture = `
function _Q3(H, _) {
  let Y = [
    \`Primary working directory: \${z}\`,
    \`The most recent Claude model family is Claude 4.X. Model IDs — Opus 4.7: '\${v.opus}', Sonnet 4.6: '\${v.sonnet}', Haiku 4.5: '\${v.haiku}'. When building AI applications, default to the latest and most capable Claude models.\`,
    \`Claude Code is available as a CLI in the terminal, desktop app (Mac/Windows), web app (claude.ai/code), and IDE extensions (VS Code, JetBrains).\`,
    \`Fast mode for Claude Code uses Claude Opus with faster output (it does not downgrade to a smaller model). It can be toggled with /fast and is available on Opus 4.6 and Opus 4.7.\`
  ].filter(w => w !== null);
  return ["# Environment", ...Y].join("\\n");
}`.trim();
    const { code } = transform(fixture);
    expect(code).toContain('__getModConfig__("set_env_info_prompt","prompt")');
    expect(code).not.toContain("CLAUDE_CODE_ENV_INFO_PROMPT");
    expect(code).not.toContain("The most recent Claude model family is Claude");
  });

  it("returns changed: 0 for unrelated code", () => {
    const { code, changed } = transform("const x = 42;");
    expect(changed).toBe(0);
    expect(code).toBe("const x = 42;");
  });
});

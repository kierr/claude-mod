import { describe, it, expect } from "bun:test";
import { transform } from "../../codemods/codemod-auth-env-propagation.cjs";

const vh3Fixture = `function vh3() {
    let H = {};
    for (let _ of ["CLAUDE_CONFIG_DIR", "CLAUDE_INTERNAL_FC_OVERRIDES", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PROFILE", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"]) {
      let q = process.env[_];
      if (q) {
        H[_] = q;
      }
    }
    return H;
  }`;

const fm5Fixture = `Fm5 = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR", "DISABLE_TELEMETRY"];`;

const bothFixtures = vh3Fixture + "\n" + fm5Fixture;

describe("codemod-auth-env-propagation", () => {
  it("patches vh3() whitelist with mod-guarded ternary", () => {
    const { code, changed } = transform(vh3Fixture);
    expect(changed).toBeGreaterThanOrEqual(1);
    expect(code).toContain("__isModEnabled__(\"add_auth_forwarding\")");
    expect(code).toContain('"ANTHROPIC_AUTH_TOKEN"');
    expect(code).toContain('"CLAUDE_CONFIG_DIR"');
  });

  it("patches Fm5 array with mod-guarded concat", () => {
    const { code, changed } = transform(fm5Fixture);
    expect(changed).toBeGreaterThanOrEqual(1);
    expect(code).toContain('"ANTHROPIC_AUTH_TOKEN"');
    expect(code).toContain('"ANTHROPIC_BASE_URL"');
  });

  it("applies both patches together", () => {
    const { code, changed } = transform(bothFixtures);
    expect(changed).toBe(2);
    expect(code).toContain("__isModEnabled__(\"add_auth_forwarding\")");
    expect(code).toContain('"ANTHROPIC_AUTH_TOKEN"');
  });

  it("is idempotent", () => {
    const first = transform(bothFixtures);
    const second = transform(first.code);
    expect(second.changed).toBe(0);
    expect(second.code).toEqual(first.code);
  });

  it("survives minified function name changes in vh3", () => {
    const renamed = vh3Fixture.replace("vh3", "zQ9");
    const { code, changed } = transform(renamed);
    expect(changed).toBeGreaterThanOrEqual(1);
    expect(code).toContain('"ANTHROPIC_AUTH_TOKEN"');
  });

  it("survives minified variable name changes in tmux whitelist", () => {
    const renamed = fm5Fixture.replace("Fm5", "Zb2");
    const { code, changed } = transform(renamed);
    expect(changed).toBeGreaterThanOrEqual(1);
    expect(code).toContain('"ANTHROPIC_AUTH_TOKEN"');
    expect(code).toContain("Zb2 =");
  });
});

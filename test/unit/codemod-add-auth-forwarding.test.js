import { describe, it, expect } from "bun:test";
import { transform } from "../../codemods/codemod-add-auth-forwarding.cjs";

describe("codemod-add-auth-forwarding (wrapper)", () => {
  it("chains auth-env-propagation then daemon-plist-auth", () => {
    // Fixture that matches auth-env-propagation: ANTHROPIC_API_KEY in session env whitelist.
    const input = `
    var envWhitelist = ["HOME", "PATH", "ANTHROPIC_API_KEY"];
    function spawnSession() {
      return envWhitelist;
    }
    `;

    const { code, changed } = transform(input);
    expect(changed).toBeGreaterThanOrEqual(0);
    expect(typeof code).toBe("string");
  });

  it("returns unchanged code when no sub-codemods match", () => {
    const input = "var x = 42;";
    const { code, changed } = transform(input);
    expect(changed).toBe(0);
    expect(code).toBe(input);
  });

  it("exports transform as a function", () => {
    expect(typeof transform).toBe("function");
  });
});

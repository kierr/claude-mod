import { describe, it, expect } from "bun:test";

const { discoverEnvVars, categorize } = require("../../lib/discover-env.cjs");

const FIXTURE = `
process.env.ANTHROPIC_BASE_URL = "http://proxy";
if (process.env.CLAUDE_CODE_DISABLE_FAST_MODE) { x(); }
var t = process.env.API_TIMEOUT_MS;
process.env["DISABLE_TELEMETRY"];
if (process.env.PATH) {}              // system var -> dropped
if (process.env.__CFBundleIdentifier) {} // runtime var -> dropped
process.env.ANTHROPIC_BASE_URL;       // second read of same var
`;

describe("discover-env discoverEnvVars", () => {
  const entries = discoverEnvVars(FIXTURE);
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));

  it("keeps only config namespaces and drops system/runtime vars", () => {
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["ANTHROPIC_BASE_URL", "API_TIMEOUT_MS", "CLAUDE_CODE_DISABLE_FAST_MODE", "DISABLE_TELEMETRY"]);
    expect(byName.PATH).toBeUndefined();
    expect(byName.__CFBundleIdentifier).toBeUndefined();
  });

  it("counts reads per name (deduped)", () => {
    expect(byName.ANTHROPIC_BASE_URL.reads).toBe(2);
    expect(byName.API_TIMEOUT_MS.reads).toBe(1);
  });

  it("assigns categories by prefix", () => {
    expect(byName.ANTHROPIC_BASE_URL.category).toBe("Provider & Auth");
    expect(byName.API_TIMEOUT_MS.category).toBe("Limits & Timeouts");
    expect(byName.CLAUDE_CODE_DISABLE_FAST_MODE.category).toBe("Claude Code");
    expect(byName.DISABLE_TELEMETRY.category).toBe("Toggles");
  });

  it("records a 1-based first_line for the first read", () => {
    // ANTHROPIC_BASE_URL first appears on fixture line 2.
    expect(byName.ANTHROPIC_BASE_URL.first_line).toBe(2);
  });

  it("returns entries sorted by name", () => {
    const names = entries.map((e) => e.name);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  it("tags every entry tier:discovered", () => {
    for (const e of entries) expect(e.tier).toBe("discovered");
  });
});

describe("discover-env categorize", () => {
  it("returns null for non-config namespaces", () => {
    expect(categorize("PATH")).toBeNull();
    expect(categorize("__CFBundleIdentifier")).toBeNull();
    expect(categorize("Foo_Bar")).toBeNull();
  });

  it("maps known prefixes to categories", () => {
    expect(categorize("CLAUDE_CODE_X")).toBe("Claude Code");
    expect(categorize("CLAUDE_BG")).toBe("Claude");
    expect(categorize("ANTHROPIC_Y")).toBe("Provider & Auth");
    expect(categorize("DISABLE_Z")).toBe("Toggles");
    expect(categorize("BASH_T")).toBe("Bash & Tooling");
    expect(categorize("MCP_N")).toBe("MCP");
  });
});

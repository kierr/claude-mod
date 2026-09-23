import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { randomUUID } from "crypto";

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-set-auto-dream.cjs");

const TIMEOUT = 30000;
const FIXTURES_DIR = path.join(process.cwd(), "test/fixtures");

function runCodemod(inputCode) {
  const tempInput = path.join(FIXTURES_DIR, `temp-input-${randomUUID()}.js`);
  const tempOutput = path.join(FIXTURES_DIR, `temp-output-${randomUUID()}.js`);

  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  fs.writeFileSync(tempInput, inputCode);

  try {
    execSync(`node "${CODEMOD_PATH}" "${tempInput}" "${tempOutput}"`, {
      stdio: "pipe",
      cwd: process.cwd(),
    });

    return fs.readFileSync(tempOutput, "utf8");
  } finally {
    if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
    if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
  }
}

// Build the y5_() gate function with varied minified names
function buildGateFixture(names) {
  const { fnName, gateFnName, settingsGetter } = names;
  return `
function ${fnName}() {
  if (!${gateFnName}()) {
    return false;
  }
  let H = ${settingsGetter}().autoDreamEnabled;
  if (H !== undefined) {
    return H;
  }
  return true;
}
`;
}

// Build the NT5() threshold function with varied minified names
function buildThresholdFixture(names) {
  const { fnName, gbGetter, gbVar, defaultsName } = names;
  return `
function ${fnName}() {
  let ${gbVar} = ${gbGetter}("tengu_onyx_plover", null);
  return {
    minHours: typeof ${gbVar}?.minHours === "number" && Number.isFinite(${gbVar}.minHours) && ${gbVar}.minHours > 0 ? ${gbVar}.minHours : ${defaultsName}.minHours,
    minSessions: typeof ${gbVar}?.minSessions === "number" && Number.isFinite(${gbVar}.minSessions) && ${gbVar}.minSessions > 0 ? ${gbVar}.minSessions : ${defaultsName}.minSessions
  };
}
`;
}

// Combined fixture with both functions (realistic)
function buildCombinedFixture(gateNames, thresholdNames) {
  return buildGateFixture(gateNames) + "\n" + buildThresholdFixture(thresholdNames);
}

describe("codemod-set-auto-dream", () => {
  describe("y5_() gate bypass", () => {
    it("inserts early return true with mod guard", { timeout: TIMEOUT }, () => {
      const input = buildGateFixture({ fnName: "y5_", gateFnName: "wt_", settingsGetter: "E8" });
      const output = runCodemod(input);

      expect(output).toContain("__isModEnabled__");
      expect(output).toContain("set_auto_dream");
      expect(output).toContain("return true");
    });

    it("matches with varied minified names", { timeout: TIMEOUT }, () => {
      const input = buildGateFixture({ fnName: "checkEnabled", gateFnName: "isAllowed", settingsGetter: "getSettings" });
      const output = runCodemod(input);

      expect(output).toContain("__isModEnabled__");
      expect(output).toContain("return true");
    });

    it("inserts guard as first statement before the existing if", { timeout: TIMEOUT }, () => {
      const input = buildGateFixture({ fnName: "y5_", gateFnName: "wt_", settingsGetter: "E8" });
      const output = runCodemod(input);

      // The mod guard should appear before the original gate check
      const guardIdx = output.indexOf("__isModEnabled__");
      const gateIdx = output.indexOf("wt_()");
      expect(guardIdx).toBeLessThan(gateIdx);
    });
  });

  describe("NT5() threshold override", () => {
    it("wraps return with mod guard and config checks", { timeout: TIMEOUT }, () => {
      const input = buildThresholdFixture({ fnName: "NT5", gbGetter: "y_", gbVar: "H", defaultsName: "KP7" });
      const output = runCodemod(input);

      expect(output).toContain("__isModEnabled__");
      expect(output).toContain("set_auto_dream");
      expect(output).toContain("__getModConfig__");
      expect(output).toContain("CLAUDE_AUTO_DREAM_MIN_HOURS");
      expect(output).toContain("CLAUDE_AUTO_DREAM_MIN_SESSIONS");
    });

    it("includes mods.json config keys", { timeout: TIMEOUT }, () => {
      const input = buildThresholdFixture({ fnName: "NT5", gbGetter: "y_", gbVar: "H", defaultsName: "KP7" });
      const output = runCodemod(input);

      expect(output).toContain("min_hours");
      expect(output).toContain("min_sessions");
    });

    it("falls back to defaults object", { timeout: TIMEOUT }, () => {
      const input = buildThresholdFixture({ fnName: "NT5", gbGetter: "y_", gbVar: "H", defaultsName: "KP7" });
      const output = runCodemod(input);

      expect(output).toContain("KP7.minHours");
      expect(output).toContain("KP7.minSessions");
    });
  });

  describe("combined fixture (both patches)", () => {
    it("patches both functions", { timeout: TIMEOUT }, () => {
      const input = buildCombinedFixture(
        { fnName: "y5_", gateFnName: "wt_", settingsGetter: "E8" },
        { fnName: "NT5", gbGetter: "y_", gbVar: "H", defaultsName: "KP7" }
      );
      const output = runCodemod(input);

      // Both patches applied — gate bypass has return true, threshold has config
      expect(output).toContain("return true");
      expect(output).toContain("__getModConfig__");
      expect(output).toContain("CLAUDE_AUTO_DREAM_MIN_HOURS");
    });

    it("patches both with different minified names", { timeout: TIMEOUT }, () => {
      const input = buildCombinedFixture(
        { fnName: "isEnabled", gateFnName: "checkGate", settingsGetter: "getOpts" },
        { fnName: "getSchedule", gbGetter: "getFeature", gbVar: "data", defaultsName: "defaults" }
      );
      const output = runCodemod(input);

      expect(output).toContain("return true");
      expect(output).toContain("__getModConfig__");
      expect(output).toContain("defaults.minHours");
    });
  });

  describe("idempotency", () => {
    it("does not double-patch already transformed code", { timeout: TIMEOUT }, () => {
      const input = buildCombinedFixture(
        { fnName: "y5_", gateFnName: "wt_", settingsGetter: "E8" },
        { fnName: "NT5", gbGetter: "y_", gbVar: "H", defaultsName: "KP7" }
      );
      const output1 = runCodemod(input);

      // Running again should throw (idempotency check detects existing guard)
      expect(() => runCodemod(output1)).toThrow(/No matching auto-dream functions found/);
    });
  });

  describe("edge cases", () => {
    it("rejects code with no matching functions", { timeout: TIMEOUT }, () => {
      const input = `function foo() { return { minHours: 24, minSessions: 5 }; }`;
      expect(() => runCodemod(input)).toThrow(/No matching auto-dream functions found/);
    });

    it("does not modify unrelated functions", { timeout: TIMEOUT }, () => {
      const input = `
function unrelated(x) { return x + 1; }

${buildCombinedFixture(
  { fnName: "y5_", gateFnName: "wt_", settingsGetter: "E8" },
  { fnName: "NT5", gbGetter: "y_", gbVar: "H", defaultsName: "KP7" }
)}

function alsoUnrelated() { return 42; }
`;
      const output = runCodemod(input);

      expect(output).toContain("return x + 1");
      expect(output).toContain("return 42");
    });

    it("handles only gate function without threshold", { timeout: TIMEOUT }, () => {
      const input = buildGateFixture({ fnName: "y5_", gateFnName: "wt_", settingsGetter: "E8" });
      const output = runCodemod(input);

      expect(output).toContain("__isModEnabled__");
      expect(output).toContain("return true");
    });

    it("handles only threshold function without gate", { timeout: TIMEOUT }, () => {
      const input = buildThresholdFixture({ fnName: "NT5", gbGetter: "y_", gbVar: "H", defaultsName: "KP7" });
      const output = runCodemod(input);

      expect(output).toContain("__getModConfig__");
      expect(output).toContain("CLAUDE_AUTO_DREAM_MIN_HOURS");
    });
  });
});

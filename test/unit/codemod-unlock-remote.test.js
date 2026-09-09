import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-unlock-remote.cjs");

// Babel parsing in execSync is slow on CI runners — increase per-test timeout
// (bun:test default is 5000ms which is too tight for spawning Node + Babel).
const TIMEOUT = 30000;

const MOD_ID = "unlock_remote";

function runCodemod(inputCode) {
  const tempInput = path.join(process.cwd(), "test/fixtures", `temp-input-${randomUUID()}.js`);
  const tempOutput = path.join(process.cwd(), "test/fixtures", `temp-output-${randomUUID()}.js`);

  fs.mkdirSync(path.join(process.cwd(), "test/fixtures"), { recursive: true });
  fs.writeFileSync(tempInput, inputCode);

  try {
    const { execSync } = require("child_process");
    execSync(`node "${CODEMOD_PATH}" "${tempInput}" "${tempOutput}"`, {
      stdio: "pipe",
      cwd: process.cwd()
    });

    const output = fs.readFileSync(tempOutput, "utf8");

    fs.unlinkSync(tempInput);
    fs.unlinkSync(tempOutput);

    return output;
  } catch (error) {
    if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
    if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
    throw error;
  }
}

describe("codemod-unlock-remote", () => {
  describe("Pass 1: CCR compound (tengu_surreal_dali)", () => {
    it("should wrap tengu_surreal_dali compound with true ternary", { timeout: TIMEOUT }, () => {
      const input = `return ${"AB"}("tengu_surreal_dali", false) && ${"XY"}("allow_remote_sessions");`;
      const output = runCodemod(input);

      expect(output).toContain(`__isModEnabled__("${MOD_ID}") ? true :`);
      expect(output).toContain(`"tengu_surreal_dali", false) &&`);
    });

    it("should work with different minified names", { timeout: TIMEOUT }, () => {
      const input = `return ${"Z9"}("tengu_surreal_dali", false) && ${"Q3"}("allow_remote_sessions");`;
      const output = runCodemod(input);

      expect(output).toContain(`__isModEnabled__("${MOD_ID}") ? true :`);
    });
  });

  describe("Pass 2a: Teleport/Remote-env isEnabled", () => {
    it("should wrap g7()-style isEnabled with true ternary", { timeout: TIMEOUT }, () => {
      const input = `isEnabled: () => ${"g7"}() && ${"XY"}("allow_remote_sessions"),`;
      const output = runCodemod(input);

      expect(output).toContain(`__isModEnabled__("${MOD_ID}") ? true :`);
      expect(output).toContain(`g7() &&`);
    });

    it("should work with different minified function names in isEnabled context", { timeout: TIMEOUT }, () => {
      const input = `isEnabled: () => ${"ZB"}() && ${"Q7"}("allow_remote_sessions"),`;
      const output = runCodemod(input);

      expect(output).toContain(`__isModEnabled__("${MOD_ID}") ? true :`);
      expect(output).toContain(`ZB() &&`);
    });

    it("should NOT wrap zero-arg function ANDed with policy outside isEnabled context", { timeout: TIMEOUT }, () => {
      // Include a matchable tengu_surreal_dali line so the codemod doesn't throw
      const input = `
if (${"someCheck"}() && ${"XY"}("allow_remote_sessions")) { doStuff(); }
return ${"AB"}("tengu_surreal_dali", false) && ${"XY"}("allow_remote_sessions");`;
      const output = runCodemod(input);

      // The someCheck line should NOT be wrapped
      const someCheckLine = output.split("\n")[1];
      expect(someCheckLine).not.toContain("__isModEnabled__");
    });
  });

  describe("Pass 2b: Teleport/Remote-env isHidden", () => {
    it("should wrap isHidden compound with false ternary", { timeout: TIMEOUT }, () => {
      const input = `get isHidden() { return !${"g7"}() || !${"XY"}("allow_remote_sessions"); },`;
      const output = runCodemod(input);

      expect(output).toContain(`__isModEnabled__("${MOD_ID}") ? false :`);
      expect(output).toContain(`!g7() || !`);
    });

    it("should NOT double-wrap inner !_Y after Pass 2b wraps the compound", { timeout: TIMEOUT }, () => {
      const input = `get isHidden() { return !${"g7"}() || !${"XY"}("allow_remote_sessions"); },`;
      const output = runCodemod(input);

      // Count occurrences of __isModEnabled__ for this mod — should be exactly 1
      const matches = output.match(new RegExp(`__isModEnabled__\\([^)]*"${MOD_ID}"[^)]*\\)`, "g"));
      expect(matches).toHaveLength(1);
    });
  });

  describe("Pass 3: Standalone policy blocks", () => {
    it("should wrap standalone !_Y(allow_remote_sessions) with false ternary", { timeout: TIMEOUT }, () => {
      const input = `if (!${"XY"}("allow_remote_sessions")) { throw Error("disabled"); }`;
      const output = runCodemod(input);

      expect(output).toContain(`__isModEnabled__("${MOD_ID}") ? false :`);
      expect(output).toContain(`!XY("allow_remote_sessions")`);
    });

    it("should NOT touch Quick Web Setup context", { timeout: TIMEOUT }, () => {
      // Realistic QWS context: allow_quick_web_setup within 200 chars
      // Non-QWS site is padded >200 chars away so the exclusion heuristic doesn't catch it
      const padding = " ".repeat(250);
      const input = `
    isEnabled: () => ${"S8"}("tengu_cobalt_lantern", false) && ${"XY"}("allow_remote_sessions") && ${"XY"}("allow_quick_web_setup"),
    get isHidden() {
      return !${"XY"}("allow_remote_sessions") || !${"XY"}("allow_quick_web_setup");
    },
${padding}
    if (!${"XY"}("allow_remote_sessions")) { throw Error("blocked"); }`;
      const output = runCodemod(input);

      // ALL QWS lines (isEnabled + isHidden) should NOT be wrapped
      const qwsLines = output.split("\n").filter(l => l.includes("allow_quick_web_setup") && l.includes("allow_remote_sessions"));
      expect(qwsLines).toHaveLength(2);
      qwsLines.forEach(line => expect(line).not.toContain("__isModEnabled__"));

      // The non-QWS standalone policy block SHOULD be wrapped
      expect(output).toContain(`__isModEnabled__("${MOD_ID}") ? false : !XY("allow_remote_sessions")`);
    });

    it("should wrap standalone policy WITHOUT allow_quick_web_setup nearby", { timeout: TIMEOUT }, () => {
      const input = `if (!${"XY"}("allow_remote_sessions")) { throw Error("Remote sessions are disabled"); }`;
      const output = runCodemod(input);

      expect(output).toContain(`__isModEnabled__("${MOD_ID}") ? false :`);
    });
  });

  describe("fail-closed on zero matches", () => {
    it("should throw when no gate expressions match", { timeout: TIMEOUT }, () => {
      const input = `const x = 42; console.log("nothing relevant");`;

      expect(() => runCodemod(input)).toThrow();
    });
  });

  describe("idempotency", () => {
    it("should not double-wrap already-patched code", { timeout: TIMEOUT }, () => {
      const input = `return ${"AB"}("tengu_surreal_dali", false) && ${"XY"}("allow_remote_sessions");`;
      const firstPass = runCodemod(input);

      // Run again on already-patched code
      expect(() => runCodemod(firstPass)).toThrow(/No matching gate expressions found/);
    });
  });

  describe("full bundle simulation", () => {
    it("should produce exactly 10 wraps on a realistic multi-site fixture", { timeout: TIMEOUT }, () => {
      const GB = "S8";
      const POL = "_Y";
      const G7 = "g7";

      const input = `
// CCR init
if (!${POL}("allow_remote_sessions")) { K.push({ type: "policy_blocked" }); return K; }

// RemoteTrigger isEnabled
return ${GB}("tengu_surreal_dali", false) && ${POL}("allow_remote_sessions");

// Teleport
isEnabled: () => ${G7}() && ${POL}("allow_remote_sessions"),
get isHidden() { return !${G7}() || !${POL}("allow_remote_sessions"); },

// Remote-env
isEnabled: () => ${G7}() && ${POL}("allow_remote_sessions"),
get isHidden() { return !${G7}() || !${POL}("allow_remote_sessions"); },

// Quick Web Setup (should NOT be touched)
isEnabled: () => ${GB}("tengu_cobalt_lantern", false) && ${POL}("allow_remote_sessions") && ${POL}("allow_quick_web_setup"),
get isHidden() { return !${POL}("allow_remote_sessions") || !${POL}("allow_quick_web_setup"); },

// Schedule isEnabled
isEnabled: () => ${GB}("tengu_surreal_dali", false) && ${POL}("allow_remote_sessions"),

// Session resume
if (!${POL}("allow_remote_sessions")) { throw Error("Remote sessions are disabled"); }

// --remote CLI flag
if (!${POL}("allow_remote_sessions")) { return "Error: Remote sessions are disabled"; }

// Teleport resume
if (!${POL}("allow_remote_sessions")) { throw Error("Remote sessions are disabled by policy"); }
`;

      const output = runCodemod(input);

      const modCount = (output.match(new RegExp(`__isModEnabled__\\([^)]*"${MOD_ID}"[^)]*\\)`, "g")) || []).length;
      expect(modCount).toBe(10);
    });
  });
});

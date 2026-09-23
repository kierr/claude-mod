import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { randomUUID } from "crypto";

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-set-cyber-risk-instruction.cjs");
const FIXTURES_DIR = path.join(process.cwd(), "test/fixtures");

const TIMEOUT = 30000;

function runCodemod(inputCode) {
  const tempInput = path.join(FIXTURES_DIR, `temp-input-${randomUUID()}.js`);
  const tempOutput = path.join(FIXTURES_DIR, `temp-output-${randomUUID()}.js`);
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  fs.writeFileSync(tempInput, inputCode);
  try {
    execSync(`node "${CODEMOD_PATH}" "${tempInput}" "${tempOutput}"`, { stdio: "pipe", cwd: process.cwd() });
    return fs.readFileSync(tempOutput, "utf8");
  } finally {
    if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
    if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
  }
}

const SECURITY_STRING = "IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques.";

describe("codemod-set-cyber-risk-instruction", () => {
  describe("structural matching with varied minified names", () => {
    it("matches v2.1.92 style name JiK", { timeout: TIMEOUT }, () => {
      const output = runCodemod(`var JiK = "${SECURITY_STRING}";\n`);
      expect(output).toContain('__getModConfig__("set_cyber_risk_instruction", "instruction")');
      expect(output).toContain("??");
      expect(output).toContain(SECURITY_STRING);
      // No env-var read — config comes from mods.json via __getModConfig__.
      expect(output).not.toContain("CLAUDE_CYBER_RISK_INSTRUCTION");
      expect(output).not.toContain("__isModEnabled__");
    });

    it("matches simulated v2.1.94+ name ZB1x", { timeout: TIMEOUT }, () => {
      const output = runCodemod(`var ZB1x = "${SECURITY_STRING}";\n`);
      expect(output).toContain('__getModConfig__("set_cyber_risk_instruction", "instruction")');
    });

    it("matches single-char var name", { timeout: TIMEOUT }, () => {
      const output = runCodemod(`var Q = "${SECURITY_STRING}";\n`);
      expect(output).toContain('__getModConfig__("set_cyber_risk_instruction"');
    });
  });

  describe("preserve surrounding code", () => {
    it("does not modify other var declarations", { timeout: TIMEOUT }, () => {
      const output = runCodemod(`var JiK = "${SECURITY_STRING}";\nvar otherVar = "unrelated string";\nvar anotherVar = 42;\n`);
      expect(output).toContain('"unrelated string"');
      expect(output).toContain("42");
    });

    it("preserves the original string as the ?? default (appears once)", { timeout: TIMEOUT }, () => {
      const output = runCodemod(`var JiK = "${SECURITY_STRING}";\n`);
      const count = (output.match(new RegExp(SECURITY_STRING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
      expect(count).toBe(1);
    });
  });

  describe("edge cases", () => {
    it("rejects code with no matching security string (fail-closed)", { timeout: TIMEOUT }, () => {
      expect(() => runCodemod(`var x = "Some other string";\n`)).toThrow(/No matching security instruction string found/);
    });

    it("rejects let/const declarations with the security string (only var)", { timeout: TIMEOUT }, () => {
      expect(() => runCodemod(`let JiK = "${SECURITY_STRING}";\n`)).toThrow(/No matching security instruction string found/);
    });

    it("rejects string that only partially matches the prefix", { timeout: TIMEOUT }, () => {
      expect(() => runCodemod(`var x = "IMPORTANT: Assist with something else entirely";\n`)).toThrow(/No matching security instruction string found/);
    });

    it("is idempotent — already transformed code is a no-op", { timeout: TIMEOUT }, () => {
      const alreadyTransformed = `var JiK = __getModConfig__("set_cyber_risk_instruction", "instruction") ?? "${SECURITY_STRING}";\n`;
      // init is now a LogicalExpression (not a StringLiteral), so it won't match -> throws.
      expect(() => runCodemod(alreadyTransformed)).toThrow(/No matching security instruction string found/);
    });
  });
});

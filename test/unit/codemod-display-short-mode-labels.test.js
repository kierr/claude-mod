import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { randomUUID } from "crypto";

const parser = require(path.join(process.cwd(), "codemods/node_modules/@babel/parser"));

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-display-short-mode-labels.cjs");
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

describe("codemod-display-short-mode-labels", () => {
  describe("title shortening", () => {
    it("guards all mode title strings with __isModEnabled__", { timeout: TIMEOUT }, () => {
      const input = `
        var Gmq = {
          default: {
            title: "Default",
            shortTitle: "Default",
            symbol: "",
            color: "text",
            external: "default"
          },
          plan: {
            title: "Plan Mode",
            shortTitle: "Plan",
            symbol: "p",
            color: "planMode",
            external: "plan"
          },
          acceptEdits: {
            title: "Accept edits",
            shortTitle: "Accept",
            symbol: "a",
            color: "autoAccept",
            external: "acceptEdits"
          },
          bypassPermissions: {
            title: "Bypass Permissions",
            shortTitle: "Bypass",
            symbol: "b",
            color: "error",
            external: "bypassPermissions"
          },
          dontAsk: {
            title: "Don't Ask",
            shortTitle: "DontAsk",
            symbol: "d",
            color: "error",
            external: "dontAsk"
          },
          auto: {
            title: "Auto mode",
            shortTitle: "Auto",
            symbol: "u",
            color: "warning",
            external: "auto"
          }
        };
      `;

      const output = runCodemod(input);

      // Guarded: short title is the consequent, original is the alternate
      expect(output).toContain('"Plan"');
      expect(output).toContain('"Plan Mode"');
      expect(output).toContain('"Accept"');
      expect(output).toContain('"Accept edits"');
      expect(output).toContain('"Bypass"');
      expect(output).toContain('"Bypass Permissions"');
      expect(output).toContain('"DontAsk"');
      expect(output).toContain('"Auto"');
      expect(output).toContain('"Auto mode"');
      expect(output).toContain('__isModEnabled__("display_short_mode_labels")');
      expect(() => parser.parse(output, { sourceType: "module" })).not.toThrow();
    });

    it("guards titles with different minified object names", { timeout: TIMEOUT }, () => {
      const input = `
        var XK3 = {
          plan: { title: "Plan Mode", shortTitle: "Plan" },
          acceptEdits: { title: "Accept edits", shortTitle: "Accept" },
          bypassPermissions: { title: "Bypass Permissions", shortTitle: "Bypass" },
          auto: { title: "Auto mode", shortTitle: "Auto" }
        };
      `;

      const output = runCodemod(input);

      expect(output).toContain('__isModEnabled__("display_short_mode_labels")');
      expect(output).toContain('"Plan"');
      expect(output).toContain('"Plan Mode"');
    });
  });

  describe("hint removal from createElement", () => {
    it("guards ' on' and chord-hint ref in compact footer", { timeout: TIMEOUT }, () => {
      const input = `
        var w8 = v_ && AH ? x8.createElement(N, {
          color: zL(AH),
          key: "mode"
        }, Q4H(AH), " ", lr(AH).toLowerCase(), " on", eH) : null;
      `;

      const output = runCodemod(input);

      // Guarded: " on" is now a ternary (mod enabled → "", disabled → " on")
      expect(output).toContain('__isModEnabled__("display_short_mode_labels")');
      expect(output).toContain('" on"');
      expect(output).toContain('""');
      expect(output).toContain("lr(AH).toLowerCase()");
      expect(output).toContain("Q4H(AH)");
    });

    it("guards ' on' and conditional chord hint in full footer", { timeout: TIMEOUT }, () => {
      const input = `
        var VH = AH && KH && PH ? x8.createElement(N, {
          color: zL(AH),
          key: "mode"
        }, Q4H(AH), " ", lr(AH).toLowerCase(), " on", XH && x8.createElement(N, {
          dimColor: true
        }, " ", x8.createElement(K_, {
          chord: X,
          action: "cycle",
          parens: true,
          format: { keyCase: "lower" }
        }))) : null;
      `;

      const output = runCodemod(input);

      expect(output).toContain('__isModEnabled__("display_short_mode_labels")');
      expect(output).toContain("lr(AH).toLowerCase()");
      expect(output).toContain("Q4H(AH)");
    });

    it("handles createElement with different minified names", { timeout: TIMEOUT }, () => {
      const input = `
        var w8 = v_ && AH ? zB.createElement(M, {
          color: qR(AH),
          key: "mode"
        }, x2(AH), " ", nW(AH).toLowerCase(), " on", pK) : null;
      `;

      const output = runCodemod(input);

      expect(output).toContain('__isModEnabled__("display_short_mode_labels")');
      expect(output).toContain("nW(AH).toLowerCase()");
    });
  });

  describe("combined transform (titles + hints)", () => {
    it("guards titles and hints together", { timeout: TIMEOUT }, () => {
      const input = `
        var Gmq = {
          plan: { title: "Plan Mode", shortTitle: "Plan" },
          acceptEdits: { title: "Accept edits", shortTitle: "Accept" },
          bypassPermissions: { title: "Bypass Permissions", shortTitle: "Bypass" },
          auto: { title: "Auto mode", shortTitle: "Auto" }
        };
        var w8 = v_ && AH ? x8.createElement(N, {
          color: zL(AH),
          key: "mode"
        }, Q4H(AH), " ", lr(AH).toLowerCase(), " on", eH) : null;
      `;

      const output = runCodemod(input);

      // Titles are guarded ternaries
      expect(output).toContain('"Plan"');
      expect(output).toContain('"Plan Mode"');
      // Hints are guarded
      expect(output).toContain('__isModEnabled__("display_short_mode_labels")');
    });
  });

  describe("idempotency", () => {
    it("is idempotent — running twice produces same output", { timeout: TIMEOUT }, () => {
      const input = `
        var Gmq = {
          plan: { title: "Plan Mode", shortTitle: "Plan" },
          acceptEdits: { title: "Accept edits", shortTitle: "Accept" }
        };
        var w8 = x8.createElement(N, {}, Q4H(AH), " ", lr(AH).toLowerCase(), " on", eH);
      `;

      const first = runCodemod(input);
      const second = runCodemod(first);

      expect(first).toContain('__isModEnabled__("display_short_mode_labels")');
      expect(first).toBe(second);
    });
  });

  describe("edge cases", () => {
    it("is a no-op on code with no matching patterns", { timeout: TIMEOUT }, () => {
      const input = `
        const x = 42;
        console.log(x);
      `;

      const output = runCodemod(input);
      expect(output).toContain("const x = 42");
    });

    it("preserves unrelated 'on' strings in code", { timeout: TIMEOUT }, () => {
      const input = `
        var Gmq = {
          plan: { title: "Plan Mode", shortTitle: "Plan" }
        };
        console.log("click on the button");
      `;

      const output = runCodemod(input);

      expect(output).toContain('"click on the button"');
      expect(output).toContain('"Plan"');
      expect(output).toContain('"Plan Mode"');
    });
  });
});

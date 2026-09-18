import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const CODEMOD_PATH = path.join(
  process.cwd(),
  "codemods/codemod-plan-exit-show-model.cjs"
);

// Babel parsing in execSync is slow on CI runners — increase per-test timeout
// (bun:test default is 5000ms which is too tight for spawning Node + Babel).
const TIMEOUT = 30000;

describe("codemod-plan-exit-show-model", () => {
  function runCodemod(inputCode, outputPath) {
    const tempInput = path.join(
      process.cwd(),
      "test/fixtures",
      `temp-input-${randomUUID()}.js`
    );
    const tempOutput =
      outputPath ||
      path.join(
        process.cwd(),
        "test/fixtures",
        `temp-output-${randomUUID()}.js`
      );

    fs.mkdirSync(path.join(process.cwd(), "test/fixtures"), {
      recursive: true,
    });
    fs.writeFileSync(tempInput, inputCode);

    try {
      const { execSync } = require("child_process");
      execSync(`node "${CODEMOD_PATH}" "${tempInput}" "${tempOutput}"`, {
        stdio: "pipe",
        cwd: process.cwd(),
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

  describe("model display hook discovery", () => {
    it("finds hook with 2.1.94 minified names (OJ, J8)", { timeout: TIMEOUT }, () => {
      const input = `
        function OJ() {
          let q = J8(Y => Y.mainLoopModel);
          let K = J8(Y => Y.mainLoopModelForSession);
          let [, _] = nm8.useReducer(Y => Y + 1, 0);
          nm8.useEffect(() => Ri6(_), []);
          return N5(K ?? q ?? QN());
        }
        function Component() {
          return VK.default.createElement(kY, { title: "Ready to code?" }, null);
        }
      `;

      const output = runCodemod(input);

      expect(output).toContain("__planModelDisplay__");
      expect(output).toContain("display_model_name");
      expect(output).toContain("OJ()");
    });

    it("finds hook with different minified names (ABC, XYZ)", { timeout: TIMEOUT }, () => {
      const input = `
        function ABC() {
          let a = XYZ(p => p.mainLoopModel);
          let b = XYZ(p => p.mainLoopModelForSession);
          return fmt(b ?? a ?? defaultModel());
        }
        function Comp() {
          return createElement(Box, { title: "Ready to code?" }, null);
        }
      `;

      const output = runCodemod(input);

      expect(output).toContain("__planModelDisplay__");
      expect(output).toContain("ABC()");
    });

    it("returns changed: 0 when model hook is not found", { timeout: TIMEOUT }, () => {
      const input = `
        function noHookHere() {
          return 42;
        }
        function Comp() {
          return createElement(Box, { title: "Ready to code?" }, null);
        }
      `;

      const output = runCodemod(input);
      // Output is unchanged — no hook was found so no transformation applied
      expect(output).toBe(input);
    });
  });

  describe("title replacement", () => {
    it("replaces 'Ready to code?' title", { timeout: TIMEOUT }, () => {
      const input = `
        function getModelDisplay() {
          let q = store(s => s.mainLoopModel);
          let K = store(s => s.mainLoopModelForSession);
          return formatModel(K ?? q);
        }
        function Component() {
          return createElement(kY, {
            color: "planMode",
            title: "Ready to code?",
            innerPaddingX: 0
          }, content);
        }
      `;

      const output = runCodemod(input);

      // Should contain the mod guard
      expect(output).toContain("__isModEnabled__");
      expect(output).toContain("display_model_name");
      // Should contain the hook variable
      expect(output).toContain("__planModelDisplay__");
      // Original title text should still be present (as part of concatenation)
      expect(output).toContain("Ready to code?");
    });

    it("replaces 'Exit plan mode?' title", { timeout: TIMEOUT }, () => {
      const input = `
        function getModelDisplay() {
          let q = store(s => s.mainLoopModel);
          let K = store(s => s.mainLoopModelForSession);
          return formatModel(K ?? q);
        }
        function Component() {
          return createElement(kY, {
            color: "planMode",
            title: "Exit plan mode?"
          }, yesBtn, noBtn);
        }
      `;

      const output = runCodemod(input);

      expect(output).toContain("__isModEnabled__");
      expect(output).toContain("display_model_name");
      expect(output).toContain("__planModelDisplay__");
      expect(output).toContain("Exit plan mode?");
    });

    it("replaces both titles in the same component", { timeout: TIMEOUT }, () => {
      const input = `
        function hookFn() {
          let q = store(s => s.mainLoopModel);
          let K = store(s => s.mainLoopModelForSession);
          return formatModel(K ?? q);
        }
        function PlanExit({ plan, onAccept }) {
          if (plan) {
            return createElement(kY, {
              title: "Ready to code?",
              workerBadge: z
            }, plan);
          }
          return createElement(kY, {
            title: "Exit plan mode?",
            workerBadge: z
          }, null);
        }
      `;

      const output = runCodemod(input);

      expect(output).toContain("__isModEnabled__");
      expect(output).toContain("__planModelDisplay__");
      // Both title strings should be present (in concatenation expressions)
      expect(output).toContain("Ready to code?");
      expect(output).toContain("Exit plan mode?");
      // Hook call should be injected only once per function
      const hookCalls = output.match(/let __planModelDisplay__/g);
      expect(hookCalls).not.toBeNull();
      expect(hookCalls.length).toBe(1);
    });
  });

  describe("mod guard structure", () => {
    it("uses typeof guard to prevent ReferenceError", { timeout: TIMEOUT }, () => {
      const input = `
        function hook() {
          let q = s(x => x.mainLoopModel);
          let K = s(x => x.mainLoopModelForSession);
          return K ?? q;
        }
        function Comp() {
          return el(Box, { title: "Ready to code?" }, null);
        }
      `;

      const output = runCodemod(input);

      // typeof guard prevents ReferenceError if mods_runtime not applied
      expect(output).toContain('typeof __isModEnabled__ === "function"');
    });

    it("concatenates empty string when mod is disabled", { timeout: TIMEOUT }, () => {
      const input = `
        function hook() {
          let q = s(x => x.mainLoopModel);
          let K = s(x => x.mainLoopModelForSession);
          return K ?? q;
        }
        function Comp() {
          return el(Box, { title: "Ready to code?" }, null);
        }
      `;

      const output = runCodemod(input);

      // Should contain empty string as fallback
      expect(output).toContain('""');
      // Should contain model name concatenation in conditional
      expect(output).toMatch(/__planModelDisplay__/);
    });
  });

  describe("real-world patterns", () => {
    it("handles 2.1.94-style plan exit component", { timeout: TIMEOUT }, () => {
      const input = `
        function OJ() {
          let q = J8(Y => Y.mainLoopModel);
          let K = J8(Y => Y.mainLoopModelForSession);
          let [, _] = nm8.useReducer(Y => Y + 1, 0);
          nm8.useEffect(() => Ri6(_), []);
          return N5(K ?? q ?? QN());
        }

        function bsK({ planContent, onAccept, onReject, onEdit, z }) {
          if (!planContent) {
            return VK.default.createElement(kY, {
              color: "planMode",
              title: "Exit plan mode?",
              workerBadge: z
            }, VK.default.createElement(T, null, "Yes"), VK.default.createElement(T, null, "No"));
          }
          return VK.default.createElement(kY, {
            color: "planMode",
            title: "Ready to code?",
            innerPaddingX: 0,
            workerBadge: z
          }, planContent, VK.default.createElement(T, { onClick: onAccept }, "Accept"));
        }
      `;

      const output = runCodemod(input);

      // Both titles replaced
      expect(output).toContain("Ready to code?");
      expect(output).toContain("Exit plan mode?");
      // Hook call injected once (same component for both titles)
      const hookCalls = output.match(/let __planModelDisplay__/g);
      expect(hookCalls).not.toBeNull();
      expect(hookCalls.length).toBe(1);
      // Hook uses discovered name
      expect(output).toContain("OJ()");
      // Mod guard present
      expect(output).toContain("__isModEnabled__");
      expect(output).toContain("display_model_name");
    });
  });

  describe("edge cases", () => {
    it("does not modify unrelated title props", { timeout: TIMEOUT }, () => {
      const input = `
        function hook() {
          let q = s(x => x.mainLoopModel);
          let K = s(x => x.mainLoopModelForSession);
          return K ?? q;
        }
        function Comp() {
          return el(Box, { title: "Some other title" }, null);
        }
      `;

      const output = runCodemod(input);

      expect(output).toContain('"Some other title"');
      // No __planModelDisplay__ injection since no target titles matched
      expect(output).not.toContain("__planModelDisplay__");
    });

    it("handles code with no target patterns gracefully", { timeout: TIMEOUT }, () => {
      const input = `
        const x = 42;
        console.log(x);
      `;

      // Should return unchanged because model hook is not found
      const output = runCodemod(input);
      expect(output).toBe(input);
    });

    it("does not match hook with only mainLoopModel (missing mainLoopModelForSession)", { timeout: TIMEOUT }, () => {
      const input = `
        function partialHook() {
          let q = s(x => x.mainLoopModel);
          return q;
        }
        function Comp() {
          return el(Box, { title: "Ready to code?" }, null);
        }
      `;

      // Should return unchanged because hook is incomplete
      const output = runCodemod(input);
      expect(output).toBe(input);
    });
  });
});

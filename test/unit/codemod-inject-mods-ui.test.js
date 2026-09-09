import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { randomUUID } from "crypto";

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-inject-mods-ui.cjs");
const parser = require("@babel/parser");
const { getModRegistry, buildModsTabExpression } = require("../../codemods/codemod-inject-mods-ui.cjs");

// Babel parsing in execSync is slow on CI runners — increase per-test timeout
// (bun:test default is 5000ms which is too tight for spawning Node + Babel).
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

// Build a fixture with the element-based tab pattern using arbitrary names.
// Mimics the 2.1.101+ architecture where each tab is a createElement call
// and they're collected in an array with a spread for plugin tabs.
// Also includes an ink namespace export block so the codemod can find inkVar.
function buildConfigPanelFixture(names) {
  const { fnName, reactVar, tabComp, statsComp, extraVar, inkVar, inkBox, inkUseInput, crAlias, reqFn } = names;
  const alias = crAlias || "vP5";
  const fn = reqFn || "d6";
  return `
import { createRequire as ${alias} } from "node:module";
var ${fn} = ${alias}(import.meta.url);
var ${inkVar} = {};
__export(${inkVar}, {
  useInput: () => ${inkUseInput},
  Box: () => ${inkBox},
  Text: () => ${inkBox}Text
});

function ${fnName}(q) {
  let R;
  R = ${reactVar}.createElement(${tabComp}, { key: "stats", title: "Stats" },
    ${reactVar}.createElement(${statsComp}, null));
  let ${extraVar} = [];
  let b = [R, ...${extraVar}];
  return b;
}
`;
}

describe("codemod-inject-mods-ui", () => {
  describe("structural matching with varied minified names", () => {
    it("matches v2.1.101 style names (set A)", { timeout: TIMEOUT }, () => {
      const input = buildConfigPanelFixture({
        fnName: "s96", reactVar: "EJ", tabComp: "zO", statsComp: "NbK", extraVar: "S", inkVar: "Yd", inkBox: "u", inkUseInput: "Cw"
      });

      const output = runCodemod(input);

      expect(output).toContain('title: "Mods"');
      expect(output).toContain('key: "mods"');
      expect(output).toContain("__ModsTab__");
      // Must not contain require("ink") — uses bundled references via closure
      expect(output).not.toContain('require("ink")');
      expect(output).not.toContain('require("react")');
      // Verify dynamic ink component discovery: Box=u, Text=uText (from __export fixture)
      expect(output).toContain("createElement(u,");
      expect(output).toContain("createElement(uText,");
    });

    it("matches v2.1.101 style names (set B)", { timeout: TIMEOUT }, () => {
      const input = buildConfigPanelFixture({
        fnName: "Xp7", reactVar: "WR", tabComp: "Bm3", statsComp: "Qz9", extraVar: "ext", inkVar: "Zk", inkBox: "bx3", inkUseInput: "ui7"
      });

      const output = runCodemod(input);

      expect(output).toContain('title: "Mods"');
      expect(output).toContain('key: "mods"');
      expect(output).toContain("__ModsTab__");
      // Verify dynamic ink component discovery: Box=bx3, Text=bx3Text (from __export fixture)
      expect(output).toContain("createElement(bx3,");
      expect(output).toContain("createElement(bx3Text,");
    });
  });

  describe("tab element injection", () => {
    it("injects Mods tab element before the spread in the array", { timeout: TIMEOUT }, () => {
      const input = buildConfigPanelFixture({
        fnName: "ConfigPanel", reactVar: "React", tabComp: "Tab", statsComp: "StatsView", extraVar: "plugins", inkVar: "Ink", inkBox: "BoxComp", inkUseInput: "useInpFn"
      });

      const output = runCodemod(input);

      // Should have both Stats and Mods tabs
      expect(output).toContain('title: "Stats"');
      expect(output).toContain('title: "Mods"');
      // Mods tab element should use same React var and tab component
      expect(output).toContain('React.createElement(Tab');
      // Should use __ModsTab__ as content
      expect(output).toContain("React.createElement(__ModsTab__");
    });
  });

  describe("generated Mods UX", () => {
    it("renders polished list badges, grouping, and help text", { timeout: TIMEOUT }, () => {
      const output = runCodemod(buildConfigPanelFixture({
        fnName: "ConfigPanel", reactVar: "React", tabComp: "Tab", statsComp: "StatsView", extraVar: "plugins", inkVar: "Ink", inkBox: "BoxComp", inkUseInput: "useInpFn"
      }));

      expect(output).toContain("enabledCount");
      expect(output).toContain("categoryLabel");
      expect(output).toContain('"  config"');
      expect(output).toContain('"  restart"');
      expect(output).toContain("enabled=active now, restart=restart needed");
    });

    it("supports select cycling and resetting focused config fields", { timeout: TIMEOUT }, () => {
      const output = runCodemod(buildConfigPanelFixture({
        fnName: "ConfigPanel", reactVar: "React", tabComp: "Tab", statsComp: "StatsView", extraVar: "plugins", inkVar: "Ink", inkBox: "BoxComp", inkUseInput: "useInpFn"
      }));

      expect(output).toContain("function fieldDisplayValue");
      expect(output).toContain("function cycleSelectValue");
      expect(output).toContain('sel.type === "select"');
      expect(output).toContain("reset.default");
      expect(output).toContain("Enter edit/cycle");
      expect(output).toContain('"  modified"');
      expect(output).toContain('"  default"');
    });

    it("keeps sections contiguous, categories contiguous within a section", () => {
      const registry = getModRegistry();
      const seenSections = new Set();
      let currentSection = null;
      const seenCategoryInSection = new Set();
      let currentCategory = null;
      for (const mod of registry) {
        const sec = mod.section || "mods";
        if (sec !== currentSection) {
          expect(seenSections.has(sec)).toBe(false);
          seenSections.add(sec);
          currentSection = sec;
          seenCategoryInSection.clear();
          currentCategory = null;
        }
        if (mod.category !== currentCategory) {
          expect(seenCategoryInSection.has(mod.category)).toBe(false);
          seenCategoryInSection.add(mod.category);
          currentCategory = mod.category;
        }
      }
    });

    it("produces parseable runtime code after placeholder substitution", () => {
      let code = buildModsTabExpression();
      code = code.replace(/__REACT_REF__/g, "R")
        .replace(/__REQUIRE_FN__/g, "require")
        .replace(/__INK_BOX__/g, "B")
        .replace(/__INK_TEXT__/g, "V");
      expect(() => parser.parse(code, { sourceType: "unambiguous", plugins: ["jsx", "typescript"] })).not.toThrow();
    });
  });

  describe("__ModsTab__ component injection", () => {
    it("inserts __ModsTab__ variable before the config panel function", { timeout: TIMEOUT }, () => {
      const input = `
function unrelated() { return 42; }

${buildConfigPanelFixture({
  fnName: "ConfigPanel", reactVar: "React", tabComp: "Tab", statsComp: "StatsView", extraVar: "plugins", inkVar: "Ink", inkBox: "BoxComp", inkUseInput: "useInpFn"
})}
`;

      const output = runCodemod(input);

      // __ModsTab__ should appear before the ConfigPanel function
      const modsTabIdx = output.indexOf("function __ModsTab__");
      const panelIdx = output.indexOf("function ConfigPanel");
      expect(modsTabIdx).toBeGreaterThan(-1);
      expect(panelIdx).toBeGreaterThan(-1);
      expect(modsTabIdx).toBeLessThan(panelIdx);
    });
  });

  describe("preserve surrounding code", () => {
    it("does not modify unrelated functions", { timeout: TIMEOUT }, () => {
      const input = `
function unrelated(x) { return x + 1; }

${buildConfigPanelFixture({
  fnName: "ConfigPanel", reactVar: "React", tabComp: "Tab", statsComp: "StatsView", extraVar: "plugins", inkVar: "Ink", inkBox: "BoxComp", inkUseInput: "useInpFn"
})}

function alsoUnrelated() { return 42; }
`;

      const output = runCodemod(input);

      expect(output).toContain("return x + 1");
      expect(output).toContain("function alsoUnrelated");
    });
  });

  describe("edge cases", () => {
    it("skips when Mods tab already exists (idempotent)", { timeout: TIMEOUT }, () => {
      const input = `
function ConfigPanel(q) {
  let R;
  R = React.createElement(Tab, { key: "mods", title: "Mods" },
    React.createElement(SomeComp, null));
  let ext = [];
  let b = [R, ...ext];
  return b;
}
`;

      const output = runCodemod(input);

      // Should not inject additional Mods tab
      const modsCount = (output.match(/title: "Mods"/g) || []).length;
      expect(modsCount).toBe(1);
    });

    it("skips when Stats tab is missing", { timeout: TIMEOUT }, () => {
      const input = `
function ConfigPanel(q) {
  let R;
  R = React.createElement(Tab, { key: "usage", title: "Usage" },
    React.createElement(SomeComp, null));
  let ext = [];
  let b = [R, ...ext];
  return b;
}
`;

      const output = runCodemod(input);

      expect(output).not.toContain('"Mods"');
    });

    it("skips when array has no spread element", { timeout: TIMEOUT }, () => {
      const input = `
function ConfigPanel(q) {
  let R;
  R = React.createElement(Tab, { key: "stats", title: "Stats" },
    React.createElement(SomeComp, null));
  let b = [R];
  return b;
}
`;

      const output = runCodemod(input);

      expect(output).not.toContain('"Mods"');
    });
  });
});

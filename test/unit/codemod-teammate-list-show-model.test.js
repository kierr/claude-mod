import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const CODEMOD_PATH = path.join(
  process.cwd(),
  "codemods/codemod-teammate-list-show-model.cjs"
);

const TIMEOUT = 30000;

const CODEMODS_DIR = path.join(process.cwd(), "codemods");
function babelRequire(pkg) {
  const p = path.join(CODEMODS_DIR, "node_modules", "@babel", pkg);
  try { return require(p); } catch { return require("@babel/" + pkg); }
}
const parser = babelRequire("parser");
const generate = babelRequire("generator").default;

function transformViaImport(inputCode) {
  const { transform } = require(CODEMOD_PATH);
  const ast = parser.parse(inputCode, {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript"],
  });
  const n = transform(ast);
  const code = generate(ast, { retainLines: false }, inputCode).code;
  return { code, changed: n };
}

/**
 * Build a KDK-like component fixture with configurable minified names.
 */
function buildFixture({
  funcName = "KDK",
  reactVar = "ET",
  textComp = "N",
  boxComp = "p",
  teammateAlias = "H",
  isLastAlias = "_",
  isSelectedAlias = "q",
  isForegroundedAlias = "K",
  allIdleAlias = "O",
  showPreviewAlias = "T",
  statusComp = "daO",
} = {}) {
  return `
function ${funcName}({
  teammate: ${teammateAlias},
  isLast: ${isLastAlias},
  isSelected: ${isSelectedAlias},
  isForegrounded: ${isForegroundedAlias},
  allIdle: ${allIdleAlias},
  showPreview: ${showPreviewAlias}
}) {
  let activityText = "reading files";
  let pastTenseVerb = "read";
  let displayTime = "5m";
  let idleElapsedTime = null;
  let toolUseCount = 3;
  let tokenCount = 1200;
  let isHighlighted = ${isSelectedAlias} || ${isForegroundedAlias};
  return ${reactVar}.createElement(${boxComp}, {
    flexDirection: "column"
  }, ${reactVar}.createElement(${boxComp}, {
    paddingLeft: 3
  }, ${reactVar}.createElement(${textComp}, {
    dimColor: !${isSelectedAlias}
  }, "pointer"), ${reactVar}.createElement(${statusComp}, {
    teammate: ${teammateAlias},
    allIdle: ${allIdleAlias},
    pastTenseVerb: pastTenseVerb,
    displayTime: displayTime,
    idleElapsedTime: idleElapsedTime,
    isHighlighted: isHighlighted,
    activityText: activityText
  }), toolUseCount && ${reactVar}.createElement(${textComp}, {
    dimColor: true
  }, " tool uses")));
}
`;
}

describe("codemod-teammate-list-show-model", () => {
  it("injects model badge into KDK component", () => {
    const input = buildFixture();
    const { code, changed } = transformViaImport(input);

    expect(changed).toBe(1);
    expect(code).toContain("__isModEnabled__");
    expect(code).toContain('"display_model_name"');
    expect(code).toContain("H.model");
    expect(code).toContain("dimColor");
  });

  it("places model badge between status component and tool use count", () => {
    const input = buildFixture();
    const { code } = transformViaImport(input);

    const statusIdx = code.lastIndexOf("activityText:");
    const modelIdx = code.indexOf("H.model");
    const toolUseIdx = code.lastIndexOf("tool uses");

    expect(statusIdx).toBeGreaterThan(0);
    expect(modelIdx).toBeGreaterThan(statusIdx);
    expect(toolUseIdx).toBeGreaterThan(modelIdx);
  });

  it("uses mod guard for runtime toggling", () => {
    const input = buildFixture();
    const { code } = transformViaImport(input);

    expect(code).toContain('typeof __isModEnabled__ === "function"');
    expect(code).toContain('__isModEnabled__("display_model_name")');
  });

  it("works with different minified names", () => {
    const input = buildFixture({
      funcName: "Z9_",
      reactVar: "X8_",
      textComp: "V",
      boxComp: "B",
      teammateAlias: "Q",
      isLastAlias: "w",
      isSelectedAlias: "f",
      isForegroundedAlias: "M",
      allIdleAlias: "P",
      showPreviewAlias: "J",
      statusComp: "km3",
    });

    const { code, changed } = transformViaImport(input);

    expect(changed).toBe(1);
    expect(code).toContain("Q.model");
    expect(code).toContain("X8_.createElement");
    expect(code).toContain("__isModEnabled__");
  });

  it("is idempotent — second run adds no duplicate", () => {
    const input = buildFixture();
    const { code: first } = transformViaImport(input);
    const { code: second, changed } = transformViaImport(first);

    expect(changed).toBe(0);
    expect(first).toBe(second);
  });

  it("returns 0 when KDK pattern is not found", () => {
    const input = `
      function unrelated({ foo, bar }) {
        return ET.createElement(N, { dimColor: true }, "hello");
      }
    `;
    const { changed } = transformViaImport(input);
    expect(changed).toBe(0);
  });

  it("requires all six props to match — missing prop means no match", () => {
    const input = `
      function partial({
        teammate: H,
        isLast: _,
        isSelected: q
      }) {
        return ET.createElement(N, null, "text");
      }
    `;
    const { changed } = transformViaImport(input);
    expect(changed).toBe(0);
  });
});

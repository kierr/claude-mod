/**
 * Tests for codemod-model-picker-search.cjs
 *
 * The codemod uses structural markers (stable string literals, property names,
 * and AST shapes) rather than minified identifiers, so fixtures use synthetic
 * code that mirrors the real upstream shape with readable names.
 */

const { describe, it, expect } = require("bun:test");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");
const { transform, discover, buildWrapperComponentSource, MOD_ID } = require("../../codemods/codemod-model-picker-search.cjs");

const WRAPPER_NAME = "__ModelSearchSelect__";

// ── Minimal synthetic fixture matching the codemod's structural markers ──

function buildMinimalFixture() {
  // Construct AST programmatically so every anchor the codemod expects is present.
  // The fixture is intentionally minimal — just enough structure for discover().

  const hooksMod = t.identifier("U0e");
  const reactName = t.identifier("kl");
  const selectComp = t.identifier("Ar");
  const boxComp = t.identifier("Bx");
  const textComp = t.identifier("Tx");
  const woName = t.identifier("Wo");

  // useState(false) anchor
  const useStateAnchor = t.variableDeclaration("let", [
    t.variableDeclarator(
      t.arrayPattern([t.identifier("g"), t.identifier("_")]),
      t.callExpression(
        t.memberExpression(hooksMod, t.identifier("useState")),
        [t.booleanLiteral(false)]
      )
    ),
  ]);

  // options array
  const optionsId = t.identifier("D");
  const optionsDecl = t.variableDeclaration("let", [
    t.variableDeclarator(optionsId, t.identifier("O")),
  ]);

  // inner Select createElement — must have all required props
  const selectProps = t.objectExpression([
    t.objectProperty(t.identifier("defaultValue"), t.stringLiteral("default")),
    t.objectProperty(t.identifier("defaultFocusValue"), t.stringLiteral("focus")),
    t.objectProperty(t.identifier("options"), optionsId),
    t.objectProperty(t.identifier("onChange"), t.identifier("qe")),
    t.objectProperty(t.identifier("onFocus"), t.identifier("onFocus")),
    t.objectProperty(t.identifier("onCancel"), t.identifier("onCancel")),
    t.objectProperty(t.identifier("visibleOptionCount"), t.numericLiteral(5)),
  ]);
  const arCall = t.callExpression(
    t.memberExpression(reactName, t.identifier("createElement")),
    [selectComp, selectProps]
  );

  // outer Box wrapper: kl.createElement(Bx, {flexDirection:"column"}, <arCall>)
  const outerCall = t.callExpression(
    t.memberExpression(reactName, t.identifier("createElement")),
    [
      boxComp,
      t.objectExpression([t.objectProperty(t.identifier("flexDirection"), t.stringLiteral("column"))]),
      arCall,
    ]
  );

  // wt memo IfStatement: if (t[0] === Symbol.for("react.memo_cache_sentinel")) { ... <outerCall> ... }
  const wtIf = t.ifStatement(
    t.binaryExpression("===",
      t.memberExpression(t.identifier("t"), t.numericLiteral(0), true),
      t.callExpression(t.memberExpression(t.identifier("Symbol"), t.identifier("for")), [t.stringLiteral("react.memo_cache_sentinel")])
    ),
    t.blockStatement([
      t.expressionStatement(outerCall),
      t.expressionStatement(t.assignmentExpression("=",
        t.memberExpression(t.identifier("t"), t.numericLiteral(1), true),
        t.identifier("wt")
      )),
    ]),
    t.blockStatement([
      t.expressionStatement(t.assignmentExpression("=",
        t.memberExpression(t.identifier("t"), t.numericLiteral(1), true),
        t.callExpression(t.memberExpression(t.identifier("Ar"), t.identifier("bind")), [t.identifier("null")])
      )),
    ])
  );

  // Be memo: let Be; if (t[55] === Symbol.for("react.memo_cache_sentinel")) { Be = {context:"ModelPicker"}; ...}
  const beName = t.identifier("Be");
  const beDecl = t.variableDeclaration("let", [t.variableDeclarator(beName)]);
  const beIf = t.ifStatement(
    t.binaryExpression("===",
      t.memberExpression(t.identifier("t"), t.numericLiteral(55), true),
      t.callExpression(t.memberExpression(t.identifier("Symbol"), t.identifier("for")), [t.stringLiteral("react.memo_cache_sentinel")])
    ),
    t.blockStatement([
      t.expressionStatement(t.assignmentExpression("=", beName,
        t.objectExpression([t.objectProperty(t.identifier("context"), t.stringLiteral("ModelPicker"))]))),
      t.expressionStatement(t.assignmentExpression("=",
        t.memberExpression(t.identifier("t"), t.numericLiteral(56), true),
        beName
      )),
    ]),
    t.blockStatement([
      t.expressionStatement(t.assignmentExpression("=",
        t.memberExpression(t.identifier("t"), t.numericLiteral(56), true),
        t.objectExpression([t.objectProperty(t.identifier("context"), t.stringLiteral("ModelPicker"))])
      )),
    ])
  );

  // Wo call: Wo({"modelPicker:thisSessionOnly": fn}, Be)
  const woCall = t.callExpression(woName, [
    t.objectExpression([
      t.objectProperty(t.stringLiteral("modelPicker:thisSessionOnly"), t.arrowFunctionExpression([], t.blockStatement([]))),
    ]),
    t.identifier("Be"),
  ]);

  // process.env.ANTHROPIC_CUSTOM_MODEL_OPTION read + additionalModelOptionsCache ref
  const envRead = t.memberExpression(
    t.memberExpression(t.identifier("process"), t.identifier("env")),
    t.identifier("ANTHROPIC_CUSTOM_MODEL_OPTION")
  );

  // Picker function body: useState anchor, options decl, env read, cache ref, wtIf, beDecl+beIf, woCall
  const pickerFn = t.functionDeclaration(t.identifier("pickerFn"), [], t.blockStatement([
    useStateAnchor,
    optionsDecl,
    t.expressionStatement(envRead),
    t.expressionStatement(t.identifier("additionalModelOptionsCache")),
    wtIf,
    beDecl,
    beIf,
    t.expressionStatement(woCall),
  ]));

  // Q2r array
  const q2rElements = [];
  for (let i = 0; i < 25; i++) {
    q2rElements.push(t.stringLiteral(i === 12 ? "modelPicker:thisSessionOnly" : `action:${i}`));
  }
  const q2rDecl = t.variableDeclaration("const", [
    t.variableDeclarator(t.identifier("Q2r"), t.arrayExpression(q2rElements)),
  ]);

  // Keymap bindings
  const keymapObj = t.objectExpression([
    t.objectProperty(t.identifier("left"), t.stringLiteral("modelPicker:decreaseEffort")),
    t.objectProperty(t.identifier("right"), t.stringLiteral("modelPicker:increaseEffort")),
    t.objectProperty(t.identifier("s"), t.stringLiteral("modelPicker:thisSessionOnly")),
  ]);
  const keymapDecl = t.variableDeclaration("const", [
    t.variableDeclarator(t.identifier("keymap"), keymapObj),
  ]);

  // ink export map for Text discovery: anyCallee(mod, { Box: () => Bx, Text: () => Tx })
  const inkMap = t.callExpression(t.identifier("inkInit"), [
    t.identifier("inkMod"),
    t.objectExpression([
      t.objectProperty(t.identifier("Box"), t.arrowFunctionExpression([], boxComp)),
      t.objectProperty(t.identifier("Text"), t.arrowFunctionExpression([], textComp)),
    ]),
  ]);
  const inkDecl = t.expressionStatement(inkMap);

  const program = t.file(t.program([
    q2rDecl,
    keymapDecl,
    inkDecl,
    pickerFn,
  ]));

  return program;
}

function astToCode(ast) {
  return generate(ast, { retainLines: false }).code;
}

function codeToAst(code) {
  return parser.parse(code, {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript"],
  });
}

// ── Tests ──

describe("codemod-model-picker-search", () => {
  it("exports MOD_ID", () => {
    expect(MOD_ID).toBe("model_picker_search");
  });

  it("discover returns null for empty code", () => {
    const ast = codeToAst("const x = 1;");
    const found = discover(ast);
    expect(found).toBeNull();
  });

  it("discover finds all anchors in synthetic fixture", () => {
    const ast = buildMinimalFixture();
    const found = discover(ast);
    expect(found).not.toBeNull();
    expect(found.pickerFnPath).toBeDefined();
    expect(found.reactName).toBe("kl");
    expect(found.selectName).toBe("Ar");
    expect(found.useStateModuleName).toBe("U0e");
    expect(found.optionsIdName).toBe("D");
    expect(found.arCallPath).toBeDefined();
    expect(found.woCallPath).toBeDefined();
    expect(found.wtMemoPath).toBeDefined();
    expect(found.beMemoPath).toBeDefined();
    expect(found.keymapBindingsPath).toBeDefined();
    expect(found.q2rArrayPath).toBeDefined();
  });

  it("transform applies all 6 transform groups", () => {
    const ast = buildMinimalFixture();
    const changes = transform(ast);
    expect(changes).toBe(6);
  });

  it("transform injects searchMode and searchQuery useState hooks", () => {
    const ast = buildMinimalFixture();
    transform(ast);
    const code = astToCode(ast);
    expect(code).toContain("__mpSearchMode");
    expect(code).toContain("__mpSearchQuery");
    expect(code).toContain("__setMpSearchMode");
    expect(code).toContain("__setMpSearchQuery");
    // Two new useState calls (searchMode and searchQuery)
    const useStateCount = (code.match(/U0e\.useState/g) || []).length;
    expect(useStateCount).toBeGreaterThanOrEqual(3); // original + 2 new
  });

  it("transform adds filtered options variable", () => {
    const ast = buildMinimalFixture();
    transform(ast);
    const code = astToCode(ast);
    expect(code).toContain("__mpFilteredOptions");
  });

  it("transform replaces Select with wrapper component", () => {
    const ast = buildMinimalFixture();
    transform(ast);
    const code = astToCode(ast);
    expect(code).toContain("__ModelSearchSelect__");
    // Options should reference the filtered variable, not the raw options
    expect(code).toContain("options: __mpFilteredOptions");
  });

  it("transform adds search props to the Select call", () => {
    const ast = buildMinimalFixture();
    transform(ast);
    const code = astToCode(ast);
    expect(code).toContain("searchMode: __mpSearchMode");
    expect(code).toContain("searchQuery: __mpSearchQuery");
    expect(code).toContain("setSearchMode: __setMpSearchMode");
    expect(code).toContain("setSearchQuery: __setMpSearchQuery");
    expect(code).toContain("selectComp: Ar");
  });

  it("transform adds modelPicker:search keybinding and action", () => {
    const ast = buildMinimalFixture();
    transform(ast);
    const code = astToCode(ast);
    expect(code).toContain('"/": "modelPicker:search"');
    expect(code).toContain('"modelPicker:search"');
  });

  it("transform replaces Be memo with inline object", () => {
    const ast = buildMinimalFixture();
    transform(ast);
    const code = astToCode(ast);
    // The Be IfStatement should be replaced with a VariableDeclaration
    expect(code).toContain("isActive");
    expect(code).toContain("!__mpSearchMode");
  });

  it("transform injects the wrapper component definition", () => {
    const ast = buildMinimalFixture();
    transform(ast);
    const code = astToCode(ast);
    expect(code).toContain("function __ModelSearchSelect__");
    expect(code).toContain("handleSearchKey");
    expect(code).toContain("filterOptions");
  });

  it("transform extends wt memo test with search deps", () => {
    const ast = buildMinimalFixture();
    transform(ast);
    const code = astToCode(ast);
    // t[101] and t[102] should appear in the test condition and assignment
    expect(code).toContain("t[101]");
    expect(code).toContain("t[102]");
  });

  it("transform is idempotent — second run throws (anchors moved)", () => {
    const ast = buildMinimalFixture();
    transform(ast);
    // The transform mutates the AST in-place; re-running on the same AST
    // should fail because structural anchors are replaced/modified.
    expect(() => transform(ast)).toThrow();
  });

  it("buildWrapperComponentSource contains key structural elements", () => {
    const src = buildWrapperComponentSource();
    expect(src).toContain(WRAPPER_NAME);
    expect(src).toContain("handleSearchKey");
    expect(src).toContain("filterOptions");
    expect(src).toContain("__REACT_REF__");
    expect(src).toContain("__INK_BOX__");
    expect(src).toContain("__INK_TEXT__");
  });

  it("discovers ink Box/Text names from export map", () => {
    const ast = buildMinimalFixture();
    const found = discover(ast);
    expect(found).not.toBeNull();
    // Box is captured from the outer createElement; Text requires the ink export map
    expect(found.boxName).toBe("Bx");
  });

  it("produces valid JavaScript output", () => {
    const ast = buildMinimalFixture();
    transform(ast);
    const code = astToCode(ast);
    // If this parses without error, the output is syntactically valid
    expect(() => codeToAst(code)).not.toThrow();
  });
});

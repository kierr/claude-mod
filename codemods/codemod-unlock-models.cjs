/**
 * Wrapper codemod for the unlock_models merge group.
 *
 * Chains: gateway-models-unfilter (Babel) then model-full-list (Babel).
 *
 * Both sub-codemods use the Babel engine. Marked as engine: "babel" so the
 * engine parses the AST once and shares it. This avoids redundant parsing
 * of the 25MB bundle (each parse costs ~646MB RSS and ~72s).
 */

const { transform: t1 } = require("./codemod-gateway-models-unfilter.cjs");
const { transform: t2 } = require("./codemod-model-full-list.cjs");
const generate = require("@babel/generator").default;

function transform(ast, code) {
  // Handle new regex-style callers that pass just (code)
  if (typeof ast === "string") {
    code = ast;
    const parser = require("@babel/parser");
    ast = parser.parse(code, {
      sourceType: "unambiguous",
      plugins: ["jsx", "typescript"],
    });
  }

  let n = 0;
  const r1 = t1(ast, code);
  if (r1) n += typeof r1 === "number" ? r1 : 1;
  const r2 = t2(ast, code);
  if (r2) n += typeof r2 === "number" ? r2 : 1;

  const output = generate(ast, { retainLines: false }, code).code;

  if (typeof code === "string" && arguments.length === 1) {
    return { code: output, changed: n };
  }
  return n;
}

module.exports = { transform };

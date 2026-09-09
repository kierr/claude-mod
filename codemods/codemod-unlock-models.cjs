/**
 * Wrapper codemod for the unlock_models merge group.
 *
 * Chains two Babel transforms: gateway-models-unfilter guards the
 * provider/env gates and removes the model filter, then model-full-list
 * injects the full model list into the model picker. Both mutate the
 * shared AST in place.
 */

const { transform: t1 } = require("./codemod-gateway-models-unfilter.cjs");
const { transform: t2 } = require("./codemod-model-full-list.cjs");

function transform(ast, code) {
  let n = 0;
  const r1 = t1(ast, code); if (r1) n += typeof r1 === "number" ? r1 : 1;
  const r2 = t2(ast, code); if (r2) n += typeof r2 === "number" ? r2 : 1;
  return n || 0;
}

module.exports = { transform };

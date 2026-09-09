/**
 * Wrapper codemod for the unlock_agent_models merge group.
 *
 * Chains two regex transforms: model-enum-to-string converts the
 * model enum to string(), then custom-model-descriptions injects
 * dynamic model descriptions from /v1/models. Both are regex-based
 * so the wrapper chains string output.
 */

const { transform: t1 } = require("./codemod-model-enum-to-string.cjs");
const { transform: t2 } = require("./codemod-custom-model-descriptions.cjs");

function transform(code) {
  const r1 = t1(code);
  const input = r1.changed > 0 ? r1.code : code;
  const r2 = t2(input);
  const finalCode = r2.changed > 0 ? r2.code : input;
  return { code: finalCode, changed: r1.changed + r2.changed };
}

module.exports = { transform };

/**
 * Wrapper codemod for the display_model_name merge group.
 *
 * Chains: agent-model-always-show (regex) → plan-exit-show-model (regex) →
 * teammate-list-show-model (regex).
 *
 * The subagent-show-model Babel sub-codemod is deferred — it times out on the
 * 25MB bundle (~130s traverse) and fails due to bundle drift. When it can be
 * converted to regex or the bundle structure stabilizes, it can be re-added.
 *
 * Exposes the regex contract: transform(code) → { code, changed }.
 */

const { transform: t1 } = require("./codemod-agent-model-always-show.cjs");
const { transform: t3 } = require("./codemod-plan-exit-show-model.cjs");
const { transform: t4 } = require("./codemod-teammate-list-show-model.cjs");

function transform(code) {
  let output = code;
  let total = 0;

  const r1 = t1(output);
  total += r1.changed;
  output = r1.code;

  const r3 = t3(output);
  total += r3.changed;
  output = r3.code;

  const r4 = t4(output);
  total += r4.changed;
  output = r4.code;

  return { code: output, changed: total };
}

module.exports = { transform };

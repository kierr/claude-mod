

const { transform: t1 } = require("./codemod-agent-model-always-show.cjs");
const { transform: t2 } = require("./codemod-subagent-show-model.cjs");
const { transform: t3 } = require("./codemod-plan-exit-show-model.cjs");
const { transform: t4 } = require("./codemod-teammate-list-show-model.cjs");

function transform(ast, code) {
  let n = 0;
  // Sub-codemods may return numbers or objects with a `changed` key.
  // Check .changed for object returns to get the actual count.
  function countChanges(r) {
    if (typeof r === "number") return r;
    if (r && typeof r.changed === "number") return r.changed;
    return r ? 1 : 0;
  }
  n += countChanges(t1(ast, code));
  n += countChanges(t2(ast, code));
  n += countChanges(t3(ast, code));
  n += countChanges(t4(ast, code));
  return n || 0;
}

module.exports = { transform };

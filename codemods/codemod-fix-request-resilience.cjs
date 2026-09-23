

const { transform: tRetry } = require("./codemod-retry-all-errors.cjs");
const { transform: tKnobs } = require("./codemod-persistent-knobs.cjs");
const { transform: tStatuses } = require("./codemod-retry-statuses.cjs");
const { transform: tFallback } = require("./codemod-fallback-loosen.cjs");

function transform(code) {
  const steps = [tRetry, tKnobs, tStatuses, tFallback];
  let out = code;
  let total = 0;
  for (const fn of steps) {
    const r = fn(out);
    if (r && r.changed > 0) {
      out = r.code;
      total += r.changed;
    }
  }
  return { code: out, changed: total };
}

module.exports = { transform };

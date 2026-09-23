/**
 * Wrapper codemod for the add_auth_forwarding merge group.
 *
 * Chains two regex transforms: auth-env-propagation adds auth env vars
 * to background session and tmux whitelists, then daemon-plist-auth
 * injects auth env vars into the daemon plist template. Both are
 * regex-based so the wrapper chains string output.
 */

const { transform: t1 } = require("./codemod-auth-env-propagation.cjs");
const { transform: t2 } = require("./codemod-daemon-plist-auth.cjs");

function transform(code) {
  const r1 = t1(code);
  const input = r1.changed > 0 ? r1.code : code;
  const r2 = t2(input);
  const finalCode = r2.changed > 0 ? r2.code : input;
  return { code: finalCode, changed: r1.changed + r2.changed };
}

module.exports = { transform };

#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const MOD_ID = "fix_request_resilience";
const HELPER = "__apiResRetryExtra__";

// Default to transient timeout/gateway statuses and specific transport-error messages.
// Do not retry every HTTP 400: ordinary validation errors must still fail.
var DEFAULT_STATUSES = "408,502,503,504";
var DEFAULT_PATTERNS = "Invalid HTTP request received,ConnectionInputs.RECV_DATA in state ConnectionState.CLOSED";

const HELPER_CODE =
  "function " + HELPER + "(_e) {\n" +
  "    try {\n" +
  "      if (typeof __isModEnabled__ !== \"function\" || !__isModEnabled__(\"" + MOD_ID + "\")) return false;\n" +
  "      if (typeof __getModConfig__ !== \"function\") return false;\n" +
  "      if (!_e) return false;\n" +
  "      var status = typeof _e.status === \"number\" ? _e.status : undefined;\n" +
  "      var msg = typeof _e.message === \"string\" ? _e.message : \"\";\n" +
  "      if (status !== undefined) {\n" +
  "        var list = __getModConfig__(\"" + MOD_ID + "\", \"retry_extra_statuses\", \"" + DEFAULT_STATUSES + "\");\n" +
  "        if (list && (\"\" + list).split(\",\").some(function(x) { var n = parseInt(x.trim(), 10); return !isNaN(n) && status === n; })) return true;\n" +
  "      }\n" +
  "      var pats = __getModConfig__(\"" + MOD_ID + "\", \"retry_extra_patterns\", \"" + DEFAULT_PATTERNS + "\");\n" +
  "      if (pats && msg && (\"\" + pats).split(\",\").some(function(p) { p = (\"\" + p).trim(); return p.length > 0 && msg.indexOf(p) >= 0; })) return true;\n" +
  "      return false;\n" +
  "    } catch (e) {\n" +
  "      return false;\n" +
  "    }\n" +
  "  }";

// Matches: function NAME(PARAM) { return FN(PARAM) || PARAM instanceof CLS && PARAM.status === 429; }
const LV7_PATTERN =
  /function\s+([\w$]+)\(([\w$]+)\)\s*\{\s*return\s+([\w$]+)\(\2\)\s*\|\|\s*\2\s+instanceof\s+([\w$]+)\s*&&\s*\2\.status\s*===\s*429\s*;\s*\}/;

function transform(code) {
  if (code.includes(HELPER + "(")) {
    return { code, changed: 0 };
  }
  const match = LV7_PATTERN.exec(code);
  if (!match) return { code, changed: 0 };

  const [, fnName, param, overloadedFn, errCls] = match;
  const replaced =
    HELPER_CODE +
    "\n  function " + fnName + "(" + param + ") {\n" +
    "    return " + overloadedFn + "(" + param + ") || " + param + " instanceof " + errCls + " && " + param + ".status === 429 || " + HELPER + "(" + param + ");\n" +
    "  }";
  const out = code.replace(LV7_PATTERN, function () { return replaced; });
  return { code: out, changed: out !== code ? 1 : 0 };
}

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-retry-statuses.cjs <input.js> [output.js]");
    process.exit(1);
  }
  const code = fs.readFileSync(path.resolve(inputFile), "utf8");
  const { code: output, changed } = transform(code);
  if (changed === 0) {
    console.error("No lv7 retryable-set function found; nothing changed.");
  } else {
    console.error("Broadened lv7 with retry_extra statuses+patterns helper.");
  }
  if (outputFile) {
    fs.writeFileSync(path.resolve(outputFile), output, "utf8");
  } else {
    process.stdout.write(output);
  }
}

module.exports = { transform };

if (require.main === module) {
  main();
}

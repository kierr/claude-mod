#!/usr/bin/env node
// Make persistent retry caps configurable while retaining the original constants when disabled or unset.

const fs = require("fs");
const path = require("path");

const MOD_ID = "fix_request_resilience";

const HELPER_CODE = `function __apiResCap__(_default) {
    try {
      if (typeof __isModEnabled__ !== "function" || !__isModEnabled__("${MOD_ID}")) return _default;
      if (typeof __getModConfig__ !== "function") return _default;
      var h = __getModConfig__("${MOD_ID}", "persistent_cap_hours", 6);
      return typeof h === "number" && h > 0 ? h * 3600000 : _default;
    } catch (e) {
      return _default;
    }
  }
  function __apiResBackoff__(_default) {
    try {
      if (typeof __isModEnabled__ !== "function" || !__isModEnabled__("${MOD_ID}")) return _default;
      if (typeof __getModConfig__ !== "function") return _default;
      var s = __getModConfig__("${MOD_ID}", "persistent_backoff_max_seconds", 0);
      return typeof s === "number" && s > 0 ? s * 1000 : _default;
    } catch (e) {
      return _default;
    }
  }`;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// pD3 function start: function NAME(H) { let VAR = H.headers?.get?.("anthropic-ratelimit-unified-reset");
const PD3_START =
  /(function\s+[\w$]+\([\w$]+\)\s*\{\s*let\s+[\w$]+\s*=\s+[\w$]+\.headers\?\.get\?\.\("anthropic-ratelimit-unified-reset"\);)/;

function transform(code) {
  if (code.includes("__apiResCap__(")) {
    return { code, changed: 0 };
  }

  const startMatch = PD3_START.exec(code);
  if (!startMatch) return { code, changed: 0 };

  // Discover the cap variable name from pD3's `return Math.min(K, CAPVAR);`.
  const window = code.slice(startMatch.index, startMatch.index + 800);
  const capMatch = /Math\.min\(([\w$]+),\s*([\w$]+)\)\s*;/.exec(window);
  if (!capMatch) return { code, changed: 0 };
  const capVar = capMatch[2];
  const capRe = escapeRe(capVar);

  let out = code;
  let changed = 0;

  // Inject helpers before pD3.
  out = out.replace(PD3_START, (m) => HELPER_CODE + "\n  " + m);
  changed++;

  // Shape B — persistent H26 sites: Math.min(HKH(a, b, BACKOFF), CAPVAR)
  // Wrap BACKOFF (3rd arg) and CAPVAR. There are two identical sites (429 + overloaded).
  const shapeB = new RegExp(
    "Math\\.min\\(([\\w$]+)\\(([\\w$]+),\\s*([\\w$]+),\\s*([\\w$]+)\\),\\s*(" + capRe + ")\\)",
    "g"
  );
  const bCount = (out.match(shapeB) || []).length;
  out = out.replace(shapeB, (m, callee, a, b, backoff) =>
    "Math.min(" + callee + "(" + a + ", " + b + ", __apiResBackoff__(" + backoff + ")), __apiResCap__(" + capVar + "))"
  );
  changed += bCount;

  // Shape A — pD3 site: Math.min(K, CAPVAR) → wrap CAPVAR only.
  const shapeA = new RegExp("Math\\.min\\(([\\w$]+),\\s*(" + capRe + ")\\)", "g");
  const aCount = (out.match(shapeA) || []).length;
  out = out.replace(shapeA, (m, v) => "Math.min(" + v + ", __apiResCap__(" + capVar + "))");
  changed += aCount;

  return { code: out, changed };
}

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-persistent-knobs.cjs <input.js> [output.js]");
    process.exit(1);
  }
  const code = fs.readFileSync(path.resolve(inputFile), "utf8");
  const { code: output, changed } = transform(code);
  if (changed === 0) {
    console.error("No persistent-retry cap/backoff sites found; nothing changed.");
  } else {
    console.error("Exposed persistent_cap_hours/persistent_backoff_max_seconds (%d site(s)).", changed);
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

#!/usr/bin/env node
// Place helpers inside the CommonJS wrapper so its require binding is available.
// Cache configuration briefly to avoid filesystem reads on every runtime guard.

const fs = require("fs");
const path = require("path");

// The runtime helper to inject. Uses var (not const/let) for broad compat.
// 2-second TTL cache keeps toggles responsive without excessive file reads.
// __REQUIRE_FN__ is replaced with the discovered require function name.
const HELPER_CODE = `
var __mods_cache__ = null;
var __mods_cache_time__ = 0;
function __modsLoad__() {
  var fs = __REQUIRE_FN__("fs");
  var path = __REQUIRE_FN__("path");
  var os = __REQUIRE_FN__("os");
  var now = Date.now();
  if (__mods_cache__ && (now - __mods_cache_time__) < 2000) {
    return __mods_cache__;
  }
  try {
    var configPath = path.join(
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
      "mods.json"
    );
    var data = JSON.parse(fs.readFileSync(configPath, "utf8"));
    __mods_cache__ = data;
    __mods_cache_time__ = now;
    return data;
  } catch (e) {
    __mods_cache__ = {};
    __mods_cache_time__ = now;
    return __mods_cache__;
  }
}
function __isModEnabled__(id) {
  return __modsLoad__()[id] === true;
}
function __getModConfig__(id, key, fallback) {
  var config = __modsLoad__();
  if (config[id] !== true) return undefined;
  var val = config[id + "_" + key];
  return val !== undefined ? val : fallback;
}
`;

/**
 * Find the CJS wrapper's opening brace and inject the runtime helpers
 * at position 0 inside it. The CJS wrapper is identified by the pattern:
 *   (function(exports, require, module, __filename, __dirname) {
 *
 * Discovers whether the require parameter is called "require" or something
 * else (minified), and substitutes __REQUIRE_FN__ accordingly.
 */
function transform(code) {
  // Idempotency: if __modsLoad__ already exists, skip
  if (code.includes("function __modsLoad__()")) {
    return { code, changed: 0 };
  }

  // Find CJS wrapper: (function(exports, require, module, __filename, __dirname) {
  // The require parameter name may be minified, so we match structurally.
  const wrapperPattern = /\(function\s*\(\s*exports\s*,\s*([\w$]+)\s*,\s*module\s*,\s*__filename\s*,\s*__dirname\s*\)\s*\{/;
  const match = code.match(wrapperPattern);

  if (!match) {
    // No CJS wrapper — ESM code-split binary. The runtime helpers
    // will be injected by the pipeline into cli.js instead.
    return { code, changed: 0 };
  }

  const requireFnName = match[1];
  const resolvedHelper = HELPER_CODE.replace(/__REQUIRE_FN__/g, requireFnName);

  // Find the opening brace position of the CJS wrapper body
  const bracePos = code.indexOf("{", match.index);
  if (bracePos === -1) return { code, changed: 0 };

  // Insert after the opening brace
  const insertPos = bracePos + 1;
  code = code.substring(0, insertPos) + resolvedHelper + code.substring(insertPos);

  return { code, changed: 1 };
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-inject-mods-runtime.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const { code: output, changed } = transform(code);

  if (changed === 0 && !code.includes("function __modsLoad__()")) {
    console.error("Warning: could not find injection target (no CJS wrapper); skipping mods runtime injection.");
  } else if (changed === 0) {
    console.error("Mods runtime helpers already present; skipping injection.");
  } else {
    console.error("Injected __isModEnabled__() and __getModConfig__() runtime helpers.");
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

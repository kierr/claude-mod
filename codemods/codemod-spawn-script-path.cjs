#!/usr/bin/env node
// Standalone Bun worker launches need the script path as well as process.execPath.
// Keep this adjustment paired with native_binary_compat, which enables native-mode branches.

const REQUIRED_CHANGES = 3;

const fs = require("fs");
const path = require("path");

// Default-ON guard: the spawn fix is correct for the patched-bun model, so it is enabled
// unless spawn_script_path is EXPLICITLY false in mods.json. This avoids depending on the
// key being present (new mods aren't auto-seeded into mods.json), so the fix is active
// right after install. Still toggleable: set "spawn_script_path": false to disable.
// Falls back to ON if mods_runtime (__modsLoad__) isn't loaded — the fix must not regress
// to the broken spawn just because a different mod is off.
const GUARD =
  'typeof __modsLoad__ !== "function" || __modsLoad__()["spawn_script_path"] !== false';

/**
 * Site 1 — QF() dispatch spawn: prefixArgs: [] → guarded [process.argv[1]].
 * Anchor: the native-binary branch `if (FN()) { return { cmd: process.execPath, prefixArgs: []`.
 */
function patchQF(code) {
  const re = /if \(([\w$]+)\(\)\) \{\n      return \{\n        cmd: process\.execPath,\n        prefixArgs: \[\]/;
  if (!re.test(code)) return { code, changed: 0 };
  code = code.replace(
    re,
    (m, fn) =>
      `if (${fn}()) {\n      return {\n        cmd: process.execPath,\n        prefixArgs: ${GUARD} ? [process.argv[1]] : []`,
  );
  return { code, changed: 1 };
}

/**
 * Site 2 — u3m() spare-pool spawn: return [process.execPath] → guarded.
 * Anchor: the unique literal `return [process.execPath];`.
 */
function patchU3m(code) {
  const re = /return \[process\.execPath\];/;
  if (!re.test(code)) return { code, changed: 0 };
  code = code.replace(
    re,
    `return ${GUARD} ? [process.execPath, process.argv[1]] : [process.execPath];`,
  );
  return { code, changed: 1 };
}

/**
 * Site 3 — posix_spawn TCC bg-worker: `let v = FN() ? [x] : [x, process.argv[1]]` → guarded.
 * Anchor: the `? [x] : [x, process.argv[1]]` ternary (backreference enforces same var x).
 */
function patchPosixSpawn(code) {
  const re = /let ([\w$]+) = ([\w$]+)\(\) \? \[([\w$]+)\] : \[\3, process\.argv\[1\]\];/;
  if (!re.test(code)) return { code, changed: 0 };
  code = code.replace(
    re,
    (m, v, fn, x) =>
      `let ${v} = ${GUARD} ? [${x}, process.argv[1]] : (${fn}() ? [${x}] : [${x}, process.argv[1]]);`,
  );
  return { code, changed: 1 };
}

function transform(code) {
  let totalChanged = 0;

  if (code.includes("__ssp_patched__")) {
    return { code, changed: 0 };
  }

  for (const fn of [patchQF, patchU3m, patchPosixSpawn]) {
    const r = fn(code);
    code = r.code;
    totalChanged += r.changed;
  }

  if (totalChanged >= REQUIRED_CHANGES) {
    const marker = "\nvar __ssp_patched__ = true;\n";
    const firstFunc = code.indexOf("function ");
    if (firstFunc > 0) {
      const secondFunc = code.indexOf("function ", firstFunc + 1);
      if (secondFunc > 0) {
        const insertPoint = code.lastIndexOf("\n", secondFunc) + 1;
        code = code.substring(0, insertPoint) + marker + code.substring(insertPoint);
      }
    }
  }

  return { code, changed: totalChanged };
}

/** CLI wrapper */
function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-spawn-script-path.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const { code: output, changed } = transform(code);

  if (changed === 0) {
    if (code.includes("__ssp_patched__")) {
      console.error("Spawn script path already applied; skipping.");
    } else {
      throw new Error("No matching spawn-argv targets found — bundle may have drifted.");
    }
  } else {
    console.error(`Patched ${changed} spawn-argv target(s): QF, u3m, posix_spawn.`);
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

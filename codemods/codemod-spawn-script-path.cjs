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
  // Monolithic pattern (multi-line, indented)
  const reMono = /if \(([\w$]+)\(\)\) \{\n      return \{\n        cmd: process\.execPath,\n        prefixArgs: \[\]/;
  if (reMono.test(code)) {
    code = code.replace(
      reMono,
      (_, fn) =>
        `if (${fn}()) {\n      return {\n        cmd: process.execPath,\n        prefixArgs: ${GUARD} ? [process.argv[1]] : []`,
    );
    return { code, changed: 1 };
  }

  // Code-split pattern: if(Bu())return{cmd:process.execPath,prefixArgs:[],target:process.execPath}
  const reCS = /if\(([\w$]+)\(\)\)return\{cmd:process\.execPath,prefixArgs:\[\],target:process\.execPath\}/;
  if (reCS.test(code)) {
    code = code.replace(
      reCS,
      (_, fn) =>
        `if(${fn}())return{cmd:process.execPath,prefixArgs:${GUARD}?[process.argv[1]]:[],target:process.execPath}`,
    );
    return { code, changed: 1 };
  }

  return { code, changed: 0 };
}

/**
 * Site 2 — u3m() spare-pool spawn: return [process.execPath] → guarded.
 * Anchor: the unique literal `return [process.execPath];`.
 */
function patchU3m(code) {
  // Monolithic pattern
  const reMono = /return \[process\.execPath\];/;
  if (reMono.test(code)) {
    code = code.replace(
      reMono,
      `return ${GUARD} ? [process.execPath, process.argv[1]] : [process.execPath];`,
    );
    return { code, changed: 1 };
  }

  // Code-split pattern: the che function has a branch that returns prefixArgs:[] after Bu() check
  // where the next branch already uses process.argv[1] via a local variable.
  // The u3m spare-pool is merged into che in code-split, so this is covered by patchQF's code-split branch.
  // But there may be a standalone return [process.execPath] in other code-split chunks.
  const reCS = /return\[process\.execPath,process\.argv\[1\]\]/;
  if (reCS.test(code)) {
    // Already patched or already has argv[1] — no change needed
    return { code, changed: 0 };
  }

  return { code, changed: 0 };
}

/**
 * Site 3 — posix_spawn TCC bg-worker: `let v = FN() ? [x] : [x, process.argv[1]]` → guarded.
 * Anchor: the `? [x] : [x, process.argv[1]]` ternary (backreference enforces same var x).
 */
function patchPosixSpawn(code) {
  // Monolithic pattern
  const reMono = /let ([\w$]+) = ([\w$]+)\(\) \? \[([\w$]+)\] : \[\3, process\.argv\[1\]\];/;
  if (reMono.test(code)) {
    code = code.replace(
      reMono,
      (_, v, fn, x) =>
        `let ${v} = ${GUARD} ? [${x}, process.argv[1]] : (${fn}() ? [${x}] : [${x}, process.argv[1]]);`,
    );
    return { code, changed: 1 };
  }

  // Code-split pattern: the che function's "if(!e)return{...prefixArgs:[],...}" branch
  // In code-split, process.argv[1] is already available as a local var (e), and the
  // "no argv[1]" branch returns prefixArgs:[]. The fix is to guard it with the mod guard.
  // Pattern: let e=process.argv[1];if(!e)return{cmd:process.execPath,prefixArgs:[],target:process.execPath};return{cmd:process.execPath,prefixArgs:[e],target:e}
  const reCSNoArgv = /(let\s+[\w$]+\s*=\s*process\.argv\[1\];if\(![\w$]+\)return\{cmd:process\.execPath,prefixArgs:)\[\]/;
  if (reCSNoArgv.test(code)) {
    code = code.replace(
      reCSNoArgv,
      (_, prefix) => `${prefix}${GUARD}?[process.argv[1]]:[]`,
    );
    return { code, changed: 1 };
  }

  return { code, changed: 0 };
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

  // In code-split, the three sites may be in one chunk (che function) or
  // split across chunks. Accept any positive change count.
  if (totalChanged > 0) {
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

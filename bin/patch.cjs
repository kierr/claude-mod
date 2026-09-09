#!/usr/bin/env node
/**
 * claude-mod CLI: downloads, patch builds, and installed launchers.
 * Installed copies remain independent of the build cache.
 */

const { spawn, execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { parseYAML } = require("../lib/utils.cjs");
const VERSION_FILE = path.join(__dirname, "..", "last-tested-version");

// RATIONALE: retain legacy state paths so existing pins and launcher targets
// survive the CLI rename. Reconsider only with an explicit state-migration protocol.
const CACHE_DIR = path.join(os.homedir(), ".cache", "claude-mods");
const PATCHES_DIR = path.join(__dirname, "..", "patches");

// Extraction-format floor, not a compatibility guarantee. Older packages use a
// different layout; last-tested-version identifies the verified release.
const MINIMUM_SUPPORTED_VERSION = "2.1.113";

// Default per-patch timeout in seconds (0 = no limit)
const DEFAULT_PATCH_TIMEOUT = 60;

const PINNED_VERSION_PATH = path.join(CACHE_DIR, "pinned-version.json");


// Pinned version state

function readPinnedVersion() {
  try {
    if (!fs.existsSync(PINNED_VERSION_PATH)) return null;
    return JSON.parse(fs.readFileSync(PINNED_VERSION_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writePinnedVersion(version, source, applied, total) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(PINNED_VERSION_PATH, JSON.stringify({
    version,
    pinnedAt: new Date().toISOString(),
    source,
    applied,
    total,
  }, null, 2), "utf8");
}

const SEMVER_RE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;

function resolveRunVersion() {
  const pinned = readPinnedVersion();
  // Legacy automatic pins were never an explicit choice of unsupported upstream.
  if (pinned?.source === "install" && SEMVER_RE.test(pinned.version)) return pinned.version;
  return validateVersion(fs.readFileSync(VERSION_FILE, "utf8").trim());
}

// Compare two semver strings (a < b → -1, a === b → 0, a > b → 1)
// Strips prerelease suffix before comparing so "2.1.113-beta" compares as "2.1.113".
function cmpSemver(a, b) {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

// Get platform-specific package name for >= 2.1.113 native binaries
function getPlatformPackageName() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin") {
    return `@anthropic-ai/claude-code-darwin-${arch}`;
  } else if (platform === "linux") {
    return `@anthropic-ai/claude-code-linux-${arch}`;
  } else if (platform === "win32") {
    return `@anthropic-ai/claude-code-win32-${arch}`;
  }
  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

// Check if a version is supported (>= MINIMUM_SUPPORTED_VERSION). All supported
// versions ship as native Bun binaries; older plain-JS-bundle versions are not.
function isSupportedVersion(version) {
  return cmpSemver(version, MINIMUM_SUPPORTED_VERSION) >= 0;
}

// Security: Validate version string is a valid semver (prevents command injection)
function validateVersion(version) {
  if (!SEMVER_RE.test(version)) {
    throw new Error(`Invalid version format: ${version}`);
  }
  return version;
}

// Security: Check a resolved path is under CACHE_DIR with valid version subdir
function isValidCacheSubdir(resolvedPath) {
  if (!resolvedPath.startsWith(CACHE_DIR + path.sep)) return false;
  const relative = path.relative(CACHE_DIR, resolvedPath);
  const parts = relative.split(path.sep);
  const versionRegex = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;
  if (!versionRegex.test(parts[0])) return false;
  return parts.length === 1 || (parts.length <= 3 && ["baseline", "patched", "node_modules"].includes(parts[1]));
}

// Install sharp native bindings for clipboard image support.
// Sharp is bundled in the CLI code but its platform-specific native bindings
// (@img/sharp-*) need to be installed separately. The patched CLI resolves
// them via require() at runtime. Without these, clipboard image paste fails
// with "No image found in clipboard."
const SHARP_VERSION = "0.34.5";

function getSharpPlatform() {
  const platform = process.platform;
  const arch = process.arch;
  // Musl detection: if linux and libc === "musl", use linuxmusl
  if (platform === "linux") {
    const isMusl = typeof process.report?.getReport === "function"
      && process.report.getReport()?.header?.glibcVersionRuntime === undefined;
    if (isMusl) return `linuxmusl-${arch}`;
  }
  return `${platform}-${arch}`;
}

function ensureSharpBindings(version, verbose = false) {
  const platform = getSharpPlatform();
  const cachePath = getCachePath(version);
  const sharpModuleDir = path.join(cachePath, "node_modules", "@img", `sharp-${platform}`);
  const sharpNodeFile = path.join(sharpModuleDir, "lib", `sharp-${platform}.node`);

  if (fs.existsSync(sharpNodeFile)) {
    if (verbose) console.log(`Sharp bindings already installed: @img/sharp-${platform}`);
    return;
  }

  console.log(`Installing sharp bindings: @img/sharp-${platform}@${SHARP_VERSION}...`);
  fs.mkdirSync(cachePath, { recursive: true });
  // Bun searches parents for a project. Own a dependency root rather than
  // installing into the user's home project or inheriting its lifecycle scripts.
  const dependencyManifest = path.join(cachePath, "package.json");
  if (!fs.existsSync(dependencyManifest)) {
    fs.writeFileSync(dependencyManifest, JSON.stringify({ name: "claude-mod-runtime", private: true }));
  }
  try {
    execFileSync("bun", ["i", "--no-save", "--ignore-scripts", `@img/sharp-${platform}@${SHARP_VERSION}`], {
      cwd: cachePath,
      stdio: verbose ? "inherit" : "pipe",
      timeout: 120000,
    });
    if (!fs.existsSync(sharpNodeFile)) throw new Error("Native module missing after installation");
    if (!verbose) console.log("Sharp bindings installed");
  } catch (error) {
    throw new Error(`Could not install sharp bindings: ${error.message}`);
  }
}

// Ensure shared baseline exists (download + deobfuscate)
function ensureBaseline(version, verbose = false) {
  const cliPath = downloadCLI(version, verbose);
  return deobfuscate(cliPath, verbose);
}

// Remove the native @bun-cjs header before running reformatted source.
// Pass CommonJS arguments explicitly into the wrapper under standalone Bun.
function fixBunCjsWrapper(patchedPath) {
  const content = fs.readFileSync(patchedPath, "utf8");

  // Regex codemods prepend idempotency markers (var __xxx_patched__ = true)
  // before the @bun header. Find the header wherever it appears near the top.
  const headerIdx = content.indexOf("// @bun @bytecode @bun-cjs");
  if (headerIdx === -1) {
    // Already fixed (shebang rewritten to #!/usr/bin/env bun) or only regex-codemod
    // markers present (var __xxx_patched__ = true). Both are expected no-op states for
    // supported (native-binary) versions — neither needs CJS wrapper fixing.
    if (!content.startsWith("#!/usr/bin/env bun") && !content.startsWith("var ")) {
      throw new Error("fixBunCjsWrapper: no @bun header found and no recognizable shebang or content prefix — unexpected file state");
    }
    return;
  }

  // Separate any prepended markers from the rest
  const prefix = content.substring(0, headerIdx);
  const afterHeader = content.substring(headerIdx);

  // Strip the @bun header line so Bun parses as regular JS
  let fixed = afterHeader.replace(/^\/\/ @bun[^\n]*\r?\n/, "");

  // Find the last `})` and replace from there with self-invocation that passes CJS args.
  const lastClose = fixed.lastIndexOf("})");
  if (lastClose === -1) {
    throw new Error("fixBunCjsWrapper: no closing `})` found in patched output");
  }
  // Verify the matched `})` is the IIFE close: only whitespace/newlines/semicolons should follow
  const tail = fixed.substring(lastClose + 2).replace(/[\s;]/g, "");
  if (tail.length > 0) {
    console.error(`Warning: unexpected content after IIFE close: ${tail.substring(0, 80)}`);
  }
  fixed = fixed.substring(0, lastClose) + "})(module.exports, require, module, __filename, __dirname);\n";

  // Re-attach the prepended markers after the shebang but before the IIFE
  fixed = "#!/usr/bin/env bun\n" + prefix + fixed;

  fs.writeFileSync(patchedPath, fixed);
  fs.chmodSync(patchedPath, 0o755);
}

// Copy baseline to patched dir for patching (fresh copy when stale)
function copyBaselineToPatched(baselinePath, version, verbose = false) {
  const patchedDir = path.join(CACHE_DIR, version, "patched");
  const patchedPath = path.join(patchedDir, "deobfuscated.js");
  fs.mkdirSync(patchedDir, { recursive: true });
  fs.copyFileSync(baselinePath, patchedPath);
  if (verbose) console.log(`Copied baseline to patched: ${patchedPath}`);
  return patchedPath;
}

// Parse CLI args (rawArgs optional override for testing)
function parseArgs(rawArgs) {
  const args = rawArgs || process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h" || command === "help") {
    return { command: "help" };
  }

  // Default: bare version arg (e.g. `patch.cjs 2.1.152`) means "patch"
  if (SEMVER_RE.test(command)) {
    const verbose = args.includes("--verbose") || args.includes("-v");
    const requireAll = args.includes("--require-all");
    const force = args.includes("--force");
    for (let i = 1; i < args.length; i++) {
      if (["--verbose", "-v", "--require-all", "--force"].includes(args[i])) continue;
      if (args[i].startsWith("--")) {
        throw new Error(`Unknown flag: ${args[i]}`);
      }
    }
    return {
      command: "patch",
      version: validateVersion(command),
      patches: getOrderedPatches(),
      verbose,
      requireAll,
      force,
    };
  }

  // `list` collapsed into `status --all` (kept as a compat shim).
  if (command === "list") {
    return { command: "status", all: true, deprecatedList: true };
  }

  if (command === "status") {
    // status [--all] [version]: --all collapses the old `list` command.
    const all = args.includes("--all");
    const positional = args.slice(1).filter((a) => !a.startsWith("-"));
    if (all) {
      if (positional.length > 0) {
        throw new Error("status --all takes no version argument");
      }
      return { command: "status", all: true };
    }
    const version = positional[0];
    if (!version) {
      throw new Error("version required for status command (or use status --all)");
    }
    return { command: "status", version: validateVersion(version) };
  }

  if (command === "clean") {
    const version = args[1];
    if (!version) {
      throw new Error("version required for clean command");
    }
    return { command: "clean", version: validateVersion(version) };
  }

  // update [version]: no version = packaged verified version. Patches, smoke-tests,
  if (command === "update") {
    // and promotes; the prior version dir stays for rollback.
    const positional = args.slice(1).filter((a) => !a.startsWith("-"));
    if (positional.length > 1) {
      throw new Error("update takes at most one version argument");
    }
    for (const a of args.slice(1)) {
      if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    }
    return {
      command: "update",
      version: positional.length === 1 ? validateVersion(positional[0]) : null,
    };
  }

  if (command === "doctor") {
    return { command: "doctor" };
  }

  if (command === "new-patch") {
    const id = args[1];
    if (!id) throw new Error("patch id required: new-patch <snake_case_id>");
    if (!/^[a-z][a-z0-9_]*$/.test(id)) {
      throw new Error(`invalid patch id "${id}" (lowercase snake_case required)`);
    }
    return { command: "new-patch", patchId: id };
  }

  if (command === "patch") {
    const version = args[1];
    if (!version) {
      throw new Error("version required for patch command");
    }

    const verbose = args.includes("--verbose") || args.includes("-v");
    const requireAll = args.includes("--require-all");
    const force = args.includes("--force");

    // Reject unknown flags and positional patch IDs
    for (let i = 2; i < args.length; i++) {
      if (["--verbose", "-v", "--require-all", "--force"].includes(args[i])) continue;
      if (args[i].startsWith("--")) {
        throw new Error(`Per-patch selection is not supported. The full patch set is always applied. Remove: ${args[i]}`);
      }
      if (!args[i].startsWith("-")) {
        throw new Error(`Per-patch selection is not supported. The full patch set is always applied. Remove: ${args[i]}`);
      }
    }

    return {
      command: "patch",
      version: validateVersion(version),
      patches: getOrderedPatches(),
      verbose,
      requireAll,
      force,
    };
  }

  if (command === "run") {
    const version = args[1] && !args[1].startsWith("-") ? args[1] : undefined;

    let verbose = false;
    let cliArgs = [];
    let foundSeparator = false;

    for (let i = version ? 2 : 1; i < args.length; i++) {
      if (foundSeparator) {
        cliArgs.push(args[i]);
      } else if (args[i] === "--") {
        foundSeparator = true;
      } else if (args[i] === "--verbose" || args[i] === "-v") {
        verbose = true;
      } else if (args[i].startsWith("--")) {
        throw new Error(`Per-patch selection is not supported. The full patch set is always applied. Remove: ${args[i]}`);
      } else if (!args[i].startsWith("-")) {
        throw new Error(`Per-patch selection is not supported. The full patch set is always applied. Remove: ${args[i]}`);
      }
    }

    return {
      command: "run",
      version: version ? validateVersion(version) : undefined,
      patches: getOrderedPatches(),
      cliArgs,
      verbose,
    };
  }

  if (command === "install") {
    const version = args[1];
    if (!version) throw new Error("version required for install command");
    return { command: "install", version: validateVersion(version) };
  }

  if (command === "uninstall") {
    return { command: "uninstall" };
  }

  throw new Error(`Unknown command: ${command}`);
}

// Get available patches
function getAvailablePatches() {
  if (!fs.existsSync(PATCHES_DIR)) return [];
  return fs.readdirSync(PATCHES_DIR)
    .filter(f => f.endsWith(".yaml"))
    .map(f => f.replace(".yaml", ""));
}

// Get ordered patches — reads each YAML's order field and sorts numerically.
function getOrderedPatches() {
  const patches = getAvailablePatches();

  return patches
    .map(id => {
      const yamlPath = path.join(PATCHES_DIR, `${id}.yaml`);
      try {
        const content = fs.readFileSync(yamlPath, "utf8");
        const parsed = parseYAML(content);
        const order = parsed.order != null ? Number(parsed.order) : 50;
        return { id, order: Number.isInteger(order) ? order : 50 };
      } catch (error) {
        throw new Error(`Failed to parse patch order for "${id}": ${error.message}`);
      }
    })
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map(p => p.id);
}

// Get cache path for a version
function getCachePath(version) {
  return path.join(CACHE_DIR, version);
}

// Check if version is cached
function isCached(version) {
  const cachePath = getCachePath(version);
  const cliPath = path.join(cachePath, "cli.js");
  return fs.existsSync(cliPath);
}

// Download CLI for a version using npm pack. Supported versions (>= 2.1.113)
// download a platform-specific native Bun binary and extract its JS.
function downloadCLI(version, verbose = false) {
  if (!isSupportedVersion(version)) {
    console.error(
      `Version ${version} is below the minimum supported version (2.1.113); ` +
      `Claude Code < 2.1.113 shipped as a plain JS bundle and is no longer supported.`
    );
    process.exit(1);
  }

  const cachePath = getCachePath(version);
  const cliPath = path.join(cachePath, "cli.js");

  if (fs.existsSync(cliPath)) {
    if (verbose) console.log(`CLI already cached: ${cliPath}`);
    return cliPath;
  }

  const packageName = getPlatformPackageName();

  console.log(`Downloading Claude Code ${version} (${packageName})...`);
  fs.mkdirSync(cachePath, { recursive: true });

  let tmpDir;
  try {
    // Fail fast: native binary extraction does not support Windows.
    // Inside try/catch so the error gets the friendly handler below
    // instead of an uncaught stack trace.
    if (process.platform === "win32") {
      throw new Error(
        "Native binary extraction is not supported on Windows. " +
        "Claude Code >= 2.1.113 ships as platform-specific native Bun binaries; " +
        "Windows binaries require a different extraction approach."
      );
    }

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-download-"));

    execFileSync("bunx", ["npm", "pack", `${packageName}@${version}`], {
      stdio: "inherit",
      cwd: tmpDir
    });

    const tarball = fs.readdirSync(tmpDir).find(f => f.endsWith(".tgz"));
    if (!tarball) {
      throw new Error("Tarball not found after pack");
    }

    const tarballPath = path.join(tmpDir, tarball);
    execFileSync("tar", ["xzf", tarballPath, "-C", tmpDir], { stdio: "inherit" });

    const extractedDir = fs.readdirSync(tmpDir).find(f =>
      f.startsWith("package") && fs.statSync(path.join(tmpDir, f)).isDirectory()
    );
    if (!extractedDir) {
      throw new Error("Extracted package directory not found");
    }

    // Native binary: extract JS from __BUN section
    const binaryName = process.platform === "win32" ? "claude.exe" : "claude";
    const binaryPath = path.join(tmpDir, extractedDir, binaryName);

    if (!fs.existsSync(binaryPath)) {
      throw new Error(`Native binary not found: ${binaryPath}`);
    }

    if (verbose) console.log(`Extracting JS from native binary...`);

    const extractScript = path.join(__dirname, "extract-js-from-bun-binary.cjs");
    execFileSync("node", [extractScript, binaryPath, cliPath], {
      stdio: verbose ? "inherit" : "pipe",
    });

    console.log(`Downloaded: ${cliPath}`);
    return cliPath;
  } catch (error) {
    console.error(`Error downloading CLI: ${error.message}`);
    if (fs.existsSync(cachePath)) {
      try {
        fs.rmSync(cachePath, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error(`Warning: Could not clean up cache: ${cleanupError.message}`);
      }
    }
    process.exit(1);
  } finally {
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Non-critical — OS will reclaim tmpdir eventually
      }
    }
  }
}

// Deobfuscate CLI using webcrack
function deobfuscate(cliPath, verbose = false) {
  const cachePath = path.dirname(cliPath);
  // baseline/ replaces the old deobfuscated/ as the read-only deobfuscated output
  const deobfuscatedDir = path.join(cachePath, "baseline");
  const deobfuscatedPath = path.join(deobfuscatedDir, "deobfuscated.js");

  if (fs.existsSync(deobfuscatedPath)) {
    const sourceStat = fs.statSync(cliPath);
    const outputStat = fs.statSync(deobfuscatedPath);
    if (outputStat.mtime > sourceStat.mtime) {
      if (verbose) console.log(`Already deobfuscated: ${deobfuscatedPath}`);
      return deobfuscatedPath;
    }
  }

  console.log(`Deobfuscating... (this takes ~1 minute)`);
  const webcrackScript = path.join(__dirname, "webcrack-pipeline.cjs");

  // webcrack writes directly to baseline/
  try {
    execFileSync("node", [webcrackScript, cliPath, "--output-dir", deobfuscatedDir], {
      stdio: verbose ? "inherit" : "pipe",
    });
  } catch (error) {
    console.error("Error: Webcrack failed");
    console.error(`Details: ${error.message}`);
    process.exit(1);
  }

  if (!fs.existsSync(deobfuscatedPath)) {
    console.error(`Error: Deobfuscated file not found: ${deobfuscatedPath}`);
    process.exit(1);
  }

  return deobfuscatedPath;
}

// Apply patches to deobfuscated code
function applyPatches(deobfuscatedPath, patches, verbose = false, timeout = 0) {
  const batchApplyScript = path.join(__dirname, "batch-apply.cjs");

  if (!verbose) {
    console.log(`Applying ${patches.length} patches (batch)...`);
  }

  const childArgs = [batchApplyScript, deobfuscatedPath, ...patches];
  if (verbose) childArgs.push("--verbose");
  if (timeout > 0) childArgs.push(`--timeout=${timeout}`);

  // Capture stderr on success: it carries SKIPPED_PATCHES for --require-all.
  // Set the child heap floor before Babel parses; retain an explicit caller heap setting.
  const childEnv = { ...process.env };
  if (!childEnv.NODE_OPTIONS || !childEnv.NODE_OPTIONS.includes("--max-old-space-size")) {
    childEnv.NODE_OPTIONS = `${childEnv.NODE_OPTIONS || ""} --max-old-space-size=8192`.trim();
  }
  const child = spawnSync("node", childArgs, {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    env: childEnv,
  });

  const stdout = child.stdout || "";
  const stderr = child.stderr || "";

  if (stdout) process.stdout.write(stdout);
  // batch-apply emits per-patch status to stderr in verbose mode and
  // structured markers (SKIPPED_PATCHES, FAILED_PATCHES) always to stderr.
  if (stderr && verbose) process.stderr.write(stderr);

  // Extract skipped patch names from the SKIPPED_PATCHES: marker
  const skippedMatch = stderr.match(/SKIPPED_PATCHES:([^\n]+)/);
  const skippedPatchNames = skippedMatch ? skippedMatch[1].split(",").filter(Boolean) : [];

  if (child.error) {
    console.error(`batch-apply spawn failed: ${child.error.message}`);
    return { deobfuscatedPath, applied: 0, failed: 1, skippedPatchNames };
  } else if (child.status === 0) {
    const appliedCount = stdout.split("\n").filter(l => l.includes("✓")).length;
    return { deobfuscatedPath, applied: appliedCount, failed: 0, skippedPatchNames };
  } else if (child.status === 2) {
    return { deobfuscatedPath, applied: 0, failed: 0, noop: true, skippedPatchNames };
  } else {
    if (stderr && !verbose) console.error(stderr.trim());
    const combined = stdout + "\n" + stderr;
    const appliedCount = combined.split("\n").filter(l => l.includes("✓")).length;
    const failedCount = combined.split("\n").filter(l => l.includes("✗")).length;
    return { deobfuscatedPath, applied: appliedCount, failed: failedCount || 1, skippedPatchNames };
  }
}

// Cache successful output by baseline and patch-set hashes. --force bypasses
// this patch-stage cache; download and deobfuscation have separate freshness checks.
const { sha256File, patchSetFingerprint, stampArtifact, validateArtifact } = require("../lib/artifact.cjs");

function manifestCurrent(version, baselinePath) {
  const dir = path.join(getCachePath(version), "patched");
  try {
    const manifest = validateArtifact(dir, version);
    if (manifest.baselineSha !== sha256File(baselinePath)) return null;
    return { patchedPath: path.join(dir, "deobfuscated.js"), manifest };
  } catch { return null; }
}

function ensurePatched(version, patches, verbose, timeout, force = false) {
  const t0 = Date.now();
  const fmtDur = (ms) => (ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`);
  // Estimate from the previous run's timings (Tier 0 progress UI).
  if (!verbose && !force) {
    try {
      const prev = JSON.parse(fs.readFileSync(path.join(getCachePath(version), "timings.json"), "utf8"));
      if (prev && prev.total) console.log(`Estimate: ~${fmtDur(prev.total * 1000)} (last run)`);
    } catch { /* first run — no estimate */ }
  }
  const tFetch = Date.now();
  const baselinePath = ensureBaseline(version, verbose);
  const fetchMs = Date.now() - tFetch;
  // Manifest skip: inputs unchanged since the last successful run.
  if (!force) {
    const hit = manifestCurrent(version, baselinePath);
    if (hit) {
      if (!verbose) console.log(`${hit.manifest.applied}/${patches.length} already applied (manifest ✓; ${hit.manifest.skipped.length} skipped)`);
      return {
        patchedPath: hit.patchedPath,
        result: { noop: true, applied: hit.manifest.applied, failed: 0, skippedPatchNames: hit.manifest.skipped },
        skipped: false,
      };
    }
  }
  const tStage = Date.now();
  // Invalidate before touching output: failed forced rebuilds must not inherit success.
  fs.rmSync(path.join(getCachePath(version), "patched", "manifest.json"), { force: true });
  const patchedPath = copyBaselineToPatched(baselinePath, version, verbose);
  const stageMs = Date.now() - tStage;
  const tPatch = Date.now();
  const result = applyPatches(patchedPath, patches, verbose, timeout);
  const patchMs = Date.now() - tPatch;

  if (!result || result.failed !== 0) {
    throw new Error(`Patch build failed (${result?.failed ?? "unknown"}); refusing partial output`);
  }
  fixBunCjsWrapper(patchedPath);
  const totalMs = Date.now() - t0;
  try {
    fs.writeFileSync(path.join(getCachePath(version), "timings.json"), JSON.stringify({
      fetch: Math.round(fetchMs / 1000), stage: Math.round(stageMs / 1000),
      patch: Math.round(patchMs / 1000), total: Math.round(totalMs / 1000),
      at: new Date().toISOString(),
    }, null, 2));
  } catch { /* timing persistence is advisory */ }
  if (!verbose) {
    console.log(`  stages: fetch ${fmtDur(fetchMs)} · patch ${fmtDur(patchMs)} · total ${fmtDur(totalMs)}`);
  }
  if (result && result.failed === 0) {
    stampArtifact(path.dirname(patchedPath), version, {
      baselineSha: sha256File(baselinePath),
      patchSetSha: patchSetFingerprint(),
      applied: result.applied || 0,
      skipped: result.skippedPatchNames || [],
    });
  }
  return { patchedPath, result, skipped: false };
}

// Run the patched CLI
function runPatched(version, cliArgs, verbose = false, patches = null) {
  const wasCached = fs.existsSync(path.join(getCachePath(version), "cli.js"));
  const wasDeobfuscated = fs.existsSync(path.join(getCachePath(version), "baseline", "deobfuscated.js"));
  if (!patches) patches = getOrderedPatches();

  // Compact pipeline header
  if (!verbose) {
    const parts = [`claude-mod ${version}`];
    parts.push(wasCached ? "cached ✓" : "downloaded ✓");
    parts.push(wasDeobfuscated ? "deobfuscated ✓" : "deobfuscating...");
    console.log(parts.join(" — "));
  }

  const { patchedPath, result } = ensurePatched(version, patches, verbose, DEFAULT_PATCH_TIMEOUT);

  if (result && result.failed > 0) {
    throw new Error(`Refusing to run ${result.failed} failed patch(es)`);
  }
  if (result) {
    if (result.noop) {
      if (!verbose) console.log(`${result.applied}/${patches.length} already applied`);
    } else if (result.applied > 0 && !verbose) {
      console.log(`${result.applied}/${patches.length} applied`);
    }
  }

  // Install sharp native bindings for clipboard image support
  ensureSharpBindings(version, verbose);

  if (verbose) {
    console.log(`\nRunning Claude Code ${version}`);
    if (cliArgs.length > 0) {
      console.log(`Args: ${cliArgs.join(" ")}`);
    }
    console.log("");
  }

  if (!fs.existsSync(patchedPath)) {
    console.error(`Error: Patched file not found: ${patchedPath}`);
    console.error(`Try running: bun bin/patch.cjs patch ${version}`);
    process.exit(1);
  }

  const resolved = path.resolve(patchedPath);
  if (!isValidCacheSubdir(resolved)) {
    throw new Error(`Invalid cache path: ${patchedPath}`);
  }

  // Run under Bun — the patched binary targets Bun APIs natively.
  // The @bun header has been stripped and the IIFE now self-invokes with CJS args.
  const childCmd = "bun";
  const childArgs = [resolved, ...cliArgs];

  const child = spawn(childCmd, childArgs, {
    stdio: "inherit",
    env: { ...process.env },
  });

  child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", (code) => {
    process.exit(code ?? 1);
  });
}

// Clean cached version
function cleanVersion(version) {
  const cachePath = getCachePath(version);
  if (!isValidCacheSubdir(path.resolve(cachePath))) {
    throw new Error(`Invalid cache path: ${cachePath}`);
  }

  if (fs.existsSync(cachePath)) {
    fs.rmSync(cachePath, { recursive: true, force: true });
    console.log(`Removed cache for version ${version}`);
  } else {
    console.log(`Version ${version} not cached.`);
  }
}

// List cached versions
function listVersions() {
  if (!fs.existsSync(CACHE_DIR)) {
    console.log("No cached versions.");
    return;
  }

  const entries = fs.readdirSync(CACHE_DIR).filter(v => {
    const vPath = path.join(CACHE_DIR, v);
    return fs.statSync(vPath).isDirectory();
  });

  if (entries.length === 0) {
    console.log("No cached versions.");
    return;
  }

  console.log("Cached versions:");
  for (const entry of entries.sort()) {
    if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(entry)) continue;

    const cachePath = path.join(CACHE_DIR, entry);
    const cliPath = path.join(cachePath, "cli.js");
    const baselinePath = path.join(cachePath, "baseline", "deobfuscated.js");
    const patchedPath = path.join(cachePath, "patched", "deobfuscated.js");

    let status = "";
    if (fs.existsSync(patchedPath)) {
      status = " (patched)";
    } else if (fs.existsSync(baselinePath)) {
      status = " (deobfuscated)";
    } else if (fs.existsSync(cliPath)) {
      status = " (downloaded)";
    }

    console.log(`  ${entry}${status}`);
  }
}

// Show status of a cached version
function showStatus(version) {
  const cachePath = getCachePath(version);
  const cliPath = path.join(cachePath, "cli.js");
  const baselinePath = path.join(cachePath, "baseline", "deobfuscated.js");
  const patchedPath = path.join(cachePath, "patched", "deobfuscated.js");

  console.log(`Version: ${version}`);
  console.log(`Cache path: ${cachePath}`);
  console.log("");

  if (!fs.existsSync(cachePath)) {
    console.log("Status: NOT CACHED");
    return;
  }

  if (fs.existsSync(cliPath)) {
    const size = Math.round(fs.statSync(cliPath).size / 1024);
    console.log(`  cli.js: ${size} KB`);
  }
  if (fs.existsSync(baselinePath)) {
    const size = Math.round(fs.statSync(baselinePath).size / 1024);
    let lines;
    try {
      const raw = execFileSync("wc", ["-l", baselinePath], { encoding: "utf8" }).trim();
      const parsed = Number(raw.split(/\s+/)[0]);
      if (!Number.isFinite(parsed)) throw new Error(`Unexpected wc output: ${raw}`);
      lines = parsed;
    } catch {
      console.warn("  wc -l failed, falling back to split() for line count");
      lines = fs.readFileSync(baselinePath, "utf8").split("\n").length - 1;
    }
    console.log(`  baseline: ${size} KB, ${lines.toLocaleString()} lines`);
  }
  if (fs.existsSync(patchedPath)) {
    const size = Math.round(fs.statSync(patchedPath).size / 1024);
    console.log(`  patched: ${size} KB`);
  }

  console.log("\nAvailable patches:");
  for (const patch of getAvailablePatches()) {
    console.log(`  - ${patch}`);
  }
}


// Print help
function printHelp() {
  console.log(`
claude-mod - Patch Claude Code CLI locally for third-party providers

Usage:
  claude-mod <version>                # Shorthand: download, deobfuscate, patch
  claude-mod <command> [options]

Commands:
  <version>                            Download, deobfuscate, and apply all patches
  patch <version>                      Same as bare <version>
  install <version>                    Install patched binary as system claude
  update [version]                     Patch verified release (or version), smoke-test, promote
  run [version] [--] [cli-args...]     Run patched CLI (auto-resolves version if omitted)
  clean <version>                      Remove cached version
  status <version>                     Show status of cached version
  status --all                         List cached versions (replaces \`list\`)
  uninstall                            Remove system claude symlink
  doctor                               Sanity-check bun, cache, live symlink, extractor tools
  new-patch <snake_id>                 Scaffold YAML + codemod + test for a new patch

Options:
  --verbose, -v             Show detailed step-by-step output (default: compact)
  --require-all             Fail if any patch is not applicable (for CI gates)
  --force                   Re-patch even when the manifest says current

Examples:
  claude-mod 2.1.181                  # Shorthand: patch 2.1.181
  claude-mod update                   # Verified release → patch → smoke → promote
  claude-mod install 2.1.181
  claude-mod run 2.1.181 -- --help
  claude-mod status --all
  claude-mod doctor
  claude-mod new-patch my_feature_gate

Available patches:
${getAvailablePatches().map(p => `  - ${p}`).join("\n")}

Cache directory: ${CACHE_DIR}
`);
}


module.exports = {
  parseArgs,
  getAvailablePatches,
  getOrderedPatches,
  getPlatformPackageName,
  isSupportedVersion,
  readPinnedVersion,
  writePinnedVersion,
  resolveRunVersion,
  fixBunCjsWrapper,
  getSharpPlatform,
  ensureSharpBindings,
};

const INSTALL_BIN = path.join(os.homedir(), ".local", "bin", "claude");
const CURRENT_SYMLINK = path.join(CACHE_DIR, "current");

// Keep installed versions independent of caches that may be evicted or unmounted.
const LOCAL_INSTALL_ROOT = path.join(os.homedir(), ".local", "lib", "claude-mods");
const LOCAL_CURRENT = path.join(LOCAL_INSTALL_ROOT, "current");

const { createInstaller } = require("../lib/installation.cjs");
const installer = createInstaller({
  home: os.homedir(), cacheDir: CACHE_DIR, validateArtifact,
  ensureSharpBindings, getSharpPlatform, writePinnedVersion,
});
const installVersion = installer.install;
const uninstallClaude = installer.uninstall;

// update defaults to the packaged verified version. Installation owns preflight
// and promotion; retained live copies support rollback after cache eviction.
function updateCommand(version) {
  installer.assertLauncher();
  const target = version || validateVersion(fs.readFileSync(VERSION_FILE, "utf8").trim());
  const pinned = readPinnedVersion();
  const prior = pinned && pinned.version ? pinned.version : null;
  if (prior && prior === target) {
    console.log(`Already on latest verified build: ${target}`);
  }
  console.log(`Updating to ${target}${prior ? ` (prior: ${prior})` : ""}...`);
  const { patchedPath, result } = ensurePatched(target, getOrderedPatches(), false, DEFAULT_PATCH_TIMEOUT * 2);
  if (!patchedPath || (result && result.failed > 0)) {
    console.error(`update aborted: patch step failed for ${target}`);
    process.exit(1);
  }
  // Installation validates the copied runtime and bindings before promotion.
  installVersion(target);
  if (prior && prior !== target) {
    console.log(`Rollback if needed: claude-mod install ${prior}`);
  }
}

// doctor: sanity-check the machine for patch/install/run. Required gaps
// exit non-zero; advisories print as warnings.
function doctorCommand() {
  let ok = true;
  const need = (label, fn) => {
    try {
      const detail = fn();
      console.log(`ok   ${label}${detail ? ` (${detail})` : ""}`);
    } catch (err) {
      ok = false;
      console.log(`FAIL ${label}: ${err.message}`);
    }
  };
  const advise = (label, fn) => {
    try {
      const detail = fn();
      console.log(`ok   ${label}${detail ? ` (${detail})` : ""}`);
    } catch (err) {
      console.log(`warn ${label}: ${err.message}`);
    }
  };
  need("bun runtime", () => execFileSync("bun", ["--version"], { encoding: "utf8" }).trim());
  need("node runtime >= 22 (webcrack/isolated-vm)", () => {
    const major = parseInt(process.versions.node.split(".")[0], 10);
    if (major < 22) throw new Error(`${process.version} — install Node.js 22+ (https://nodejs.org)`);
    return process.version;
  });
  need("cache dir writable", () => {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.accessSync(CACHE_DIR, fs.constants.W_OK);
    return CACHE_DIR;
  });
  if (process.platform === "darwin") {
    need("otool (native-binary extraction)", () =>
      execFileSync("which", ["otool"], { encoding: "utf8" }).trim());
  } else if (process.platform === "linux") {
    need("objcopy (native-binary extraction)", () =>
      execFileSync("which", ["objcopy"], { encoding: "utf8" }).trim());
  }
  advise("live install", () => {
    const cur = fs.realpathSync(LOCAL_CURRENT);
    const js = path.join(cur, "deobfuscated.js");
    fs.accessSync(js, fs.constants.X_OK);
    return cur;
  });
  advise("pinned version", () => {
    const pinned = readPinnedVersion();
    if (!pinned || !pinned.version) throw new Error("none (install a version first)");
    return `${pinned.version} via ${pinned.source}`;
  });
  advise("PATH webcrack (clean-room deobfuscation)", () => {
    try {
      execFileSync("which", ["webcrack"], { stdio: "pipe" });
      return "present (preferred over bunx/npx)";
    } catch {
      throw new Error("absent — clean-room deobfuscation may fail; npm i -g webcrack@2.15.1");
    }
  });
  try {
    console.log(`ok   last-tested-version (${fs.readFileSync(VERSION_FILE, "utf8").trim()})`);
  } catch {
    console.log("warn last-tested-version file unreadable");
  }
  if (!ok) {
    console.error("\ndoctor: required gaps found — fix the FAIL lines above.");
    process.exit(1);
  }
  console.log("\ndoctor: all required checks pass.");
}

// new-patch <id>: scaffold YAML + regex codemod + unit test from templates.
// The scaffold compiles and fails closed (changed: 0 until anchors are
// filled); CONTRIBUTING.md describes the requirements.
function newPatchCommand(id) {
  const kebab = id.replace(/_/g, "-");
  const repoRoot = path.join(__dirname, "..");
  const yamlPath = path.join(PATCHES_DIR, `${id}.yaml`);
  const codemodPath = path.join(repoRoot, "codemods", `codemod-${kebab}.cjs`);
  const testPath = path.join(repoRoot, "test", "unit", `codemod-${kebab}.test.js`);
  for (const [label, p] of [["YAML", yamlPath], ["codemod", codemodPath], ["test", testPath]]) {
    if (fs.existsSync(p)) {
      console.error(`Error: ${label} already exists: ${p}`);
      process.exit(1);
    }
  }
  const yaml = `id: "${id}"
target: "claude-code"
name: "TODO Human Name"
description: "TODO what this patch does and why"
file_id: "cli"
order: 50
status_tests:
  # applied: regex matching the POST-patch state (must contain a change marker).
  # applicable: regex matching the PRE-patch state (stable structural anchor).
  # Match stable structure; identifier patterns must allow $ as well as word characters.
  applied: 'TODO_APPLIED_MARKER'
  applicable: 'TODO_APPLICABLE_ANCHOR'
codemod:
  type: "node_script"
  engine: "regex"
  script: "codemods/codemod-${kebab}.cjs"
mod:
  live: true
  category: "features"
`;
  const codemod = `#!/usr/bin/env node
/**
 * TODO: describe the change and its stable structural anchors.
 * Use an AST or the shared delimiter scanner for function boundaries,
 * not an unbounded body regex. See CONTRIBUTING.md.
 * Return { code, changed }; report changed: 0 when no target matches.
 */
const fs = require("fs");
const path = require("path");

const MOD_ID = "${id}";

function transform(code) {
  // TODO: implement the transform; keep the __isModEnabled__ guard shape:
  // if (typeof __isModEnabled__ === "function" && __isModEnabled__("${id}")) { ... }
  return { code, changed: 0 };
}

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-${kebab}.cjs <input.js> [output.js]");
    process.exit(1);
  }
  const code = fs.readFileSync(path.resolve(inputFile), "utf8");
  const { code: output, changed } = transform(code);
  if (outputFile) fs.writeFileSync(path.resolve(outputFile), output, "utf8");
  else process.stdout.write(output);
  console.error(changed === 0 ? "No match; nothing changed." : \`Applied (\${changed} site(s)).\`);
}

module.exports = { transform };

if (require.main === module) {
  main();
}
`;
  const test = `import { describe, it, expect } from "bun:test";
import path from "path";

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-${kebab}.cjs");
const { transform } = require(CODEMOD_PATH);

describe("codemod-${id}", () => {
  it("fails closed on unrelated code", () => {
    const { code, changed } = transform("var a = 1;\\n");
    expect(changed).toBe(0);
    expect(code).toContain("var a = 1;");
  });

  // TODO: add minified-name resilience cases (same shape, different
  // identifiers) and a status_test round-trip per CONTRIBUTING.md.
});
`;
  fs.writeFileSync(yamlPath, yaml);
  fs.writeFileSync(codemodPath, codemod, { mode: 0o755 });
  fs.writeFileSync(testPath, test);
  console.log(`Scaffolded patch "${id}":`);
  console.log(`  ${yamlPath}`);
  console.log(`  ${codemodPath}`);
  console.log(`  ${testPath}`);
  console.log(`Next: fill the anchors (see CONTRIBUTING.md), then run the test file.`);
}

// Main
function main() {
  let args;
  try {
    args = parseArgs();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  switch (args.command) {
    case "help":
      printHelp();
      break;

    case "clean":
      cleanVersion(args.version);
      break;

    case "status":
      if (args.deprecatedList) {
        console.error("Note: `list` was collapsed into `status --all`.");
      }
      if (args.all) listVersions();
      else showStatus(args.version);
      break;

    case "patch": {
      const wasCached = fs.existsSync(path.join(getCachePath(args.version), "cli.js"));
      const wasDeobfuscated = fs.existsSync(path.join(getCachePath(args.version), "baseline", "deobfuscated.js"));

      // Compact pipeline header
      if (!args.verbose) {
        const parts = [`claude-mod ${args.version}`];
        parts.push(wasCached ? "cached ✓" : "downloaded ✓");
        parts.push(wasDeobfuscated ? "deobfuscated ✓" : "deobfuscating...");
        console.log(parts.join(" — "));
      }

      const { patchedPath, result } = ensurePatched(
        args.version, args.patches, args.verbose, DEFAULT_PATCH_TIMEOUT * 2, args.force
      );

      if (result) {
        if (result.failed > 0) {
          console.error(`Warning: ${result.failed} patch(es) failed`);
        }
        // Patch names extracted from SKIPPED_PATCHES marker in batch-apply stderr.
        const skippedPatches = result.skippedPatchNames || [];
        if (skippedPatches.length > 0) {
          if (args.requireAll) {
            console.error(`Error: ${skippedPatches.length} patch(es) not applicable: ${skippedPatches.join(", ")}`);
          } else {
            console.error(`Warning: ${skippedPatches.length} patch(es) not applicable: ${skippedPatches.join(", ")}`);
          }
        }
        if (!args.verbose) {
          if (result.noop) {
            console.log(`${result.applied}/${args.patches.length} already applied`);
          } else {
            console.log(`${result.applied}/${args.patches.length} applied`);
          }
        } else {
          console.log(`\nDone.`);
          if (result.failed > 0) {
            console.log(`Warning: ${result.failed} patch(es) failed, ${result.applied} succeeded`);
          }
          console.log(`Patched CLI: ${patchedPath}`);
        }
        if (result.failed > 0) {
          process.exit(1);
        }
        // --require-all: treat not-applicable patches as a failure so CI
        // never publishes a binary that silently dropped patches.
        if (args.requireAll && skippedPatches.length > 0) {
          process.exit(1);
        }
      }
      // Always check sharp bindings — cheap idempotent no-op when already installed
      ensureSharpBindings(args.version, args.verbose);
      break;
    }

    case "run": {
      const version = args.version || resolveRunVersion();
      runPatched(version, args.cliArgs, args.verbose, args.patches);
      break;
    }

    case "install":
      installVersion(args.version);
      break;

    case "uninstall":
      uninstallClaude();
      break;

    case "update":
      updateCommand(args.version);
      break;

    case "doctor":
      doctorCommand();
      break;

    case "new-patch":
      newPatchCommand(args.patchId);
      break;

  }
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(`Error: ${error.message}`); process.exitCode = 1; }
}

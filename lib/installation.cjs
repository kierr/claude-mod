const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { randomUUID } = require("crypto");

function statOrNull(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function linkTarget(file) {
  const stat = statOrNull(file);
  if (!stat) return null;
  if (!stat.isSymbolicLink()) throw new Error(`Refusing unmanaged path: ${file}`);
  return path.resolve(path.dirname(file), fs.readlinkSync(file));
}

function verifyNative(file) {
  execFileSync("bun", ["-e", `require(${JSON.stringify(file)})`], { timeout: 60000, stdio: "pipe" });
}

function verifyRuntime(file, version) {
  const output = execFileSync("bun", [file, "--version"], {
    timeout: 60000, encoding: "utf8",
  }).trim();
  if (!output.split(/\s+/).includes(version)) {
    throw new Error(`Runtime version mismatch: expected ${version}`);
  }
  execFileSync("bun", [file, "--help"], { timeout: 60000, stdio: "pipe" });
}

// Immutable version copies plus one atomic current link keep the previous build
// intact even when reinstalling the same version. No launcher is ever replaced.
function createInstaller({ home, cacheDir, validateArtifact, ensureSharpBindings,
  getSharpPlatform, writePinnedVersion, verify = verifyRuntime, checkNative = verifyNative }) {
  const root = path.join(home, ".local", "lib", "claude-mod");
  const current = path.join(root, "current");
  const launcher = path.join(home, ".local", "bin", "claude");
  const pin = path.join(cacheDir, "pinned-version.json");
  const launcherTarget = path.join(current, "deobfuscated.js");
  const launcherTargetCodeSplit = path.join(current, "chunks", "cli.js");
  const legacyTargets = [
    path.join(cacheDir, "current", "patched", "deobfuscated.js"),
    path.join(home, ".local", "lib", "claude-patched", "current", "deobfuscated.js"),
  ];

  function assertLauncher() {
    const target = linkTarget(launcher);
    const validTargets = [launcherTarget, launcherTargetCodeSplit];
    if (target && !validTargets.includes(target)) {
      const hint = legacyTargets.includes(target) ? " Uninstall the older launcher first." : "";
      throw new Error(`Refusing existing launcher: ${launcher}.${hint}`);
    }
    const previous = linkTarget(current);
    if (previous && !previous.startsWith(root + path.sep)) {
      throw new Error(`Refusing unmanaged current link: ${current}`);
    }
    return target;
  }

  function retained(version) {
    const dir = path.join(root, version);
    if (!statOrNull(dir)) throw new Error(`No validated build for ${version}; patch it first`);
    const builds = fs.readdirSync(dir).filter(name => /^[a-f0-9]{64}$/.test(name))
      .map(name => path.join(dir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const build of builds) {
      try { validateArtifact(build, version, false); return build; }
      catch { /* Try another retained build; no unverified candidate is promoted. */ }
    }
    throw new Error(`No validated retained build for ${version}; patch it first`);
  }

  function install(version) {
    assertLauncher();
    fs.mkdirSync(root, { recursive: true });
    const lock = path.join(root, ".install.lock");
    const fd = fs.openSync(lock, "wx");
    let staging;
    let newLauncher = false;
    let pinChanged = false;
    let oldPin;
    const tempLink = path.join(root, `.current-${randomUUID()}`);
    try {
      oldPin = statOrNull(pin) ? fs.readFileSync(pin) : null;
      const cacheBuild = path.join(cacheDir, version, "patched");
      let candidate;
      if (statOrNull(cacheBuild)) {
        const manifest = validateArtifact(cacheBuild, version, true);
        ensureSharpBindings(version);
        const versionDir = path.join(root, version);
        fs.mkdirSync(versionDir, { recursive: true });
        staging = fs.mkdtempSync(path.join(versionDir, ".stage-"));
        fs.copyFileSync(path.join(cacheBuild, "deobfuscated.js"), path.join(staging, "deobfuscated.js"));
        fs.chmodSync(path.join(staging, "deobfuscated.js"), 0o755);
        // For code-split binaries, copy the chunks directory
        const cacheChunksDir = path.join(cacheBuild, "chunks");
        if (fs.existsSync(cacheChunksDir)) {
          fs.cpSync(cacheChunksDir, path.join(staging, "chunks"), { recursive: true, dereference: true });
          // Make the entry point executable
          const chunkEntry = path.join(staging, "chunks", "cli.js");
          if (fs.existsSync(chunkEntry)) {
            fs.chmodSync(chunkEntry, 0o755);
          }
        }
        fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(manifest));
        // Copy the whole dependency tree: some platforms also need sharp-libvips.
        fs.cpSync(path.join(cacheDir, version, "node_modules"), path.join(staging, "node_modules"), { recursive: true, dereference: true });
        validateArtifact(staging, version, false);
        // Verify the correct entry point based on format
        const stagingChunksEntry = path.join(staging, "chunks", "cli.js");
        const verifyTarget = fs.existsSync(stagingChunksEntry) ? stagingChunksEntry : path.join(staging, "deobfuscated.js");
        verify(verifyTarget, version);
        candidate = path.join(versionDir, manifest.outputSha);
        if (statOrNull(candidate)) {
          validateArtifact(candidate, version, false);
        } else {
          fs.renameSync(staging, candidate);
          staging = null;
        }
      } else {
        candidate = retained(version);
      }
      const nativeFile = path.join(candidate, "node_modules", "@img", `sharp-${getSharpPlatform()}`, "lib", `sharp-${getSharpPlatform()}.node`);
      if (!fs.existsSync(nativeFile)) throw new Error(`Missing sharp native bindings: ${nativeFile}`);
      checkNative(nativeFile);
      // Verify with correct entry point
      const candidateChunksEntry = path.join(candidate, "chunks", "cli.js");
      const candidateVerifyTarget = fs.existsSync(candidateChunksEntry) ? candidateChunksEntry : path.join(candidate, "deobfuscated.js");
      verify(candidateVerifyTarget, version);
      assertLauncher();
      fs.mkdirSync(path.dirname(launcher), { recursive: true });
      if (!statOrNull(launcher)) {
        // Point launcher to the correct entry point
        const actualTarget = fs.existsSync(candidateChunksEntry) ? launcherTargetCodeSplit : launcherTarget;
        fs.symlinkSync(actualTarget, launcher);
        newLauncher = true;
      }
      fs.symlinkSync(candidate, tempLink);
      pinChanged = true;
      writePinnedVersion(version, "install", 0, 0);
      // Final fallible operation: all validation happens before the live switch.
      fs.renameSync(tempLink, current);
    } catch (error) {
      if (pinChanged) {
        if (oldPin) fs.writeFileSync(pin, oldPin);
        else fs.rmSync(pin, { force: true });
      }
      if (newLauncher && [launcherTarget, launcherTargetCodeSplit].includes(linkTarget(launcher))) fs.unlinkSync(launcher);
      throw error;
    } finally {
      fs.rmSync(tempLink, { force: true });
      if (staging) fs.rmSync(staging, { recursive: true, force: true });
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
    console.log(`Installed verified ${version}: ${launcher}`);
  }

  function uninstall() {
    const target = linkTarget(launcher);
    const validTargets = [launcherTarget, launcherTargetCodeSplit];
    if (target && !validTargets.includes(target) && !legacyTargets.includes(target)) {
      throw new Error(`Refusing unmanaged launcher: ${launcher}`);
    }
    if (target) fs.unlinkSync(launcher);
    // Keep current and immutable builds for offline recovery, even after cache clean.
    console.log(`Launcher removed; retained builds: ${root}`);
  }

  return { install, uninstall, assertLauncher };
}

module.exports = { createInstaller, verifyRuntime };

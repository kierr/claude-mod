#!/usr/bin/env node
// Local release gate only: downloads upstream into a disposable HOME, never calls inference.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { validateArtifact } = require("../lib/artifact.cjs");

function assertSupportedArtifact(dir, version) {
  const manifest = validateArtifact(dir, version, false);
  if (manifest.applied !== 43 || manifest.skipped.length !== 1 || manifest.skipped[0] !== "model_picker_search") {
    throw new Error("Unexpected installed patch manifest for the supported release");
  }
}

function main() {
  const root = path.join(__dirname, "..");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-mod-release-"));
  const version = fs.readFileSync(path.join(root, "last-tested-version"), "utf8").trim();
  const env = {
    HOME: home,
    PATH: `${home}/.bun/bin:${process.env.PATH}`,
    BUN_INSTALL: path.join(home, ".bun"),
    BUN_INSTALL_CACHE_DIR: path.join(home, ".bun", "install", "cache"),
    npm_config_cache: path.join(home, ".npm"),
    TMPDIR: home, LANG: "en_US.UTF-8", NO_COLOR: "1",
  };
  let stage = "packing";
  function run(label, command, args, timeout = 120000) {
    stage = label;
    console.log(`Checking: ${stage}`);
    return execFileSync(command, args, { cwd: root, env, encoding: "utf8", timeout });
  }
  try {
    const packed = JSON.parse(run("tarball", "npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", home]))[0];
    for (const { path: entry } of packed.files) {
      if (/(^|\/)(?:\.cache|\.agents|research|baseline|patched|node_modules)(\/|$)|discovered|deobfuscated|\.tgz$/.test(entry)) {
        throw new Error(`Forbidden tarball entry: ${entry}`);
      }
    }
    console.log(`Packed ${packed.files.length} authored files; installing into fresh HOME`);
    run("global package install", "bun", ["install", "--global", path.join(home, packed.filename)]);
    const cli = path.join(home, ".bun", "bin", "claude-mod");
    const launcher = path.join(home, ".local", "bin", "claude");
    run("fresh update (download, extract, deobfuscate, patch, install)", cli, ["update"], 1200000);
    stage = "installed artifact evidence";
    const installed = path.join(home, ".local", "lib", "claude-mods", "current");
    assertSupportedArtifact(installed, version);
    console.log("Fresh update: 43 applied, 1 version-gated skip, 0 failed");
    if (!run("installed version", launcher, ["--version"]).trim().split(/\s+/).includes(version)) throw new Error("Wrong installed version");
    if (!run("installed help", launcher, ["--help"]).includes("Usage:")) throw new Error("Missing installed help");
    run("default cached run", cli, ["run", "--", "--version"]);
    run("cache removal", cli, ["clean", version]);
    run("uninstall", cli, ["uninstall"]);
    run("cache-free reinstall", cli, ["install", version]);
    if (!run("restored version", launcher, ["--version"]).trim().split(/\s+/).includes(version)) throw new Error("Offline restore failed");
    const native = path.join(installed, "node_modules", "@img", `sharp-${process.platform}-${process.arch}`, "lib", `sharp-${process.platform}-${process.arch}.node`);
    run("restored native binding", "bun", ["-e", `require(${JSON.stringify(native)})`]);
    console.log(`PASS: packed ${version} fresh install, offline version/help, native bindings, cache-independent restore`);
  } catch (error) {
    // Child output can contain upstream-derived snippets. Keep it out of gate reports.
    console.error(`Fresh-install gate failed at ${stage}: ${error.code || error.status || error.name}`);
    if (!error.stdout && !error.stderr) console.error(error.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

module.exports = { assertSupportedArtifact };
if (require.main === module) main();

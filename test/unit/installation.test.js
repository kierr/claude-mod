import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInstaller } from "../../lib/installation.cjs";
import { assertSupportedArtifact } from "../../bin/gate-fresh-install.cjs";
import { stampArtifact, validateArtifact, patchSetFingerprint, sha256File } from "../../lib/artifact.cjs";

let home, cacheDir, root, launcher, depsCalls, verifyFailure;
const version = "2.1.181";
const platform = "darwin-arm64";
const options = () => ({
  home, cacheDir, validateArtifact,
  getSharpPlatform: () => platform,
  checkNative: () => {},
  ensureSharpBindings: (v) => {
    depsCalls++;
    const file = path.join(cacheDir, v, "node_modules", "@img", `sharp-${platform}`, "lib", `sharp-${platform}.node`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "synthetic native placeholder");
  },
  verify: () => { if (verifyFailure) throw new Error("synthetic smoke failure"); },
  writePinnedVersion: (v) => {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "pinned-version.json"), JSON.stringify({ version: v, source: "install" }));
  },
});
function seed(v = version, suffix = "") {
  const dir = path.join(cacheDir, v, "patched");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "deobfuscated.js"), `#!/usr/bin/env bun\nconsole.log(${JSON.stringify(v)}); // ${suffix}\n`);
  stampArtifact(dir, v, { baselineSha: "0".repeat(64), patchSetSha: patchSetFingerprint(), applied: 43, skipped: ["synthetic_gate"] });
  return dir;
}
function setupLauncher(target) {
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.symlinkSync(target, launcher);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mods-install-test-"));
  cacheDir = path.join(home, ".cache", "claude-mods");
  root = path.join(home, ".local", "lib", "claude-mods");
  launcher = path.join(home, ".local", "bin", "claude");
  depsCalls = 0; verifyFailure = false;
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("installation ownership and transactions", () => {
  test("refuses a regular launcher before any installation changes", () => {
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.writeFileSync(launcher, "user launcher");
    expect(() => createInstaller(options()).install(version)).toThrow("unmanaged");
    expect(fs.readFileSync(launcher, "utf8")).toBe("user launcher");
    expect(fs.existsSync(root)).toBe(false);
    expect(depsCalls).toBe(0);
  });
  test.each(["/missing/unrelated", "/missing/claude-mods-lookalike", "/opt/homebrew/bin/claude"])("refuses foreign or broken symlink %s", (target) => {
    setupLauncher(target);
    const installer = createInstaller(options());
    expect(() => installer.install(version)).toThrow("existing launcher");
    expect(() => installer.uninstall()).toThrow("unmanaged launcher");
    expect(fs.readlinkSync(launcher)).toBe(target);
  });
  test("a new install populates native dependencies before promotion", () => {
    seed();
    createInstaller(options()).install(version);
    expect(depsCalls).toBe(1);
    expect(fs.readlinkSync(launcher)).toBe(path.join(root, "current", "deobfuscated.js"));
    expect(fs.readFileSync(launcher, "utf8")).toContain(version);
  });
  test("failed same-version smoke preserves live bytes, current, and pin", () => {
    seed();
    const installer = createInstaller(options());
    installer.install(version);
    const live = fs.readlinkSync(path.join(root, "current"));
    const bytes = fs.readFileSync(launcher, "utf8");
    const pin = fs.readFileSync(path.join(cacheDir, "pinned-version.json"), "utf8");
    seed(version, "different build");
    verifyFailure = true;
    expect(() => installer.install(version)).toThrow("smoke failure");
    expect(fs.readlinkSync(path.join(root, "current"))).toBe(live);
    expect(fs.readFileSync(launcher, "utf8")).toBe(bytes);
    expect(fs.readFileSync(path.join(cacheDir, "pinned-version.json"), "utf8")).toBe(pin);
    expect(fs.existsSync(path.join(root, ".install.lock"))).toBe(false);
  });
  test("initial failed smoke leaves no launcher or pin", () => {
    seed(); verifyFailure = true;
    expect(() => createInstaller(options()).install(version)).toThrow("smoke failure");
    expect(fs.existsSync(launcher)).toBe(false);
    expect(fs.existsSync(path.join(cacheDir, "pinned-version.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, "current"))).toBe(false);
  });
  test("pin-write failure rolls back newly created launcher and pin", () => {
    seed();
    const opts = options();
    opts.writePinnedVersion = () => { throw new Error("pin write failure"); };
    expect(() => createInstaller(opts).install(version)).toThrow("pin write failure");
    expect(() => fs.lstatSync(launcher)).toThrow();
    expect(fs.existsSync(path.join(root, "current"))).toBe(false);
  });
  test("failed final rename restores the previous pin and live build", () => {
    seed();
    const installer = createInstaller(options()); installer.install(version);
    const current = path.join(root, "current");
    const previous = fs.readlinkSync(current);
    const pin = fs.readFileSync(path.join(cacheDir, "pinned-version.json"), "utf8");
    seed("2.1.182");
    const rename = fs.renameSync;
    const mock = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === current) throw new Error("synthetic rename failure");
      return rename(from, to);
    });
    try { expect(() => installer.install("2.1.182")).toThrow("rename failure"); }
    finally { mock.mockRestore(); }
    expect(fs.readlinkSync(current)).toBe(previous);
    expect(fs.readFileSync(path.join(cacheDir, "pinned-version.json"), "utf8")).toBe(pin);
    expect(fs.existsSync(path.join(root, ".install.lock"))).toBe(false);
  });
  test("uninstall and cache cleanup preserve validated offline recovery", () => {
    seed();
    const installer = createInstaller(options());
    installer.install(version);
    const originalSha = sha256File(launcher);
    installer.uninstall();
    fs.rmSync(cacheDir, { recursive: true, force: true });
    installer.install(version);
    expect(sha256File(launcher)).toBe(originalSha);
    expect(depsCalls).toBe(1);
  });
  test("dependency symlinks are materialized for cache-independent restore", () => {
    seed();
    const opts = options();
    opts.ensureSharpBindings = (v) => {
      const store = path.join(cacheDir, "store", "sharp", "lib");
      fs.mkdirSync(store, { recursive: true });
      fs.writeFileSync(path.join(store, `sharp-${platform}.node`), "synthetic native");
      const scope = path.join(cacheDir, v, "node_modules", "@img");
      fs.mkdirSync(scope, { recursive: true });
      fs.symlinkSync(path.dirname(store), path.join(scope, `sharp-${platform}`));
    };
    const installer = createInstaller(opts); installer.install(version);
    const installed = path.join(root, "current", "node_modules", "@img", `sharp-${platform}`);
    expect(fs.lstatSync(installed).isSymbolicLink()).toBe(false);
    installer.uninstall(); fs.rmSync(cacheDir, { recursive: true, force: true });
    installer.install(version);
    expect(fs.readFileSync(path.join(installed, "lib", `sharp-${platform}.node`), "utf8")).toBe("synthetic native");
  });
  test("missing native dependency fails before promotion", () => {
    seed();
    const opts = options(); opts.ensureSharpBindings = () => {};
    expect(() => createInstaller(opts).install(version)).toThrow();
    expect(fs.existsSync(path.join(root, "current"))).toBe(false);
  });
  test("unloadable native bindings fail before promotion", () => {
    seed();
    const opts = options(); opts.checkNative = () => { throw new Error("native load failure"); };
    expect(() => createInstaller(opts).install(version)).toThrow("native load failure");
    expect(fs.existsSync(path.join(root, "current"))).toBe(false);
    expect(fs.existsSync(launcher)).toBe(false);
  });
  test("pin read failure releases the installation lock", () => {
    seed();
    fs.mkdirSync(path.join(cacheDir, "pinned-version.json"));
    expect(() => createInstaller(options()).install(version)).toThrow();
    expect(fs.existsSync(path.join(root, ".install.lock"))).toBe(false);
  });
  test("tampered cache is refused even if a retained build is available", () => {
    const dir = seed();
    const installer = createInstaller(options()); installer.install(version);
    fs.appendFileSync(path.join(dir, "deobfuscated.js"), "// changed");
    expect(() => installer.install(version)).toThrow("changed patch artifact");
    expect(depsCalls).toBe(1);
  });
});

describe("artifact evidence", () => {
  test("release gate measures the installed manifest, not console summaries", () => {
    const dir = seed();
    expect(() => assertSupportedArtifact(dir, version)).toThrow("Unexpected installed");
    stampArtifact(dir, version, { baselineSha: "0".repeat(64), patchSetSha: patchSetFingerprint(), applied: 43, skipped: ["model_picker_search"] });
    expect(() => assertSupportedArtifact(dir, version)).not.toThrow();
    fs.appendFileSync(path.join(dir, "deobfuscated.js"), "// changed");
    expect(() => assertSupportedArtifact(dir, version)).toThrow("changed patch artifact");
  });
  test("missing manifest and old metadata cannot authorize output", () => {
    const dir = seed();
    fs.unlinkSync(path.join(dir, "manifest.json"));
    expect(() => validateArtifact(dir, version)).toThrow("Missing successful");
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ applied: 43 }));
    expect(() => validateArtifact(dir, version)).toThrow("Invalid");
  });
  test("valid output must match bytes, version, recipe and shebang", () => {
    const dir = seed();
    expect(validateArtifact(dir, version).status).toBe("complete");
    expect(() => validateArtifact(dir, "2.1.182")).toThrow("Invalid");
    stampArtifact(dir, version, { baselineSha: "0".repeat(64), patchSetSha: "1".repeat(64), applied: 43, skipped: [] });
    expect(() => validateArtifact(dir, version)).toThrow("recipe changed");
    expect(validateArtifact(dir, version, false).status).toBe("complete");
    fs.writeFileSync(path.join(dir, "deobfuscated.js"), "console.log('no shebang');");
    stampArtifact(dir, version, { baselineSha: "0".repeat(64), patchSetSha: patchSetFingerprint(), applied: 43, skipped: [] });
    expect(() => validateArtifact(dir, version)).toThrow("shebang");
  });
});

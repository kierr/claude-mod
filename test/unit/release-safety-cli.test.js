import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sha256File, patchSetFingerprint, stampArtifact } from "../../lib/artifact.cjs";

const root = path.resolve(import.meta.dir, "../..");
const cli = path.join(root, "bin", "patch.cjs");
const version = fs.readFileSync(path.join(root, "last-tested-version"), "utf8").trim();
let home, cache, env;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mods-cli-safety-"));
  cache = path.join(home, ".cache", "claude-mods");
  const traps = path.join(home, "traps");
  fs.mkdirSync(traps);
  for (const name of ["npm", "bunx"]) fs.writeFileSync(path.join(traps, name), `#!/bin/sh\nprintf called > '${home}/network-called'\nexit 91\n`, { mode: 0o755 });
  env = { ...process.env, HOME: home, PATH: `${traps}:${process.env.PATH}` };
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
function run(args) { return spawnSync("bun", [cli, ...args], { cwd: root, env, encoding: "utf8", timeout: 30000 }); }
function seed(v = version) {
  const dir = path.join(cache, v);
  fs.mkdirSync(path.join(dir, "baseline"), { recursive: true });
  fs.mkdirSync(path.join(dir, "patched"));
  const baseline = path.join(dir, "baseline", "deobfuscated.js");
  fs.writeFileSync(path.join(dir, "cli.js"), "// synthetic extraction");
  fs.utimesSync(path.join(dir, "cli.js"), new Date(0), new Date(0));
  fs.writeFileSync(baseline, "#!/usr/bin/env bun\nconsole.log('synthetic baseline');\n");
  const patched = path.join(dir, "patched", "deobfuscated.js");
  fs.writeFileSync(patched, `#!/usr/bin/env bun\nrequire('fs').writeFileSync(${JSON.stringify(path.join(home, "executed"))}, ${JSON.stringify(v)}); console.log(${JSON.stringify(v)});\n`);
  stampArtifact(path.dirname(patched), v, { baselineSha: sha256File(baseline), patchSetSha: patchSetFingerprint(), applied: 43, skipped: ["synthetic_gate"] });
  const platform = `${process.platform}-${process.arch}`;
  const native = path.join(dir, "node_modules", "@img", `sharp-${platform}`, "lib", `sharp-${platform}.node`);
  fs.mkdirSync(path.dirname(native), { recursive: true }); fs.writeFileSync(native, "synthetic placeholder");
  return dir;
}

describe("release safety CLI boundaries", () => {
  test("explicit cached run neither contacts npm nor promotes a background success", () => {
    seed();
    fs.writeFileSync(path.join(cache, "background-patch-state.json"), JSON.stringify({ status: "success", targetVersion: "2.1.999" }));
    const result = run(["run", version, "--", "--version"]);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(home, "executed"), "utf8")).toBe(version);
    expect(fs.existsSync(path.join(home, "network-called"))).toBe(false);
    expect(fs.existsSync(path.join(cache, "pinned-version.json"))).toBe(false);
  });
  test("default run ignores legacy auto pins and newer cache entries", () => {
    seed(); seed("2.1.999");
    fs.writeFileSync(path.join(cache, "pinned-version.json"), JSON.stringify({ version: "2.1.999", source: "auto" }));
    expect(run(["run", "--", "--version"]).status).toBe(0);
    expect(fs.readFileSync(path.join(home, "executed"), "utf8")).toBe(version);
    expect(fs.existsSync(path.join(home, "network-called"))).toBe(false);
  });
  test("an explicitly installed pin remains a deliberate version choice", () => {
    seed("2.1.999");
    fs.writeFileSync(path.join(cache, "pinned-version.json"), JSON.stringify({ version: "2.1.999", source: "install" }));
    expect(run(["run", "--", "--version"]).status).toBe(0);
    expect(fs.readFileSync(path.join(home, "executed"), "utf8")).toBe("2.1.999");
  });
  test("partial rebuild exits nonzero, erases stale success, and cannot install", () => {
    const dir = seed();
    const patched = path.join(dir, "patched", "deobfuscated.js");
    fs.appendFileSync(patched, "// invalidate output hash");
    const result = run(["run", version, "--", "--version"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing partial output");
    expect(fs.existsSync(path.join(home, "executed"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "patched", "manifest.json"))).toBe(false);
    const install = run(["install", version]);
    expect(install.status).not.toBe(0);
    expect(install.stderr).toContain("Missing successful patch manifest");
    expect(fs.existsSync(path.join(home, ".local", "bin", "claude"))).toBe(false);
  });
  test("update refuses a foreign launcher before fetch or patch", () => {
    const launcher = path.join(home, ".local", "bin", "claude");
    fs.mkdirSync(path.dirname(launcher), { recursive: true }); fs.writeFileSync(launcher, "owned by someone else");
    const result = run(["update"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing unmanaged");
    expect(fs.existsSync(path.join(home, "network-called"))).toBe(false);
    expect(fs.existsSync(cache)).toBe(false);
  });
  test("run propagates a signalled child's failure", () => {
    const dir = seed();
    const patched = path.join(dir, "patched");
    const manifest = JSON.parse(fs.readFileSync(path.join(patched, "manifest.json"), "utf8"));
    fs.writeFileSync(path.join(patched, "deobfuscated.js"), "#!/usr/bin/env bun\nprocess.kill(process.pid, 'SIGTERM');\n");
    stampArtifact(patched, version, manifest);
    expect(run(["run", version]).status).toBe(1);
  });
});

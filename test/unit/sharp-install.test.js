import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const cli = fs.readFileSync(path.join(root, "bin/patch.cjs"), "utf8");
const install = fs.readFileSync(path.join(root, "lib/installation.cjs"), "utf8");

describe("native binding wiring (behavior covered by installation tests)", () => {
  test("all install paths use the installer that ensures bindings", () => {
    expect(cli).toContain("const installVersion = installer.install;");
    expect(install).toContain("ensureSharpBindings(version);");
    expect(cli).toContain("installVersion(target);");
  });
  test("cache lookup matches the native package layout", () => {
    expect(cli).toContain('path.join(sharpModuleDir, "lib", `sharp-${platform}.node`)');
    expect(cli).not.toContain('path.join(sharpModuleDir, "sharp.node")');
  });
  test("dependency installation is bounded and fails closed", () => {
    expect(cli).toContain("timeout: 120000");
    expect(cli).toContain('path.join(cachePath, "package.json")');
    expect(cli).toContain('"--ignore-scripts"');
    expect(cli).toContain('throw new Error(`Could not install sharp bindings: ${error.message}`)');
    expect(cli).toContain('throw new Error("Native module missing after installation")');
  });
  test("installed dependencies include sibling libvips packages", () => {
    expect(install).toContain('fs.cpSync(path.join(cacheDir, version, "node_modules"), path.join(staging, "node_modules"), { recursive: true, dereference: true })');
    expect(install).toContain("Missing sharp native bindings:");
  });
});

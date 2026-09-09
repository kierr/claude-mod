/** Cached runtime smoke only; fresh packed installation is a separate release gate. */
import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dir, "../..");
const version = fs.readFileSync(path.join(root, "last-tested-version"), "utf8").trim();
const patchedPath = path.join(os.homedir(), ".cache", "claude-mods", version, "patched", "deobfuscated.js");
const smoke = fs.existsSync(patchedPath) ? it : it.skip;

describe("Smoke: cached patched CLI (absent cache is an explicit skip)", () => {
  smoke("patched output is valid JS", () => {
    const result = spawnSync("node", ["-c", patchedPath], { timeout: 30000, encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  }, 35000);

  smoke("the actual cached CLI boots offline and reports the expected version", () => {
    const result = spawnSync("bun", [patchedPath, "--version"], { timeout: 15000, encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split(/\s+/)).toContain(version);
  }, 20000);
});

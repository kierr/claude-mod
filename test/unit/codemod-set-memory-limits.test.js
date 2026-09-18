import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-set-memory-limits.cjs");
const FIXTURES_DIR = path.join(process.cwd(), "test/fixtures");
const TIMEOUT = 30000;

function runCodemod(inputCode) {
  const ti = path.join(FIXTURES_DIR, `ti-${randomUUID()}.js`);
  const to = path.join(FIXTURES_DIR, `to-${randomUUID()}.js`);
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  fs.writeFileSync(ti, inputCode);
  try {
    execSync(`node "${CODEMOD_PATH}" "${ti}" "${to}"`, { stdio: "pipe", cwd: process.cwd() });
    return fs.readFileSync(to, "utf8");
  } finally {
    if (fs.existsSync(ti)) fs.unlinkSync(ti);
    if (fs.existsSync(to)) fs.unlinkSync(to);
  }
}

// Exercises line/byte limits, file scan limits (simple + structured), recall (.slice + "up to"),
// and the selector model/max_tokens.
const FULL = `
var $57 = 200;
var xkK = 4096;
var UAY = 200;
var IJY = 500;
var msg = \`first \${$57} lines (or \${xkK} byte limit)\`;
function selectMemories(memories) {
  var prompt = \`Select up to 5 memories relevant to the current task.\`;
  var list = memories.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, structuredMode ? IJY : UAY);
  var filtered = list.filter(m => m.has(m.path));
  var selected = filtered.slice(0, 5);
  return callAPI({
    model: nT(),
    max_tokens: 256
  });
}
`;

describe("codemod-set-memory-limits", () => {
  it("rewrites every limit to __getModConfig__ ?? default", { timeout: TIMEOUT }, () => {
    const out = runCodemod(FULL);
    expect(out).toContain('__getModConfig__("set_memory_limits", "max_lines") ?? 200');
    expect(out).toContain('__getModConfig__("set_memory_limits", "max_bytes") ?? 4096');
    expect(out).toContain('__getModConfig__("set_memory_limits", "max_files") ?? 200');
    expect(out).toContain('__getModConfig__("set_memory_limits", "max_files_structured") ?? 500');
    expect(out).toContain('__getModConfig__("set_memory_limits", "max_recall") ?? 5');
    expect(out).toContain('__getModConfig__("set_memory_limits", "selector_model") ?? nT()');
    expect(out).toContain('__getModConfig__("set_memory_limits", "selector_max_tokens") ?? 256');
    // No env-var reads remain.
    expect(out).not.toContain("CLAUDE_MEMORY_");
    expect(out).not.toContain("parseInt");
  });

  it("is idempotent — already-patched code is a no-op", { timeout: TIMEOUT }, () => {
    const once = runCodemod(FULL);
    const { transform } = require(CODEMOD_PATH);
    const result = transform(once);
    expect(result.changed).toBe(0);
  });

  it("returns no changes for unrelated code", { timeout: TIMEOUT }, () => {
    const { transform } = require(CODEMOD_PATH);
    const code = "const x = 42;\nconsole.log(x);\n";
    const result = transform(code);
    expect(result.changed).toBe(0);
  });
});

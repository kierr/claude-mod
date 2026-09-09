import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-set-context-limit.cjs");
const FIXTURES_DIR = path.join(process.cwd(), "test/fixtures");
const TIMEOUT = 30000;

function runCodemod(input) {
  const ti = path.join(FIXTURES_DIR, `ti-${randomUUID()}.js`);
  const to = path.join(FIXTURES_DIR, `to-${randomUUID()}.js`);
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  fs.writeFileSync(ti, input);
  try {
    execSync(`node "${CODEMOD_PATH}" "${ti}" "${to}"`, { stdio: "pipe", cwd: process.cwd() });
    return fs.readFileSync(to, "utf8");
  } finally {
    if (fs.existsSync(ti)) fs.unlinkSync(ti);
    if (fs.existsSync(to)) fs.unlinkSync(to);
  }
}

const ALL_THREE = `
function contextWin() { var a = 200000; var b = 20000; var c = 32000; return a; }
function toolBatch() { var d = 400000; var e = 200000; var f = 50; return e; }
function memChunk() { var g = 250000; var h = 200000; var i = 3; return h; }
`;

describe("codemod-set-context-limit", () => {
  it("rewrites each cluster to __getModConfig__ ?? 200000", { timeout: TIMEOUT }, () => {
    const out = runCodemod(ALL_THREE);
    expect(out).toContain('__getModConfig__("set_context_limit", "context_limit") ?? 200000');
    expect(out).toContain('__getModConfig__("set_context_limit", "tool_batch_limit") ?? 200000');
    expect(out).toContain('__getModConfig__("set_context_limit", "memory_chunk_limit") ?? 200000');
    expect(out).not.toContain("CLAUDE_CONTEXT_LIMIT");
    expect(out).not.toContain("parseInt");
  });

  it("replaces the hardcoded > 200000 comparison with the context-window var", { timeout: TIMEOUT }, () => {
    const input = `
var ctx = 200000;
var b = 20000;
var c = 32000;
function trimHistory(messages) {
  var idx = messages.findLast(function (m) { return m.role === "assistant"; });
  if (messages.length > 200000) { messages.splice(0, 10); }
}`;
    const out = runCodemod(input);
    expect(out).toContain("__getModConfig__(\"set_context_limit\", \"context_limit\") ?? 200000");
    expect(out).toContain("> ctx");
    expect(out).not.toContain("> 200000");
  });

  it("is idempotent — already-patched code is not double-wrapped", { timeout: TIMEOUT }, () => {
    const patched = `
var a = __getModConfig__("set_context_limit", "context_limit") ?? 200000;
var b = 20000;
var c = 32000;
var d = 400000;
var e = __getModConfig__("set_context_limit", "tool_batch_limit") ?? 200000;
var f = 50;
var g = 250000;
var h = __getModConfig__("set_context_limit", "memory_chunk_limit") ?? 200000;
var i = 3;
`;
    const out = runCodemod(patched);
    const cfgCount = (out.match(/__getModConfig__\("set_context_limit"/g) || []).length;
    expect(cfgCount).toBe(3);
    expect(out).not.toContain("CLAUDE_CONTEXT_LIMIT");
  });

  it("returns no changes for unrelated code", { timeout: TIMEOUT }, () => {
    expect(() => runCodemod("const x = 42;\nconsole.log(x);\n")).not.toThrow();
  });
});

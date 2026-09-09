import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";

const { fixBunCjsWrapper } = require("../../bin/patch.cjs");

const FIXTURE_DIR = path.join(os.tmpdir(), "claude-mods-test-fixbuncjs");

function writeFixture(name, content) {
  const filePath = path.join(FIXTURE_DIR, name);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

describe("fixBunCjsWrapper", () => {
  beforeEach(() => {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch {}
  });

  it("strips @bun header and adds CJS IIFE args", () => {
    const input = `// @bun @bytecode @bun-cjs
(function(exports, require, module, __filename, __dirname) {
  var x = 1;
  console.log(x);
})`;
    const filePath = writeFixture("normal.js", input);
    fixBunCjsWrapper(filePath);
    const output = fs.readFileSync(filePath, "utf8");

    expect(output).not.toContain("// @bun");
    expect(output).toContain("#!/usr/bin/env bun\n");
    expect(output).toContain("})(module.exports, require, module, __filename, __dirname);");
    expect(output).toContain("var x = 1;");
  });

  it("returns early when already fixed (shebang present, no @bun header)", () => {
    const input = `#!/usr/bin/env bun
(function(exports, require, module, __filename, __dirname) {
  var x = 1;
})(module.exports, require, module, __filename, __dirname);
`;
    const filePath = writeFixture("no-header.js", input);
    fixBunCjsWrapper(filePath);
    const output = fs.readFileSync(filePath, "utf8");

    expect(output).toBe(input);
  });

  it("is idempotent — second call is a no-op", () => {
    const input = `// @bun @bytecode @bun-cjs
(function(exports, require, module, __filename, __dirname) {
  var x = 1;
})`;
    const filePath = writeFixture("idempotent.js", input);
    fixBunCjsWrapper(filePath);
    const first = fs.readFileSync(filePath, "utf8");
    fixBunCjsWrapper(filePath);
    const second = fs.readFileSync(filePath, "utf8");

    expect(first).toBe(second);
  });

  it("sets executable permissions", () => {
    const input = `// @bun @bytecode @bun-cjs
(function(exports, require, module, __filename, __dirname) {
  var x = 1;
})`;
    const filePath = writeFixture("chmod.js", input);
    fixBunCjsWrapper(filePath);
    const stat = fs.statSync(filePath);

    expect(stat.mode & 0o111).not.toBe(0);
  });

  it("throws when @bun header present but no }) closing", () => {
    const input = `// @bun @bytecode @bun-cjs
var x = 1;
console.log(x);
`;
    const filePath = writeFixture("no-close.js", input);

    expect(() => fixBunCjsWrapper(filePath)).toThrow("no closing");
  });

  it("handles prepended markers before @bun header (regex codemod idempotency)", () => {
    // Regex codemods prepend idempotency markers (var __xxx_patched__ = true)
    // before the @bun header. The v2.1.156 bug: indexOf("@bun") returned -1
    // because old code used startsWith, causing silent no-op. The fix uses
    // indexOf to find the header anywhere near the top.
    const input = `var __disable_ugrep_shell_patched__ = true;
var __retry_all_errors_patched__ = true;
// @bun @bytecode @bun-cjs
(function(exports, require, module, __filename, __dirname) {
  var x = 1;
  console.log(x);
})`;
    const filePath = writeFixture("prepended-markers.js", input);
    fixBunCjsWrapper(filePath);
    const output = fs.readFileSync(filePath, "utf8");

    expect(output).not.toContain("// @bun");
    expect(output).toContain("#!/usr/bin/env bun\n");
    expect(output).toContain("__disable_ugrep_shell_patched__");
    expect(output).toContain("__retry_all_errors_patched__");
    expect(output).toContain("})(module.exports, require, module, __filename, __dirname);");
  });

  it("throws when no @bun header and no recognizable prefix (unexpected state)", () => {
    // RATIONALE: "const" doesn't match any accepted prefix (#!/usr/bin/env bun,
    // "var ") so this triggers the unexpected-state throw.
    const input = `const x = 1;
console.log(x);
`;
    const filePath = writeFixture("unexpected-state.js", input);

    expect(() => fixBunCjsWrapper(filePath)).toThrow("no @bun header found and no recognizable shebang or content prefix");
  });

  it("uses last }) when multiple occur in body", () => {
    const input = `// @bun @bytecode @bun-cjs
(function(exports, require, module, __filename, __dirname) {
  var items = [1, 2, 3];
  items.forEach(function(item) { console.log(item) });
  var z = 42;
})`;
    const filePath = writeFixture("multiple-close.js", input);
    fixBunCjsWrapper(filePath);
    const output = fs.readFileSync(filePath, "utf8");

    expect(output).toContain("})(module.exports, require, module, __filename, __dirname);");
    expect(output).toContain("console.log(item) })");
  });
});

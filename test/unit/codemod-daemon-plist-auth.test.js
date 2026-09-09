import { describe, it, expect } from "bun:test";
import { transform } from "../../codemods/codemod-daemon-plist-auth.cjs";

// Simulates the plist generation code from eP_() in the deobfuscated baseline.
// Uses double quotes like the real deobfuscated code.
const fixture = `async function eP_(H) {
    let {
      jsonPath: _,
      logPath: q
    } = H;
    let K = bC8();
    let O = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";
    {
      let T = xC8();
      try {
        await pHH.mkdir(tP_.join(IC8.homedir(), "Library", "LaunchAgents"), {
          recursive: true
        });
        await pHH.writeFile(T, \`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>\${MNH}</string>
  <key>ProgramArguments</key><array>
    <string>\${RrH(K)}</string>
    <string>daemon</string>
    <string>--json-path</string>
    <string>\${RrH(_)}</string>
    <string>--log-file</string>
    <string>\${RrH(q)}</string>
    <string>--origin</string>
    <string>service</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>\${RrH(O)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>\${RrH(q)}</string>
  <key>StandardErrorPath</key><string>\${RrH(q)}</string>
</dict></plist>
\`, "utf8");
      } catch (Y) {
        return {
          ok: false,
          error: kH(Y),
          serviceId: MNH,
          servicePath: T
        };
      }
    }
  }`;

// A marker inside a substitution produces no XML text. Verify that it never
// appears in the template quasis, where it would render into the plist.
function stripSubstitutions(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "$" && s[i + 1] === "{") {
      let depth = 1;
      let inStr = false;
      let quote = "";
      i += 2;
      while (i < s.length && depth > 0) {
        const c = s[i];
        if (inStr) {
          if (c === "\\") { i += 2; continue; }
          if (c === quote) inStr = false;
          i += 1;
        } else {
          if (c === '"' || c === "'" || c === "`") { inStr = true; quote = c; i += 1; continue; }
          if (c === "{") depth++;
          else if (c === "}") depth--;
          i += 1;
        }
      }
      continue;
    }
    out += s[i];
    i += 1;
  }
  return out;
}

// Given the index just past an opening backtick, return the index of the
// matching closing backtick, correctly skipping ${...} substitutions (with
// nested brace counting and string skipping inside them) and quasi escapes.
function findTemplateEnd(code, i) {
  let depth = 0;
  let inStr = false;
  let quote = "";
  while (i < code.length) {
    const c = code[i];
    if (depth > 0) {
      if (inStr) {
        if (c === "\\") { i += 2; continue; }
        if (c === quote) inStr = false;
        i += 1; continue;
      }
      if (c === '"' || c === "'" || c === "`") { inStr = true; quote = c; i += 1; continue; }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      i += 1; continue;
    }
    if (c === "\\") { i += 2; continue; }
    if (c === "`") return i;
    if (c === "$" && code[i + 1] === "{") { depth = 1; i += 2; continue; }
    i += 1;
  }
  return -1;
}

// Evaluate the generated template: valid JavaScript and balanced source tags
// do not prove that the rendered plist is valid XML.
function renderPlist(code, ctx) {
  const start = code.lastIndexOf("`", code.indexOf("<?xml"));
  const end = findTemplateEnd(code, start + 1);
  const body = code.substring(start + 1, end);
  const fn = new Function(
    "MNH", "RrH", "K", "_", "q", "O", "__isModEnabled__", "process",
    "return `" + body + "`;",
  );
  return fn(
    ctx.label, ctx.escape, ctx.exePath, ctx.jsonPath, ctx.logPath,
    ctx.path, ctx.isEnabled, { env: ctx.env },
  );
}

function assertWellFormed(plist) {
  // No comment syntax or idempotency markers may leak into rendered XML.
  expect(plist).not.toContain("/*");
  expect(plist).not.toContain("*/");
  expect(plist).not.toContain("__DPA__");
  // Every container tag must be balanced across the whole plist.
  for (const tag of ["plist", "dict", "array", "string", "key"]) {
    const opens = (plist.match(new RegExp(`<${tag}[ >]`, "g")) || []).length;
    const closes = (plist.match(new RegExp(`</${tag}>`, "g")) || []).length;
    expect(opens).toBe(closes);
  }
}

describe("codemod-daemon-plist-auth", () => {
  it("injects ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL into plist env vars with mod guards", () => {
    const { code, changed } = transform(fixture);
    expect(changed).toBe(1);
    expect(code).toContain("ANTHROPIC_API_KEY");
    expect(code).toContain("ANTHROPIC_BASE_URL");
    expect(code).toContain("process.env.ANTHROPIC_API_KEY");
    expect(code).toContain("process.env.ANTHROPIC_BASE_URL");
    // Should have the mod guard
    expect(code).toContain('__isModEnabled__("add_auth_forwarding")');
    expect(code).toContain("typeof __isModEnabled__");
    // Should have the idempotency marker
    expect(code).toContain("__DPA__");
    // Should still have the PATH entry
    expect(code).toContain("<key>PATH</key>");
    // Should have the escape function call preserved
    expect(code).toMatch(/RrH\(O\)/);
    // XML tag balance: <string> and </string> counts must match
    const envStart = code.indexOf("<key>EnvironmentVariables");
    const envEnd = code.indexOf("</dict>", envStart) + "</dict>".length;
    const section = code.substring(envStart, envEnd);
    const opens = (section.match(/<string>/g) || []).length;
    const closes = (section.match(/<\/string>/g) || []).length;
    expect(opens).toBe(closes);
  });

  it("is idempotent", () => {
    const first = transform(fixture);
    const second = transform(first.code);
    expect(second.changed).toBe(0);
    expect(second.code).toEqual(first.code);
  });

  it("survives minified name changes", () => {
    const renamed = fixture
      .replace(/RrH/g, "xQ9")
      .replace("eP_", "wT7")
      .replace("bC8", "nM2")
      .replace("pHH", "aK3")
      .replace("xC8", "rJ5");
    const { code, changed } = transform(renamed);
    expect(changed).toBe(1);
    expect(code).toContain("ANTHROPIC_API_KEY");
    expect(code).toContain("xQ9(O)");
    expect(code).toContain("xQ9(process.env.ANTHROPIC_API_KEY)");
    expect(code).toContain("__DPA__");
  });

  it("handles escape function names with $", () => {
    const renamed = fixture.replace(/RrH/g, "R$H");
    const { code, changed } = transform(renamed);
    expect(changed).toBe(1);
    expect(code).toContain("ANTHROPIC_API_KEY");
    expect(code).toContain("R$H(O)");
    expect(code).toContain("R$H(process.env.ANTHROPIC_API_KEY)");
  });

  it("survives PATH variable name changes (O → P)", () => {
    const renamed = fixture.replace(/RrH\(O\)/g, "RrH(P)").replace("let O =", "let P =");
    const { code, changed } = transform(renamed);
    expect(changed).toBe(1);
    expect(code).toContain("RrH(P)");
    expect(code).toContain("RrH(process.env.ANTHROPIC_API_KEY)");
    expect(code).not.toContain("RrH(O)");
  });

  it("returns 0 changes when pattern not found", () => {
    const { code, changed } = transform("function foo() { return 42; }");
    expect(changed).toBe(0);
    expect(code).toEqual("function foo() { return 42; }");
  });

  it("returns 0 when EnvironmentVariables present but not in daemon plist context", () => {
    const fake = `
    const x = \`<key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>\${foo(O)}</string>
  </dict>\`;
    `;
    const { code, changed } = transform(fake);
    expect(changed).toBe(0);
  });

  it("does not render the marker into plist output (launchd Bootstrap regression)", () => {
    const { code } = transform(fixture);
    // Marker stays in source for grep/idempotency...
    expect(code).toContain("__DPA__");
    // ...but only inside a ${...} substitution, so the rendered quasis are clean.
    const quasis = stripSubstitutions(code);
    expect(quasis).not.toContain("__DPA__");
    expect(quasis).not.toContain("/*");
    expect(quasis).not.toContain("*/");
  });

  it("renders a well-formed plist for every mod/env combination (behavioral)", () => {
    const { code } = transform(fixture);
    const base = {
      label: "com.anthropic.claude-daemon",
      escape: (s) => s,
      exePath: "/bin/claude",
      jsonPath: "/j.json",
      logPath: "/q.log",
      path: "/usr/bin:/bin",
    };
    const cases = [
      { name: "mod disabled", isEnabled: () => false, env: {},
        expectKey: false, expectUrl: false },
      { name: "mod on, both env vars set", isEnabled: () => true,
        env: { ANTHROPIC_API_KEY: "sk-x", ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" },
        expectKey: true, expectUrl: true },
      // An absent API key leaves an empty substitution; no marker text may leak into the XML.
      { name: "mod on, only BASE_URL (incident scenario)", isEnabled: () => true,
        env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" },
        expectKey: false, expectUrl: true },
      { name: "mod on, only API_KEY", isEnabled: () => true,
        env: { ANTHROPIC_API_KEY: "sk-x" },
        expectKey: true, expectUrl: false },
    ];
    for (const c of cases) {
      const plist = renderPlist(code, { ...base, isEnabled: c.isEnabled, env: c.env });
      // Sanity: the PATH env entry is always present.
      expect(plist).toContain("<key>PATH</key>");
      // The add_auth_forwarding mod gates the two extra env entries.
      const hasKey = plist.includes("<key>ANTHROPIC_API_KEY</key>");
      const hasUrl = plist.includes("<key>ANTHROPIC_BASE_URL</key>");
      expect(hasKey).toBe(c.expectKey);
      expect(hasUrl).toBe(c.expectUrl);
      // The real contract: the rendered plist must be well-formed XML.
      assertWellFormed(plist);
    }
  });
});

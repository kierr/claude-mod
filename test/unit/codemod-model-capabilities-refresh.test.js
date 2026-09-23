import { describe, it, expect } from "bun:test";
import {
  runCodemod,
  assertAppliedRegex,
} from "./test-helpers.cjs";

const CODEMOD = new URL(
  "../../codemods/codemod-model-capabilities-refresh.cjs",
  import.meta.url
).pathname;

/**
 * Build a populator-shaped fixture with parametric minified names, mirroring the real
 * fei() in the 2.1.181 baseline: two leading bare-return call guards (gate + traffic),
 * then a try-block that calls `<client>(...).models.list(...)` and logs `[modelCapabilities]`.
 */
function buildPopulator(opts = {}) {
  const {
    gate = "pei",
    traffic = "ta",
    client = "O8",
    tag = "[modelCapabilities]",
    blockConsquent = true, // use `{ return; }` block consequents (vs bare `return;`)
  } = opts;
  const ret = blockConsquent ? "{ return; }" : "return;";
  return `
async function fei() {
  if (!${gate}()) ${ret}
  if (${traffic}()) ${ret}
  try {
    const e = await ${client}({ maxRetries: 1 }).models.list({ betas: [] });
    const n = (e && e.data) || [];
    if (n.length === 0) return;
    console.error("${tag} cached " + n.length + " models");
  } catch {
    console.error("${tag} fetch failed");
  }
}
function ${gate}() { return false; }
function ${traffic}() { return false; }
`;
}

describe("codemod-model-capabilities-refresh", () => {
  it("mod-guards both leading populator guards (default names)", () => {
    const out = runCodemod(CODEMOD, buildPopulator());
    // Both guards rewritten: the mod id appears once per guard.
    const hits = (out.match(/model_capabilities_refresh/g) || []).length;
    expect(hits).toBe(2);
    // The negated mod-guard conjunction appears in both guard tests.
    expect(out).toContain("&& !(typeof __isModEnabled__ === \"function\"");
    // Original gate calls are preserved (still calls pei()/ta()), just now mod-gated.
    expect(out).toMatch(/if \(!pei\(\) &&/);
    expect(out).toMatch(/if \(ta\(\) &&/);
  });

  it("survives minified-name drift (different gate/traffic/client names)", () => {
    const out = runCodemod(
      CODEMOD,
      buildPopulator({ gate: "Z9b", traffic: "Kk", client: "iAn" })
    );
    expect((out.match(/model_capabilities_refresh/g) || []).length).toBe(2);
    expect(out).toMatch(/if \(!Z9b\(\) &&/);
    expect(out).toMatch(/if \(Kk\(\) &&/);
  });

  it("handles bare (non-block) `return;` consequents", () => {
    const out = runCodemod(CODEMOD, buildPopulator({ blockConsquent: false }));
    expect((out.match(/model_capabilities_refresh/g) || []).length).toBe(2);
  });

  it("rewrites a single leading guard robustly (if only one ships upstream)", () => {
    // Only the dead-gate guard, no traffic guard.
    const src = `
async function fei() {
  if (!pei()) { return; }
  try { await O8().models.list({}); } catch {}
}
function pei() { return false; }
`;
    const out = runCodemod(CODEMOD, src);
    expect((out.match(/model_capabilities_refresh/g) || []).length).toBe(1);
    expect(out).toMatch(/if \(!pei\(\) &&/);
  });

  it("is idempotent (second run is a no-op)", () => {
    const once = runCodemod(CODEMOD, buildPopulator());
    const twice = runCodemod(CODEMOD, once);
    // No double-wrapping: mod id count stays at 2.
    expect((twice.match(/model_capabilities_refresh/g) || []).length).toBe(2);
    expect(twice).toBe(once);
  });

  it("does not touch a function without a .models.list() call", () => {
    const src = `
async function unrelated() {
  if (!gate()) { return; }
  if (traffic()) { return; }
  try { await foo().items.fetch({}); } catch {}
}
`;
    const out = runCodemod(CODEMOD, src);
    expect(out).not.toContain("model_capabilities_refresh");
    // Untouched — the gate call stays bare (no mod conjunction) and still returns.
    expect(out).toMatch(/if \(!gate\(\)\)\s*\{\s*return;\s*\}/);
    expect(out).not.toMatch(/gate\(\)\s*&&/);
  });

  it("does not rewrite a non-leading guard after the try-block", () => {
    // A guard AFTER the try block must be left alone — it's not a leading guard.
    const src = `
async function fei() {
  if (!pei()) { return; }
  if (ta()) { return; }
  try { await O8().models.list({}); } catch {}
  if (somethingElse()) { return; }
}
function pei() { return false; }
function ta() { return false; }
`;
    const out = runCodemod(CODEMOD, src);
    // Only the 2 leading guards — the trailing one stays bare.
    expect((out.match(/model_capabilities_refresh/g) || []).length).toBe(2);
    expect(out).toMatch(/if \(somethingElse\(\)\)\s*\{\s*return;\s*\}/);
  });

  it("satisfies the patch YAML applied regex", () => {
    const out = runCodemod(CODEMOD, buildPopulator());
    expect(assertAppliedRegex("model_capabilities_refresh", out)).toBe(true);
  });
});

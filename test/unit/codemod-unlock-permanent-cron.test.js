import { describe, it, expect } from "bun:test";

const MOD_PATH = "../../codemods/codemod-unlock-permanent-cron.cjs";

function buildFixture(names = {}) {
  const h = names.h || "h";
  const m0 = names.m0 || "m0";
  const hH = names.hH || "hH";
  const fn = names.fn || "clH";
  const uuid = names.uuid || "S57";
  const t1H = names.t1H || "t1H";
  const X0 = names.X0 || "X0";
  const iVH = names.iVH || "iVH";
  const v_ = names.v_ || "v_";
  const Si = names.Si || "Si";
  const dlH = names.dlH || "dlH";

  return `
  ${hH}(() => ${h}.strictObject({
    cron: ${h}.string().describe("Standard 5-field cron expression in local time"),
    prompt: ${h}.string().describe("The prompt to enqueue at each fire time."),
    recurring: ${m0}(${h}.boolean().optional()).describe("true (default) = fire on every cron match until deleted or auto-expired after 7 days."),
    durable: ${m0}(${h}.boolean().optional()).describe("true = persist to .claude/scheduled_tasks.json and survive restarts. false (default) = in-memory only.")
  }));
  var Tool = buildTool({
    name: toolName,
    async call({
      cron: H,
      prompt: _,
      recurring: q = true,
      durable: K = false
    }) {
      let O = K && ${t1H}();
      let T = await ${fn}(H, _, q, O, ${X0}()?.agentId);
      return { data: { id: T } };
    }
  });
  async function ${fn}(H, _, q, K, O) {
    let T = ${uuid}.randomUUID().slice(0, 8);
    let $ = {
      id: T,
      cron: H,
      prompt: _,
      createdAt: Date.now(),
      ...(q && { recurring: true })
    };
    if (!K) {
      addSessionTask({ ...$, ...(O && { agentId: O }) });
      return T;
    }
    let z = await ${iVH}();
    z.push({
      ...$,
      createdBySessionId: ${v_}(),
      createdByPid: process.pid,
      createdByProcStart: ${Si}()
    });
    await ${dlH}(z);
    return T;
  }
`;
}

describe("codemod-unlock-permanent-cron", () => {
  it("adds permanent to schema, call(), and addCronTask", async () => {
    const mod = require(MOD_PATH);
    const code = buildFixture();
    const result = mod.transform(code);
    expect(result.changed).toBe(3);
    // Schema has permanent field
    expect(result.code).toContain('permanent: m0(h.boolean().optional()).describe("true = exempt from 7-day auto-expiry');
    // call() has Pm destructuring
    expect(result.code).toContain("permanent: Pm = false");
    // addCronTask has Pm parameter
    expect(result.code).toContain("async function clH(H, _, q, K, O, Pm)");
    // addCronTask has guarded permanent in push
    expect(result.code).toContain('__isModEnabled__("unlock_permanent_cron")');
    expect(result.code).toContain("permanent: true");
  });

  it("is idempotent — returns changed: 0 on already-patched code", async () => {
    const mod = require(MOD_PATH);
    const code = buildFixture();
    const first = mod.transform(code);
    expect(first.changed).toBe(3);
    const second = mod.transform(first.code);
    expect(second.changed).toBe(0);
  });

  it("works with different minified names", async () => {
    const mod = require(MOD_PATH);
    const code = buildFixture({
      h: "Z",
      m0: "b7",
      hH: "lZ",
      fn: "kQ9",
      uuid: "R3",
      t1H: "wP2",
      X0: "nM1",
      iVH: "aK8",
      v_: "hT4",
      Si: "uR6",
      dlH: "fY2",
    });
    const result = mod.transform(code);
    expect(result.changed).toBe(3);
    expect(result.code).toContain("async function kQ9(H, _, q, K, O, Pm)");
    expect(result.code).toContain('__isModEnabled__("unlock_permanent_cron")');
    expect(result.code).toContain("permanent: true");
  });

  it("returns changed: 0 when anchor not found", async () => {
    const mod = require(MOD_PATH);
    const result = mod.transform("const x = 1;");
    expect(result.changed).toBe(0);
  });
});

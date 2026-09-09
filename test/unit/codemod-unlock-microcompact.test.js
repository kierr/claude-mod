import { describe, it, expect } from "bun:test";
import path from "path";

const CODEMOD_PATH = path.join(process.cwd(), "codemods/codemod-unlock-microcompact.cjs");
const { transform } = require(CODEMOD_PATH);

const PATCH_ID = "unlock_microcompact";

const TIMEOUT = 5000;

/**
 * Build a fixture matching the four patch targets in the deobfuscated bundle.
 * Configurable minified names to verify resilience across releases.
 */
function buildFixture(names = {}) {
  const {
    flagResolver = "L_",
    clearedVar = "ki8",
    persistedVar = "kQ3",
    thresholdVar = "Vi8",
    countVar = "VQ3",
    buildParamArg = "T",
    falseVar = "K",
    toolSetVar = "NQ3",
    closureVar = "H",
  } = names;

  // Keep the declaration before its deferred Set assignment to test bounded
  // variable discovery. The controller binding is located through its querySource
  // access after buildRequestParams.
  return `function V84() {
    return ${flagResolver}("tengu_hazel_osprey", false);
  }
  function N84() {
    return ${flagResolver}("tengu_hazel_osprey_floor", uXO);
  }
  var ${clearedVar} = "[Old tool result content cleared]";
  var ${persistedVar} = "<persisted-output>";
  var ${thresholdVar} = 20000;
  var ${countVar} = 2000;
  var ${toolSetVar};
  var gR6 = R(() => {
    QA();
    HT();
    rP();
    ${toolSetVar} = new Set(["Read", "Write", "Edit", "Bash"]);
  });
  function pXO(${closureVar}) {
    return {
      buildRequestParams(${buildParamArg}) {
        ${falseVar} = false;
        if (!_ || q) return null;
        return {};
      },
      async onRequestError(T, $) {
        return { querySource: ${closureVar}.querySource };
      }
    };
  }
`;
}

// Full-bundle shape: the fetch chokepoint (Patch E) lives in a different
// region (SDK fetchWithTimeout) than the microcompact module; append it to
// the standard fixture. Only the full 5-site shape earns the
// __mct_patched__ marker (REQUIRED_CHANGES gate).
function buildCaptureFixture() {
  return buildFixture() + `
  async fetchWithTimeout(z, w) {
    return await this.fetch.call(undefined, z, w);
  }
`;
}

describe("codemod-unlock-microcompact", () => {
  describe("Patch A — Inject time-based MC function", () => {
    it("should inject __mcTimeBasedMutate function", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code, changed } = transform(input);

      expect(changed).toBeGreaterThanOrEqual(1);
      expect(code).toContain("function __mcTimeBasedMutate");
    });

    it("should include configurable gap threshold with 30-min default", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);

      expect(code).toContain("time_threshold_min");
      expect(code).toContain("gapMin");
      expect(code).toContain("gap < gapMin");
      expect(code).toContain("30");
    });

    it("should check repl_main_thread querySource", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);

      expect(code).toContain("repl_main_thread");
    });

    it("should use discovered tool-name Set for compactable tools", { timeout: TIMEOUT }, () => {
      const toolSetVar = "NQ3";
      const input = buildFixture({ toolSetVar });
      const { code } = transform(input);

      // The codemod discovers the Set variable dynamically — the injected
      // function must use it to filter tool_use to compactable tools only.
      expect(code).toContain(`${toolSetVar}.has(b.name)`);
    });

    it("should skip tool-name filter when no Set is discoverable", { timeout: TIMEOUT }, () => {
      // Fixture without the Set assignment — codemod falls back to matching all tool_use
      const input = `function V84() {
    return L_("tengu_hazel_osprey", false);
  }
  function N84() {
    return L_("tengu_hazel_osprey_floor", uXO);
  }
  var ki8 = "[Old tool result content cleared]";
  var kQ3 = "<persisted-output>";
  var Vi8 = 20000;
  var VQ3 = 2000;
  function pXO(H) {
    return {
      buildRequestParams(T) {
        K = false;
        if (!_ || q) return null;
        return {};
      },
      async onRequestError(T, $) {
        return { querySource: H.querySource };
      }
    };
  }
`;
      const { code, changed } = transform(input);

      expect(changed).toBeGreaterThanOrEqual(1);
      expect(code).toContain("b.type === \"tool_use\")");
      expect(code).not.toContain(".has(b.name)");
    });

    it("should reference ki8 for cleared content", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);

      expect(code).toContain("bl.content = ki8");
    });

    it("should be placed after the threshold constants", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);

      const clearedIdx = code.indexOf("[Old tool result content cleared]");
      const funcIdx = code.indexOf("function __mcTimeBasedMutate");
      expect(funcIdx).toBeGreaterThan(clearedIdx);
    });
  });

  describe("Patch B — Wire time-based check into buildRequestParams", () => {
    it("should add __mcTimeBasedMutate call in buildRequestParams", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code, changed } = transform(input);

      expect(changed).toBeGreaterThanOrEqual(1);
      expect(code).toContain("__mcTimeBasedMutate");
      expect(code).toContain("H.querySource");
    });

    it("should pass the messages parameter to the function", { timeout: TIMEOUT }, () => {
      const input = buildFixture({ buildParamArg: "msgs" });
      const { code } = transform(input);

      expect(code).toContain("__mcTimeBasedMutate(msgs, H.querySource)");
    });

    it("should preserve existing method body", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);

      expect(code).toContain("K = false;");
    });
  });

  describe("Patch C — Force-enable context hint", () => {
    it("should add mod guard to tengu_hazel_osprey return", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code, changed } = transform(input);

      expect(changed).toBeGreaterThanOrEqual(1);
      expect(code).toContain('__isModEnabled__("unlock_microcompact")');
    });

    it("should preserve the original flag resolver call as fallback", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);

      expect(code).toContain('L_("tengu_hazel_osprey", false)');
    });

    it("should work with different minified resolver names", { timeout: TIMEOUT }, () => {
      const input = buildFixture({ flagResolver: "xZ7" });
      const { code, changed } = transform(input);

      expect(changed).toBeGreaterThanOrEqual(1);
      expect(code).toContain("__isModEnabled__");
    });
  });

  describe("Patch D — Make tokens-saved threshold configurable", () => {
    it("should replace hardcoded 20000 with __getModConfig__ call", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code, changed } = transform(input);

      expect(changed).toBeGreaterThanOrEqual(1);
      expect(code).toContain('__getModConfig__("unlock_microcompact", "tokens_saved_threshold", 20000)');
      expect(code).not.toMatch(/var \w+ = 20000;/);
    });

    it("should preserve the cleared content marker string", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);

      expect(code).toContain("[Old tool result content cleared]");
    });

    it("should work with different minified variable names", { timeout: TIMEOUT }, () => {
      const input = buildFixture({
        clearedVar: "xK1",
        persistedVar: "mP9",
        thresholdVar: "ZB4",
      });
      const { code, changed } = transform(input);

      expect(changed).toBeGreaterThanOrEqual(1);
      expect(code).toContain("ZB4 = (typeof __getModConfig__");
    });
  });

  describe("Patch A — adaptive policy resolver", () => {
    it("should inject __mcResolvePolicy resolver", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);

      expect(code).toContain("function __mcResolvePolicy");
    });

    it("should expose mode/provider_cache/context_window config keys", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);

      expect(code).toContain('"mode", "auto"');
      expect(code).toContain('"provider_cache", "auto"');
      expect(code).toContain('"context_window", 0)');
    });

    it("should gate mutation on policy.enabled", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);

      expect(code).toContain("__mcResolvePolicy()");
      expect(code).toContain("policy.enabled === false");
    });

    it("should encode the four-cell auto matrix", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);

      // large+cached -> off ; large+none -> idle ; small+cached -> gentle ; small+none -> aggressive
      expect(code).toContain('{ enabled: false, mode: "off" }');
      expect(code).toContain('{ enabled: true, mode: "idle" }');
      expect(code).toContain('{ enabled: true, mode: "gentle" }');
      expect(code).toContain('{ enabled: true, mode: "aggressive" }');
    });

    it("should tune gap/keep by policy mode", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { code } = transform(input);

      expect(code).toContain('policy.mode === "aggressive" && gapMin > 10');
      expect(code).toContain('policy.mode === "gentle" && keepN < 20');
    });

    it("should keep patch count at 4 (resolver folds into Patch A)", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { changed } = transform(input);

      expect(changed).toBe(4);
    });
  });

  describe("Patch E — dynamic model capture + profile", () => {

    it("injects __mcCaptureModel call gated on /v1/messages at the chokepoint", { timeout: TIMEOUT }, () => {
      const input = buildCaptureFixture();
      const { code, changed } = transform(input);

      expect(changed).toBe(5); // 4 microcompact + 1 capture site
      expect(code).toContain("__mcCaptureModel");
      expect(code).toContain('indexOf("/v1/messages")');
      expect(code).toContain("count_token");
      // holder/URL/OPTS identifiers captured, not hardcoded
      expect(code).toContain("__mcCaptureModel(w.body)");
    });

    it("defines the capture receiver, active-model global, and profile table", { timeout: TIMEOUT }, () => {
      const { code } = transform(buildFixture());

      expect(code).toContain("globalThis.__mcActiveModel");
      expect(code).toContain("globalThis.__mcCaptureModel");
      expect(code).toContain("function __mcProfile");
      expect(code).toContain("/^glm-5/i");
      expect(code).toContain("/^claude/i");
    });

    // Extract __mcProfile + __mcResolvePolicy from the patched output and eval
    // them together so the resolver can see the profile, with globalThis mocks.
    function extractFn(src, name) {
      const start = src.indexOf("function " + name);
      if (start === -1) throw new Error(name + " not found");
      let depth = 0, saw = false, end = -1;
      for (let i = start; i < src.length; i++) {
        if (src[i] === "{") { saw = true; depth++; }
        else if (src[i] === "}") { depth--; if (saw && depth === 0) { end = i + 1; break; } }
      }
      return src.slice(start, end);
    }
    function evalResolver(outputCode) {
      const body = extractFn(outputCode, "__mcProfile") + "\n" + extractFn(outputCode, "__mcResolvePolicy");
      return new Function(body + "\n; return __mcResolvePolicy;")();
    }

    it("resolves the matrix from the live model slug (no static config)", { timeout: TIMEOUT }, () => {
      const { code } = transform(buildFixture());
      const resolve = evalResolver(code);
      const origCfg = globalThis.__getModConfig__;
      const origModel = globalThis.__mcActiveModel;
      globalThis.__getModConfig__ = (m, k, d) => d; // no overrides -> defaults drive (mode auto, ctx 0, pc auto)

      try {
        globalThis.__mcActiveModel = "glm-5.2";
        expect(resolve()).toEqual({ enabled: false, mode: "off" }); // 1M + cached

        globalThis.__mcActiveModel = "glm-4.6";
        let p = resolve();
        expect(p.enabled).toBe(true);
        expect(p.mode).toBe("gentle"); // 200K + cached

        globalThis.__mcActiveModel = "claude-opus-4";
        p = resolve();
        expect(p.mode).toBe("gentle"); // 200K + 1h cached

        globalThis.__mcActiveModel = "some-unknown-model";
        p = resolve();
        expect(p.enabled).toBe(true); // unknown window -> small path; cache unknown -> base detect -> cached -> gentle
      } finally {
        globalThis.__getModConfig__ = origCfg;
        globalThis.__mcActiveModel = origModel;
      }
    });

    it("static context_window/provider_cache override the profile lookup", { timeout: TIMEOUT }, () => {
      const { code } = transform(buildFixture());
      const resolve = evalResolver(code);
      const origCfg = globalThis.__getModConfig__;
      const origModel = globalThis.__mcActiveModel;

      try {
        // glm-5.2 profile is 1M; force 200K via override -> gentle
        globalThis.__mcActiveModel = "glm-5.2";
        globalThis.__getModConfig__ = (m, k, d) => (k === "context_window" ? 200000 : d);
        expect(resolve().mode).toBe("gentle");

        // glm-5.2 profile 1M + cached; force no-cache -> idle
        globalThis.__getModConfig__ = (m, k, d) => (k === "provider_cache" ? "none" : d);
        expect(resolve().mode).toBe("idle");
      } finally {
        globalThis.__getModConfig__ = origCfg;
        globalThis.__mcActiveModel = origModel;
      }
    });
  });

  describe("all four patches together", () => {
    it("should report changed=4 when all patches apply", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const { changed } = transform(input);

      expect(changed).toBe(4);
    });
  });

  describe("idempotency", () => {
    it("should return changed=0 on second application", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const first = transform(input);

      expect(first.changed).toBe(4);

      const second = transform(first.code);
      expect(second.changed).toBe(0);
    });

    it("should produce identical output on repeated runs", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const once = transform(input).code;
      const twice = transform(once).code;
      const thrice = transform(twice).code;

      expect(once).toBe(twice);
      expect(twice).toBe(thrice);
    });
  });

  describe("no-match cases", () => {
    it("should not transform code without targets", { timeout: TIMEOUT }, () => {
      const input = `function test() { return true; }`;
      const { code, changed } = transform(input);

      expect(changed).toBe(0);
      expect(code).toBe(input);
    });

    it("should not transform empty code", { timeout: TIMEOUT }, () => {
      const { code, changed } = transform("");

      expect(changed).toBe(0);
      expect(code).toBe("");
    });

    it("should apply available patches when some targets are missing", { timeout: TIMEOUT }, () => {
      // Only has threshold target, not buildRequestParams or context hint
      const input = `var ki8 = "[Old tool result content cleared]";
var kQ3 = "<persisted-output>";
var Vi8 = 20000;
var VQ3 = 2000;
`;
      const { code, changed } = transform(input);

      // Patch A (inject function) + Patch D (threshold) should apply
      // Patch B (buildRequestParams) + Patch C (context hint) won't
      expect(changed).toBeGreaterThanOrEqual(2);
      expect(code).toContain("__getModConfig__");
      expect(code).toContain("__mcTimeBasedMutate");
    });
  });

  describe("patch YAML status_test regex round-trip", () => {
    const { assertAppliedRegex, getApplicableRegex } = require("./test-helpers.cjs");

    it("applied regex should match patched output", { timeout: TIMEOUT }, () => {
      // Round-trip needs the full 5-site shape (capture fixture): the
      // marker gate requires all REQUIRED_CHANGES sub-patches.
      const input = buildCaptureFixture();
      const { code } = transform(input);

      assertAppliedRegex(PATCH_ID, code);
    });

    it("applicable regex should match unpatched fixture", { timeout: TIMEOUT }, () => {
      const input = buildFixture();
      const applicableRegex = getApplicableRegex(PATCH_ID);

      expect(applicableRegex).not.toBeNull();
      expect(applicableRegex.test(input)).toBe(true);
    });
  });
});

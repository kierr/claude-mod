import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const CODEMOD_PATH = path.join(
  process.cwd(),
  "codemods/codemod-subagent-show-model.cjs"
);

const TIMEOUT = 30000;

// Resolve Babel deps from codemods workspace (same as engine.cjs)
const CODEMODS_DIR = path.join(process.cwd(), "codemods");
function babelRequire(pkg) {
  const p = path.join(CODEMODS_DIR, "node_modules", "@babel", pkg);
  try { return require(p); } catch { return require("@babel/" + pkg); }
}
const parser = babelRequire("parser");
const generate = babelRequire("generator").default;

function transformViaImport(inputCode) {
  const { transform } = require(CODEMOD_PATH);
  const ast = parser.parse(inputCode, {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript"],
  });
  transform(ast);
  const code = generate(ast, { retainLines: false }, inputCode).code;
  return { code };
}

describe("codemod-subagent-show-model", () => {
  function runCodemod(inputCode) {
    const tempInput = path.join(
      process.cwd(),
      "test/fixtures",
      `temp-input-${randomUUID()}.js`
    );
    const tempOutput = path.join(
      process.cwd(),
      "test/fixtures",
      `temp-output-${randomUUID()}.js`
    );

    fs.mkdirSync(path.join(process.cwd(), "test/fixtures"), { recursive: true });
    fs.writeFileSync(tempInput, inputCode);

    try {
      const { execSync } = require("child_process");
      execSync(`node "${CODEMOD_PATH}" "${tempInput}" "${tempOutput}"`, {
        stdio: "pipe",
        cwd: process.cwd(),
      });

      const output = fs.readFileSync(tempOutput, "utf8");
      fs.unlinkSync(tempInput);
      fs.unlinkSync(tempOutput);
      return output;
    } catch (error) {
      if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
      if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
      throw error;
    }
  }

  // Minimal fixture with all three injection points
  function buildFixture(names = {}) {
    const {
      hookName = "getModel",
      storeName = "store",
      reactName = "React",
      textComp = "Text",
      boxComp = "Box",
      connComp = "Tree",
      cacheModule = "cache",
      cacheProp = "c",
    } = names;

    return `
      function ${hookName}() {
        let q = ${storeName}(s => s.mainLoopModel);
        let K = ${storeName}(s => s.mainLoopModelForSession);
        return K ?? q;
      }

      function ${cacheModule}() { return []; }

      function dataFunc(H, _) {
        let { shouldAnimate: q, tools: K } = _;
        let O = H.map(({ param: j, isResolved: J, isError: D, progressMessages: M, result: f }) => {
          let X = toolCount(M);
          let Z = schema().safeParse(j.input);
          let W = f?.status === "teammate_spawned";
          let G;
          let L;
          if (W && Z.success && Z.data.name) {
            G = "@" + Z.data.name;
            let S = Z.data.subagent_type;
            L = S ? S : undefined;
          } else {
            G = Z.success ? Z.data.subagent_type : "Agent";
            L = Z.success ? Z.data.description : undefined;
          }
          let m = Z.success && "run_in_background" in Z.data;
          return {
            id: j.id,
            agentType: G,
            description: L,
            toolUseCount: X.toolUseCount,
            tokens: X.tokens,
            isResolved: J,
            isAsync: m
          };
        });
        return ${reactName}.createElement(${boxComp}, null,
          O.map((j, i) => ${reactName}.createElement(FC7, {
            key: j.id,
            agentType: j.agentType,
            description: j.description,
            toolUseCount: j.toolUseCount,
            tokens: j.tokens,
            isLast: i === O.length - 1
          }))
        );
      }

      function FC7(H) {
        let _ = ${cacheModule}.${cacheProp}(8);
        let {
          agentType: q,
          description: K,
          toolUseCount: z,
          tokens: A,
          isLast: w
        } = H;
        let v;
        if (_[0] !== q || _[1] !== K) {
          v = ${reactName}.createElement(${reactName}.Fragment, null,
            ${reactName}.createElement(${textComp}, { dimColor: true }, q),
            K && ${reactName}.createElement(${reactName}.Fragment, null, " (", ${reactName}.createElement(${textComp}, null, K), ")")
          );
          _[0] = q;
          _[1] = K;
          _[2] = v;
        } else {
          v = _[2];
        }
        let C;
        if (_[3] !== w) {
          C = !w && ${reactName}.createElement(${connComp}, {
            connectors: [w ? "last" : "branch"]
          }, ${reactName}.createElement(${textComp}, {
            dimColor: true
          }, "done"));
          _[3] = w;
        } else {
          C = _[4];
        }
        let m;
        if (_[5] !== v || _[6] !== C) {
          m = ${reactName}.createElement(${boxComp}, {
            flexDirection: "column",
            paddingLeft: 3
          }, v, C);
          _[5] = v;
          _[6] = C;
          _[7] = m;
        } else {
          m = _[7];
        }
        return m;
      }
    `;
  }

  describe("model display hook discovery", () => {
    it("finds hook with standard names", { timeout: TIMEOUT }, () => {
      const output = runCodemod(buildFixture());
      expect(output).toContain("display_model_name");
      expect(output).toContain("__sessionModel__");
    });

    it("finds hook with different minified names", { timeout: TIMEOUT }, () => {
      const output = runCodemod(buildFixture({
        hookName: "ABC",
        storeName: "XYZ",
      }));
      expect(output).toContain("__sessionModel__");
      expect(output).toContain("ABC()");
    });

    it("throws when model hook is not found", { timeout: TIMEOUT }, () => {
      const input = `
        function noHook() { return 42; }
        function FC7(H) { let _ = cache.c(4); return null; }
      `;
      expect(() => runCodemod(input)).toThrow(/Could not find model display hook/);
    });
  });

  describe("data function modification", () => {
    it("adds model extraction to returned object", { timeout: TIMEOUT }, () => {
      const output = runCodemod(buildFixture());
      // Should have: model: Z.success ? Z.data?.model : undefined
      expect(output).toContain("Z.success ? Z.data?.model : undefined");
    });

    it("uses correct parsed variable name with different names", { timeout: TIMEOUT }, () => {
      const input = `
        function hook() {
          let q = store(s => s.mainLoopModel);
          let K = store(s => s.mainLoopModelForSession);
          return K ?? q;
        }
        function dataFunc(H, _) {
          let O = H.map(({ param: j }) => {
            let myParsed = schema().safeParse(j.input);
            return {
              id: j.id,
              agentType: myParsed.success ? myParsed.data.subagent_type : "Agent",
              description: myParsed.success ? myParsed.data.description : undefined,
              toolUseCount: 0
            };
          });
          return null;
        }
      `;
      const output = runCodemod(input);
      expect(output).toContain("myParsed.success ? myParsed.data?.model : undefined");
    });
  });

  describe("caller modification", () => {
    it("adds model prop to FC7 createElement call", { timeout: TIMEOUT }, () => {
      const output = runCodemod(buildFixture());
      expect(output).toMatch(/model: j\.model/);
    });
  });

  describe("FC7 component modification", () => {
    it("adds model to destructured props", { timeout: TIMEOUT }, () => {
      const output = runCodemod(buildFixture());
      expect(output).toContain("model: __explicitModel__");
    });

    it("injects model hook call unconditionally", { timeout: TIMEOUT }, () => {
      const output = runCodemod(buildFixture());
      expect(output).toMatch(/let __sessionModel__ = \w+\(\)/);
    });

    it("uses mod guard with typeof check", { timeout: TIMEOUT }, () => {
      const output = runCodemod(buildFixture());
      expect(output).toContain('typeof __isModEnabled__ === "function"');
      expect(output).toContain("display_model_name");
    });

    it("falls back to session model when no explicit model", { timeout: TIMEOUT }, () => {
      const output = runCodemod(buildFixture());
      expect(output).toContain("__explicitModel__ ?? __sessionModel__");
    });

    it("adds model display element after cached content", { timeout: TIMEOUT }, () => {
      const output = runCodemod(buildFixture());
      expect(output).toContain("__modelEl__");
      expect(output).toContain("__resolvedModel__");
    });

    // Regression: matcher must not depend on the literal cache-slot name "c".
    // Webcrack has historically preserved React-Compiler's <obj>.c(<slot>)
    // convention, but a future webcrack or React-Compiler release renaming
    // the accessor would silently fail the matcher (codemod returns 0,
    // patch skips). The matcher now uses structure (member-call with id
    // object + single numeric arg) — verify with a non-"c" property.
    it("matches FC7 when cache-slot accessor is renamed (not literal 'c')", { timeout: TIMEOUT }, () => {
      const output = runCodemod(buildFixture({ cacheProp: "d" }));
      expect(output).toContain("model: __explicitModel__");
      expect(output).toContain("__sessionModel__");
    });
  });

  describe("mod guard behavior", () => {
    it("early returns when no resolved model (mod disabled)", { timeout: TIMEOUT }, () => {
      const output = runCodemod(buildFixture());
      // The code should have: if (!__resolvedModel__) { return m; }
      // Then: return createElement(Box, ..., m, __modelEl__)
      expect(output).toMatch(/if\s*\(\s*!__resolvedModel__\s*\)/);
      expect(output).toMatch(/return[\s\S]*Box[\s\S]*__modelEl__/);
    });

    it("resolves to undefined (not __explicitModel__) when mod is disabled", { timeout: TIMEOUT }, () => {
      const output = runCodemod(buildFixture());
      // The ternary false branch must be "undefined" so that when the mod is disabled,
      // __resolvedModel__ is always falsy and the early return fires — even if an
      // explicit model was specified in the Agent tool call. This matches stock behavior.
      expect(output).toMatch(/__sessionModel__\s*:\s*undefined\b/);
    });
  });

  describe("edge cases", () => {
    it("handles code with no target patterns gracefully", { timeout: TIMEOUT }, () => {
      const input = `
        function hook() {
          let q = store(s => s.mainLoopModel);
          let K = store(s => s.mainLoopModelForSession);
          return K ?? q;
        }
        const x = 42;
      `;
      // Should not throw — just not modify anything
      expect(() => runCodemod(input)).not.toThrow();
    });

    it("does not match hook with only mainLoopModel", { timeout: TIMEOUT }, () => {
      const input = `
        function partialHook() {
          let q = store(s => s.mainLoopModel);
          return q;
        }
      `;
      expect(() => runCodemod(input)).toThrow(/Could not find model display hook/);
    });
  });

  describe("idempotency", () => {
    it("produces stable output on repeated runs", { timeout: TIMEOUT }, () => {
      const code = buildFixture();
      const { code: once } = transformViaImport(code);
      const { code: twice } = transformViaImport(once);
      const { code: thrice } = transformViaImport(twice);

      expect(once).toBe(twice);
      expect(twice).toBe(thrice);
    });

    it("does not add duplicate model properties", { timeout: TIMEOUT }, () => {
      const code = buildFixture();
      const { code: first } = transformViaImport(code);
      // Count occurrences of "model:" in the data function return object
      const modelCount = (first.match(/model:\s*[\w.]+\??\.model/g) || []).length;
      expect(modelCount).toBe(1);
    });
  });
});

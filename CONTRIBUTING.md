# Contributing to claude-mod

The first release supports Claude Code **2.1.181 on macOS**. Code-split binaries (2.1.242+) are partially supported: 43/44 patches apply on 2.1.277, with remaining gaps tracked in `CODESPLIT_SKIP_PATCHES`. Linux runtime support requires separate verification.

## Scope

Use an official setting or environment variable when one provides the behavior you need; check the [upstream settings reference](https://code.claude.com/docs/en/settings) before adding a patch. Contributions should improve the tool or change behavior with no supported configuration path.

Never include upstream bundles, extracted/deobfuscated code, prompt dumps, copied excerpts, binary deltas, or cache contents. Tests must use hand-written synthetic fixtures. Redact credentials and private session data from reports.

## Development

```sh
bun install --frozen-lockfile
bun test
node bin/lint-codemods.cjs
node bin/fixture-audit.cjs
actionlint
```

Production modules use CommonJS; tests use `bun:test`. Match the surrounding two-space indentation. Keep changes focused and use conventional commit messages.

## Adding a patch

```sh
claude-mod new-patch my_patch
```

The scaffold creates a YAML definition in `patches/`, a transform in `codemods/`, and a unit test. Definitions declare identity, execution order, status tests, and Mods-panel configuration. Codemods implement the transformation. The complete ordered patch set must compose correctly; users enable behavior through the Mods panel rather than selecting a different patch batch.

Requirements:

- Choose the right engine (see **Engine selection** below).
- Keep original behavior when the mod is disabled. Guard calls to injected helpers with `typeof __isModEnabled__ === "function"`.
- Make transforms idempotent and report whether they changed the input.
- An `applied` status test must fail on the synthetic unpatched input and pass on the transformed output. Verify every injection when a transform changes several sites.
- Regex transforms must not match function bodies with `[^]*` or `[\s\S]*?`; use bounded structural traversal. Use function replacers for replacement text containing `$`.
- Test enabled and disabled behavior, near-miss inputs, structural variation, and interaction with the full batch. Syntax validity alone does not establish semantic correctness.

### Engine selection

The engine parses the full bundle once and applies all Babel transforms on the shared AST, generates once, then applies regex transforms sequentially on the resulting string. Babel parsing + generation of the ~25 MB deobfuscated bundle costs ~72 seconds; each regex transform costs ~10 ms. Choose regex unless the transform needs something only Babel provides.

**Use regex when** (the common case — 18 of 22 codemods):

- The transform anchors on a **stable string literal** (env var name, property name like `readFileState`, string value like `"API Usage Billing"`) and discovers minified names from nearby context. Regex does this equally well: find the anchor, extract the minified name with a capture group, substitute back.
- The transform injects or wraps a **contiguous code region** — a guard before an if-statement, a variable declaration after another, a ternary wrapping a condition. Regex with `code.substring()` and offset arithmetic handles this directly.
- The transform needs **function-level scope** (not variable binding). A brace-depth scan (walk back to the nearest `{` preceded by `function` or `=>`, forward to its matching `}`) is equivalent to `fnPath.node.body` for containment checks.
- The transform discovers names by **structural pattern** (a call signature, an assignment shape, a return-value form) rather than by resolving references across scopes.

**Use Babel when** (4 remaining codemods):

- The transform resolves **cross-scope references** — e.g., following a variable binding to its declaration across nested blocks, or checking whether an identifier refers to a specific import. `getBinding()` / `scope.hasBinding()` have no regex equivalent.
- The transform performs **multi-pass discovery with inter-transform ordering** where a later transform's target is the *mutation* of an earlier transform on the same AST node. Babel's in-place mutation makes this natural; regex would require fragile string-state tracking between phases.
- The transform injects **large, nested AST subtrees** (entire React component trees with JSX, deeply nested conditionals) that would require constructing the entire output as a string literal — error-prone and hard to maintain versus Babel's `t.*` builders.
- The transform needs **semantic type information** (`isIdentifier`, `isConditionalExpression`, etc.) to discriminate between nodes that have identical surface syntax but different AST roles (e.g., a property name vs. a variable name that happen to use the same identifier).

**Decision tree:**

1. Does the transform resolve variable bindings across scopes? → **Babel**
2. Does the transform inject more than ~30 lines of structured code (components, nested conditionals) in a single insertion? → **Babel** (unless the injection is a self-contained string literal you can inject wholesale)
3. Does the transform need to understand node types beyond what a string pattern captures? → **Babel**
4. Does the transform have multiple phases that mutate the same node, with later phases depending on earlier mutations? → **Babel**
5. Otherwise — anchor on a stable string, discover minified names from context, splice the output — → **Regex**

**Mixed-engine wrappers** are legitimate: a wrapper codemod (e.g., `display_model_name`) can chain regex sub-codemods via string passing and Babel sub-codemods via parse→transform→generate. The wrapper exposes the regex contract (`transform(code) → { code, changed }`) regardless of internal engine choice. Set `engine: "regex"` in the YAML so the engine treats it as a regex codemod; the wrapper handles its own Babel internally.

**Regex contract:** `transform(code: string) → { code: string, changed: number }`
**Babel contract:** `transform(ast, code: string) → number | { changed: number }`

Before submitting a runtime change, run the source checks above and the local macOS release check:

```sh
mise run gate:version-compat
mise run gate:fresh-install
```

The fresh-install gate installs the actual tarball in a disposable HOME, exercises download/extraction/deobfuscation, checks offline version/help, loads native bindings, and restores an installed version after cache removal. It downloads dependencies but does not invoke inference; a cached baseline is not a substitute.

Expected batch outcome for 2.1.181: **43 applied, 0 failed, 1 version-gated skip** (`model_picker_search`). Validate the patched CLI's offline `--version` and `--help`, and manually exercise the changed behavior. Do not invoke billed inference merely as a smoke test.

## Releases and reports

CI checks source, workflows, fixtures, secrets, and package contents on Linux; that is not a Linux runtime certification. Publication is tag-triggered and depends on the source checks. Never add caches or uploaded artifacts containing upstream-derived code.

Report failures with the tool version, upstream version, platform, failing stage, and patch ID. Redact logs and use synthetic reproductions—do not attach bundle excerpts. Explicit compatibility work must establish a verified baseline before changing `last-tested-version`.

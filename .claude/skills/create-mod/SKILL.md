---
name: create-mod
description: >
  Author a new claude-mod patch: scaffold the YAML + codemod + test, find stable
  anchors in the deobfuscated bundle, write the applicable/applied status tests,
  implement the transform, and verify it composes with the full patch batch. Use
  this skill when the user asks to "add a mod", "create a new patch", "write
  a new mod", "un-nerf X", "re-enable Y", or "expose Z as a toggle". Also
  triggers on "how do I add a mod" or mention of patching a currently-ungated
  feature.
---

# Create a New Mod

A mod is a patch that transforms the deobfuscated Claude Code CLI bundle to
re-enable, expose, or configure behavior. Each mod is three files: a YAML
definition, a codemod transform, and a unit test. The complete ordered patch
set applies together; users toggle behavior at runtime through the Mods panel
rather than selecting a different patch batch.

## When This Runs

- Adding a new mod to re-enable a gated/disabled feature
- Exposing a runtime-configurable toggle for something otherwise unconfigurable
- The user says "un-nerf X", "re-enable Y", "add a mod for Z"

## Before You Start

Check whether an official setting or environment variable already provides the
behavior. The upstream [settings reference](https://code.claude.com/docs/en/settings)
covers many cases, and `patches/env-catalog.json` curates the Environment-tab
surface. If a config path exists, prefer it over a patch — a patch should
change behavior with no supported configuration path.

The Environment tab (`mods_env_panel` patch) surfaces env vars with resolved
value, source layer, restart-required badge, and in-place editing. If the new
mod is "expose env var X in the UI," it may belong in `env-catalog.json` rather
than a new patch.

## Full Workflow

### Step 1: Scaffold

```bash
claude-mod new-patch my_patch
```

This creates three files (all fail closed until you fill the anchors):
- `patches/my_patch.yaml` — YAML definition with `TODO_APPLIED_MARKER` /
  `TODO_APPLICABLE_ANCHOR` placeholders
- `codemods/codemod-my-patch.cjs` — regex-engine transform stub returning
  `changed: 0`
- `test/unit/codemod-my-patch.test.js` — unit test asserting fail-closed
  behavior

Use a `snake_case` id. The scaffold compiles and fails closed by design —
`CONTRIBUTING.md` describes the requirements the filled-in patch must meet.

### Step 2: Find stable anchors in the deobfuscated bundle

Ensure the baseline exists for the supported version:
```bash
claude-mod patch 2.1.181 --verbose   # downloads + deobfuscates if needed
```

The deobfuscated file is at:
```
~/.cache/claude-mod/2.1.181/baseline/deobfuscated.js
```

Search for the feature you want to un-nerf using **stable anchors** — string
literals and property names that survive minification:
- Env var names: `process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
- Property names: `.model`, `.status`, `.readFileState`
- UI labels and string values: `"API Usage Billing"`, `"Status"`, `"Config"`
- Config keys: `FALLBACK_FOR_ALL_PRIMARY_MODELS`

```bash
rg -P '<stable anchor>' ~/.cache/claude-mod/2.1.181/baseline/deobfuscated.js
```

Use ripgrep (`rg -P`) for regex searches; BSD grep on macOS has no `-P`.

Examine the surrounding code to understand the gate you're removing or the
value you're overriding. Note the minified identifier names nearby — you'll
capture them with `\w+` or `[\w$]+` in the codemod, never hardcode them.

### Step 3: Choose the engine

The engine parses the full bundle once and applies all Babel transforms on the
shared AST, generates once, then applies regex transforms sequentially. Babel
parsing + generation of the ~25 MB bundle costs ~72 seconds; each regex
transform costs ~10 ms. **Choose regex unless the transform needs something
only Babel provides** (18 of 22 codemods are regex).

**Use regex when** (the common case):
- The transform anchors on a stable string literal and discovers minified
  names from nearby context (capture group, substitute back)
- The transform injects or wraps a contiguous code region (guard before an
  if-statement, variable declaration after another, ternary wrapping a condition)
- The transform needs function-level scope (brace-depth scan, not variable
  binding)
- The transform discovers names by structural pattern (call signature,
  assignment shape, return-value form)

**Use Babel when**:
- The transform resolves cross-scope references (`getBinding()` /
  `scope.hasBinding()` have no regex equivalent)
- The transform performs multi-pass discovery with inter-transform ordering on
  the same AST node
- The transform injects large, nested AST subtrees (>30 lines of JSX /
  deeply nested conditionals) that would require constructing the output as a
  string literal
- The transform needs semantic type information to discriminate nodes with
  identical surface syntax but different AST roles

See `CONTRIBUTING.md` for the full decision tree. Note: `@babel/parser` cannot
parse webcrack-deobfuscated code-split chunks (2.1.242+), so Babel codemods
are structurally blocked on code-split unless converted to regex. If you want
the mod to apply on code-split versions, choose regex.

Set `engine: "regex"` or `engine: "babel"` in the YAML `codemod:` block. The
scaffold defaults to `regex`.

### Step 4: Write the `applicable` status test

The `applicable` regex must match the deobfuscated code **before** patching —
it proves the target pattern exists in this version. Rules:
- Use `\w+` for minified identifiers; `[\w$]+` if names might contain `$`
- Match on stable structure (string literals, property names), not names
- Must match at least once for the patch to be considered applicable
- Test: `rg -P '<applicable_regex>' ~/.cache/claude-mod/2.1.181/baseline/deobfuscated.js`

For dual-version patches (monolithic + code-split), use anchors present in
both forms, or use code-split-only anchors absent in monolithic (e.g.,
`keysDeferred`) with a fallback. See `codemods/codemod-display-model-slug.cjs`
for a dual-form example.

For mod-wrapped patches, the `applicable` regex typically just needs to prove
the target site exists; the `applied` regex proves the guard was injected.

### Step 5: Write the codemod

#### Regex contract

```js
function transform(code) {
  // 1. Idempotency check: if already patched, return changed: 0
  if (code.includes('__isModEnabled__("my_patch"')) {
    return { code, changed: 0 };
  }
  // 2. Find the anchor
  const anchor = /process\.env\.STABLE_ANCHOR/g;
  // 3. Discover minified names with \w+ capture groups
  // 4. Splice the replacement using code.substring() + offset arithmetic
  // 5. Apply replacements in reverse order to maintain string offsets
  let count = 0;
  // ... transform ...
  return { code, changed: count };
}
```

Rules:
- **Fail closed**: return `{ code, changed: 0 }` when no target matches — never
  throw
- **Idempotent**: check for your sentinel (`__isModEnabled__("my_patch"` or an
  injected marker) and skip if present
- **No unbounded body regex**: do not match function bodies with `[^]*` or
  `[\s\S]*?`; use brace-depth scanning for block scope, and bounded quantifiers
  (`{1,200}`) when you must span a region
- **Classify before replacing**: if multiple candidates co-locate in the same
  window, classify all of them before any replacement (replacements change the
  neighbor window). See `codemods/codemod-set-context-limit.cjs`.
- **Reverse-order application**: apply replacements from last to first so
  earlier string offsets stay valid
- **`$` in replacement text**: use a function replacer
  (`code.replace(pattern, (m, p1) => ...)`) if the replacement contains `$`,
  since `$1`–`$9` are interpreted as backreferences

#### Babel contract

```js
function transform(ast, code) {
  // traverse(ast) { ... t.* builders ... }
  return changedCount; // or { changed: changedCount }
}
```

Find targets via unique string literals (`t.isStringLiteral(e, { value:
"Status" })`), not minified identifier names. May have Phase 1 (AST) + Phase 2
(regex post-processing on the generated output).

#### Mod-wrapped guards

If the mod should be toggleable at runtime, wrap the change in:
```js
typeof __isModEnabled__ === "function" && __isModEnabled__("my_patch")
```

This depends on `mods_runtime` (order: 1) being applied first, which is
guaranteed by the order field. The guard lets users disable the mod in the
Mods panel without repatching.

For runtime-configurable values, use:
```js
__getModConfig__("my_patch", "my_key") ?? defaultValue
```

`__getModConfig__` reads from `~/.claude/mods.json` with a 2-second TTL cache.
Declare the config keys in the YAML `mod.config` block so the Mods panel
renders the fields.

### Step 6: Write the `applied` status test

The `applied` regex must match the code **after** the codemod runs — it proves
the transform worked. Rules:
- Same `\w+` / `[\w$]+` rule for minified identifiers
- For mod-wrapped patches, typically anchors on
  `__isModEnabled__\(\s*["']my_patch["']\s*\)` or
  `__getModConfig__\(\s*["']my_patch["']`
- Must fail on the synthetic unpatched input and pass on the transformed output
- Test by running the codemod and grepping the output

```bash
node codemods/codemod-my-patch.cjs \
  ~/.cache/claude-mod/2.1.181/baseline/deobfuscated.js /tmp/out.js
rg -P '<applied_regex>' /tmp/out.js
```

### Step 7: Fill in the `mod:` block

```yaml
mod:
  section: "unlock"           # core | model | unlock (Mods tab section)
  live: true                  # true = no restart needed; false = restart required
  category: "features"        # display | features | model | reliability | remote | system
  config: []                  # optional: runtime-configurable fields
```

For configurable mods:
```yaml
mod:
  section: "model"
  live: false
  category: "model"
  config:
    - key: "context_limit"
      type: "number"          # number | string | boolean | secret
      default: 200000
      label: "Context window"
```

### Step 8: Set the order

The `order` field controls application sequence (lower = applied first). Most
mods use `50` (the default). Set `1` only for substrate patches that others
depend on (`mods_runtime` is `1`). Mod-wrapped patches should apply after
`mods_runtime` — any `order >= 2` satisfies this.

### Step 9: Write unit tests

The scaffold creates `test/unit/codemod-my-patch.test.js` with a fail-closed
assertion. Add:
- **Enabled behavior**: the transform applies on a synthetic minified fixture
- **Disabled behavior**: with the mod guard disabled, original behavior is
  preserved
- **Near-miss inputs**: unrelated code is unchanged (`changed: 0`)
- **Minified-name resilience**: same shape, different identifiers (e.g.,
  `sm1`/`ZI` in one fixture, `a`/`b` in another)
- **Idempotence**: running the transform twice on its own output returns
  `changed: 0`
- **Status-test round-trip**: the `applied` regex fails on the unpatched
  fixture and passes on the transformed output

Keep fixtures hand-written and synthetic. Never paste deobfuscated upstream
code into fixtures — `node bin/fixture-audit.cjs` enforces this and rejects
upstream-derived content.

### Step 10: Verify the full batch

A new patch must compose with the full ordered set. Patches are not
independently selectable; users toggle behavior through the Mods panel, so the
complete set must apply together.

```bash
# Invalidate stale patched output
find ~/.cache/claude-mod -type d -name patched -exec trash {} + 2>/dev/null || true
claude-mod patch 2.1.181 --verbose --require-all
```

Your new patch should show `✓ my_patch` (applied). Existing patches should
remain `✓` or `◌` (already applied / not applicable) — if your patch breaks an
existing one, the codemod likely collided with a shared anchor or minified name.
Resolve by scoping your anchor more tightly.

### Step 11: Run the gates

```bash
bun test                                      # unit tests
node bin/lint-codemods.cjs                    # no hardcoded names, marker safety
node bin/fixture-audit.cjs                    # synthetic fixtures only
mise run gate:version-compat                  # full release check
```

For runtime or packaging changes, also run:
```bash
mise run gate:fresh-install                   # packed tool in disposable HOME
```

Validate the patched CLI's offline `--version` and `--help`, and manually
exercise the changed behavior. Do not invoke billed inference as a smoke test.

### Step 12: Commit

Stage with explicit pathspecs (the scaffold created three files):
```bash
git add patches/my_patch.yaml codemods/codemod-my-patch.cjs test/unit/codemod-my-patch.test.js
git commit -m "feat(patches): add <mod_name> mod

<one-line description of what the mod un-nerfs or exposes>"
```

This repo integrates to `main` same-turn (trunk-based, single-developer). Do
not split a new mod across multiple PRs.

## Reference: YAML structure

```yaml
id: "my_patch"                 # canonical mod identifier (matches YAML filename stem)
target: "claude-code"
name: "Human Readable Name"
description: "What the patch does and why"
file_id: "cli"                 # the bundle file to patch
order: 50                      # application order (lower = first; mods_runtime is 1)
status_tests:
  applied: 'regex matching AFTER patching (must contain a change marker)'
  applicable: 'regex matching BEFORE patching (stable structural anchor)'
codemod:
  type: "node_script"
  engine: "regex"              # or "babel"
  script: "codemods/codemod-my-patch.cjs"
mod:
  section: "unlock"            # core | model | unlock (Mods tab section)
  live: true                   # true = no restart; false = restart required
  category: "features"         # display | features | model | reliability | remote | system
  config: []                   # optional: runtime-configurable fields
```

## Reference: Existing mods to learn from

| Patch | Engine | Why that engine | Demonstrates |
|-------|--------|-----------------|-------------|
| `set_context_limit` | regex | Stable numeric anchors + classify-before-replace | Code-split vs monolithic disambiguation, multi-candidate classification |
| `unlock_models` | babel | Cross-scope binding resolution | Provider-gate removal, mod-wrapped guard |
| `display_model_slug` | babel | Dual-form detection | Switch-statement vs object-literal fallback |
| `mods_runtime` | regex | Substrate injection | `__isModEnabled__` / `__getModConfig__` helpers (order: 1) |
| `mods_env_panel` | babel | Large React component injection | Environment-tab UI, `env-catalog.json` integration |
| `set_memory_limits` | regex | Stable env-var anchors + contiguous injection | Runtime-configurable values via `__getModConfig__` |

Read the codemod and YAML for the closest analogue before writing your own.

## Reference: Failure modes to avoid

- **Hardcoded minified names** — `sm1`/`ZI` change between versions; use `\w+`
  in regexes and string-literal matching in Babel. `bin/lint-codemods.cjs`
  flags hardcoded names.
- **Unbounded body regex** — `[\s\S]*?` across function boundaries matches
  into adjacent functions; use bounded quantifiers or brace-depth scanning.
- **Over-broad `applicable`** — `visibleOptionCount` matches 43+ locations in
  2.1.181; `PACKAGE_URL` matches 63 chunks. Use specific anchors.
- **`$` backreference collision** — replacement text containing `$` is
  interpreted as a backreference; use a function replacer.
- **Non-idempotent transform** — running the codemod twice must return
  `changed: 0` the second time; check for your sentinel first.
- **Upstream code in fixtures** — `bin/fixture-audit.cjs` rejects
  upstream-derived fixture content; keep fixtures hand-written and synthetic.

## Commands Reference

```bash
claude-mod new-patch <snake_id>               # scaffold YAML + codemod + test
claude-mod patch 2.1.181 --verbose --require-all  # verify the full batch
claude-mod run 2.1.181 -- --help             # run the patched CLI offline
mise run gate:version-compat                 # local macOS release check
mise run gate:fresh-install                  # packed tool in disposable HOME
bun test                                     # unit tests
node bin/lint-codemods.cjs                   # lint codemods
node bin/fixture-audit.cjs                   # synthetic fixtures only
rg -P '<pattern>' ~/.cache/claude-mod/2.1.181/baseline/deobfuscated.js  # search anchors
node codemods/codemod-<name>.cjs <in.js> <out.js>   # test a single codemod
```

---
name: fix-patches
description: >
  Update codemods and patch definitions so all patches apply cleanly against a
  target version of Claude Code CLI. Use this skill when patches fail against a
  new version, when running scheduled patch maintenance, or when the user asks
  to "fix patches", "update patches", "patch X.Y.Z", or mentions version
  compatibility. Also triggers on "dry-run failed", "not applicable", or
  "verification failed" in the context of patching. This skill handles the
  full lifecycle: detect failures, fix codemods + regexes, run tests, verify
  against the gate, and commit.
---

# Fix Patches

Patch maintenance for new Claude Code CLI releases. The supported release is
pinned in `last-tested-version` (currently **2.1.181**); code-split binaries
(2.1.242+) are partially supported.

## When This Runs

- After a new Claude Code version is released
- When `claude-mod patch <version> --verbose --require-all` shows `✗` failures
  or warns `N patch(es) not applicable`
- Scheduled patch maintenance

## Overview

The patch pipeline transforms the minified Claude Code CLI bundle:

1. Download via `npm pack @anthropic-ai/claude-code@<version>`
2. Deobfuscate with webcrack 2.15.1 → `~/.cache/claude-mod/<version>/baseline/deobfuscated.js`
3. Apply codemods (Babel AST transforms or regex replacements), ordered by the
   YAML `order` field
4. Verify with the `applied` regex from each patch YAML

Each patch has two status regexes:
- `applicable` — must match the deobfuscated code *before* patching (proves the
  target pattern exists in this version)
- `applied` — must match the deobfuscated code *after* patching (proves the
  transform worked)

When a new version changes code structure, `applicable` stops matching → the
patch becomes "not applicable" and needs fixing.

## Full Workflow

### Step 1: Dry-run to identify failures

The CLI has no dry-run flag; a full run against the cache is the probe:

```bash
claude-mod patch <version> --verbose --require-all
```

Classify each patch from its output line:
- `✓ <id>` — applied (no action)
- `◌ <id>  already applied` — no action
- `◌ <id>  not applicable` — **needs fixing** (code structure changed;
  `--require-all` exits non-zero listing these)
- `✗ <id>` — **needs fixing** (codemod failed or verification failed)

If nothing shows `◌ ... not applicable` or `✗`, stop — nothing to fix.

### Step 2: Ensure baseline exists

The Step 1 run already downloads and deobfuscates. The deobfuscated file is at:
```
~/.cache/claude-mod/<version>/baseline/deobfuscated.js
```

For code-split versions (2.1.242+), the baseline is per-chunk under
`~/.cache/claude-mod/<version>/baseline/chunks/`; `bin/patch.cjs` handles chunk
discovery automatically, but some patches are skipped — see **Code-split skips**
below.

### Step 3: Fix each failing patch

For each patch with `not_applicable` or `✗` status:

#### 3a. Understand what changed

Read the patch YAML in `patches/<patch_name>.yaml` to understand:
- What the patch does (description, comments)
- The `applicable` regex — what pattern it expects in the original code
- The `applied` regex — what pattern it expects after patching
- The codemod script path (`codemods/codemod-<name>.cjs`)
- The engine (`regex` or `babel`)

Then search the deobfuscated code for the **semantic intent** of the patch:
- Start with stable anchors: string literals (`"FALLBACK_FOR_ALL_PRIMARY_MODELS"`,
  `"Status"`, `"Config"`) and property names (`.model`, `.status`)
- Use ripgrep (`rg -P`) for regex searches; BSD grep on macOS has no `-P`
- Examine surrounding code to understand how the structure changed

#### 3b. Fix the applicable regex

The `applicable` regex must match the new code structure. Rules:
- Use `\w+` (or `[\w$]+` if minified names might contain `$`) for all minified
  identifiers — never hardcode `sm1`, `ZI`, etc.
- Match on structure, not names — use string literal anchors and property names
- Test: `rg -P '<new_applicable_regex>' ~/.cache/claude-mod/<version>/baseline/deobfuscated.js`
- The regex must match at least once for the patch to be considered applicable

#### 3c. Fix the codemod

Two engines exist (see `CONTRIBUTING.md` for the full decision tree):

**Regex codemods** (`engine: "regex"` — the common case, 18 of 22):
- Contract: `transform(code: string) → { code: string, changed: number }`
- Anchor on stable string literals (`process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS`)
  and discover minified names with capture groups
- Use brace-depth scanning for function/block scope, not `[\s\S]*?` across
  function boundaries (use a bounded quantifier like `{1,200}` or a
  strict-first-then-flexible approach)
- Report `changed: 0` when no target matches (fail closed)
- Apply replacements in reverse order to maintain string offsets
- Test: `node codemods/codemod-<name>.cjs <deobfuscated_path> <deobfuscated_path>`

**Babel AST codemods** (`engine: "babel"` — 4 remaining):
- Contract: `transform(ast, code: string) → number | { changed: number }`
- Find targets via unique string literals (`t.isStringLiteral(e, { value: "Status" })`)
- Transform via AST node manipulation; may have Phase 1 (AST) + Phase 2 (regex
  post-processing)
- Note: `@babel/parser` cannot parse webcrack-deobfuscated code-split chunks
  ("Unterminated string constant" on webcrack output patterns), so Babel
  codemods are structurally blocked on code-split unless converted to regex
- Test same way: run the codemod against the deobfuscated file

Common patterns for fixing codemods:
- If a switch statement became an object literal → add object literal detection
  (see `codemods/codemod-display-model-slug.cjs` for a dual-form example)
- If an array gained/lost elements → update the array content check
- If a function was inlined or restructured → find it via its stable string
  literals
- If blocks moved apart → relax adjacency requirements (document why if
  adjacency was required)
- If co-located candidates became ambiguous → classify all candidates before
  any replacement (replacements change the neighbor window); see
  `codemods/codemod-set-context-limit.cjs` for the classify-then-replace pattern

#### 3d. Fix the applied regex

The `applied` regex must match the code **after** the codemod runs. Rules:
- Same `\w+` / `[\w$]+` rule for minified identifiers
- For mod-wrapped patches, the `applied` regex typically anchors on
  `__isModEnabled__\(\s*["'<id>"]\s*\)` or `__getModConfig__\(\s*["'<id>"]`
- Test by running the codemod and grepping the output

#### 3e. Bump last-tested-version

Patch YAMLs do not carry a `versions:` array. Verified compatibility is tracked
repo-wide in the root `last-tested-version` file, which `mise run
gate:version-compat` and CI patch against. After the full verify run (Step 5)
passes, bump it on the fix branch:
```bash
echo "<version>" > last-tested-version
```

### Step 4: Run unit tests

```bash
bun test
```

All existing tests must pass. If a test uses synthetic fixtures that don't
match the new code structure, update the fixtures too — but keep them
hand-written and synthetic (never paste deobfuscated upstream code into
fixtures; `node bin/fixture-audit.cjs` enforces this).

If the codemod has unit tests in `test/unit/`, add a new fixture for the new
version's structure to prevent regressions. Test enabled and disabled
behavior, near-miss inputs, and minified-name resilience (same shape,
different identifiers).

### Step 5: Verify with full patch run

```bash
# Invalidate stale patched output first (mirrors gate:version-compat)
find ~/.cache/claude-mod -type d -name patched -exec trash {} + 2>/dev/null || true
claude-mod patch <version> --verbose --require-all
```

All patches should show `✓` (applied) or `◌ ... already applied` / `◌ ... not
applicable` (expected no-ops). Zero `✗` failures.

Expected batch outcome for 2.1.181: **43 applied, 0 failed, 1 version-gated
skip** (`model_picker_search`). On 2.1.277: the same 43 apply with 6 code-split
skips (see below).

### Step 6: Run the local gate

```bash
mise run gate:version-compat
```

This runs the full patch build against `last-tested-version` and checks offline
`--version` and `--help`. Do not invoke billed inference as a smoke test.

For runtime or packaging changes, also run:
```bash
mise run gate:fresh-install
```
This installs the packed tool in a disposable HOME, exercises
download/extraction/deobfuscation, loads native bindings, and restores an
installed version after cache removal.

### Step 7: Commit

Commit the fix with a conventional message. Stage with explicit pathspecs:

```sh
git add patches/<patch_name>.yaml codemods/codemod-<name>.cjs test/unit/codemod-<name>.test.js last-tested-version
git commit -m "fix(patches): update codemods and regexes for <version> compatibility"
```

This repo integrates to `main` same-turn (trunk-based, single-developer). Do
not split a patch fix across multiple PRs.

## Code-split skips (2.1.242+)

Starting with 2.1.242, Claude Code ships as code-split ESM chunks. claude-mod
deobfuscates each chunk individually and patches per-chunk, but some patches
are skipped and tracked in `CODESPLIT_SKIP_PATCHES` inside `bin/patch.cjs`:

| Patch | Skip reason |
|-------|-------------|
| `mods_runtime` | Code-split handled by pipeline-level `fixBunCjsWrapper()` ESM injection |
| `remove_attribution` | Babel parser fails on code-split chunks (unterminated strings in webcrack output) |
| `add_cache_keepalive` | 5 injection sites across chunks with cross-chunk dependencies; needs per-chunk redesign |
| `unlock_permanent_cron` | 2.1.277 replaced `addCronTask` with a file-based scheduled-tasks system that already supports permanent tasks natively — no gate to unlock |
| `unlock_models` | Babel codemod — cache function name discovery fails on code-split |
| `model_picker_search` | Babel codemod — no matching structure in code-split |

If a patch you're fixing is on this list, the skip is often deliberate. Check
the inline comment in `bin/patch.cjs` before attempting a fix — some skips are
"genuinely unnecessary" (the feature is already present natively) rather than
broken. Babel-blocked skips require converting the codemod to regex before
they can apply on code-split.

## YAML structure reference

```yaml
id: "patch_name"              # canonical mod identifier (matches YAML filename stem)
target: "claude-code"
name: "Human Readable Name"
description: "What the patch does and why"
file_id: "cli"                # the bundle file to patch
order: 50                     # application order (lower = applied first; mods_runtime is 1)
status_tests:
  applied: 'regex matching AFTER patching (must contain a change marker)'
  applicable: 'regex matching BEFORE patching (stable structural anchor)'
codemod:
  type: "node_script"
  engine: "regex"             # or "babel"
  script: "codemods/codemod-patch-name.cjs"
mod:
  section: "unlock"           # core | model | unlock (Mods tab grouping)
  live: true                  # true = takes effect without restart; false = restart required
  category: "features"        # display | features | model | reliability | remote | system
  config: []                  # optional: runtime-configurable fields (see below)
```

### Mod config fields

```yaml
mod:
  config:
    - key: "context_limit"
      type: "number"          # number | string | boolean | secret
      default: 200000
      label: "Context window"
```

Config values are read at runtime via `__getModConfig__("<id>", "<key>")` with a
2-second TTL cache. The `mods_runtime` patch (order: 1) injects
`__isModEnabled__()` and `__getModConfig__()`; patches that use mod-wrapping or
config depend on `mods_runtime` being applied first (guaranteed by order: 1).

### Mod-wrapped codemods

Many patches wrap their changes in a runtime toggle guard:
```js
typeof __isModEnabled__ === "function" && __isModEnabled__("patch_name")
```

This lets users toggle the mod in the Mods panel without repatching. The guard
shape must be preserved when editing a mod-wrapped codemod.

## Resilient patch rules

1. **Never hardcode minified names** — use `\w+` / `[\w$]+` in regexes; match
   on string literals and property names in codemods
2. **Match on structure, not identity** — property names and string literals
   are stable across versions; minified identifiers are not
3. **Codemods match on semantics** — `t.isMemberExpression` with property name
   checks, not `t.isIdentifier({ name: "sm1" })`
4. **`last-tested-version` tracks verified compatibility** — bump it only after
   the full verify run passes
5. **Test with different minified names** — unit test fixtures should use
   varied names for the same pattern
6. **Fail closed** — return `changed: 0` when no target matches, not an error

## Dual-form detection pattern

When code structure varies between versions (e.g., switch statement in older
versions, object literal in newer), use a two-phase search:

1. Try the newer form first (object literal, map, etc.)
2. Fall back to the older form (switch statement, function)
3. Generate the appropriate replacement based on which form was found

See `codemods/codemod-display-model-slug.cjs` for a complete example, and
`codemods/codemod-set-context-limit.cjs` for code-split-vs-monolithic
disambiguation (the `isCodeSplit` flag derived from
`a.CLAUDE_CODE_DISABLE_1M_CONTEXT` property-access patterns).

## Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `not applicable` | `applicable` regex doesn't match new code structure | Search deobfuscated code for stable anchors, update regex |
| `verification failed` | Codemod ran but `applied` regex doesn't match output | Codemod generated different output than expected, or `applied` regex is too specific |
| `codemod failed` | Codemod threw an error | Check the codemod's match logic against new code |
| `already applied` on unpatched baseline | `applied` regex matches unmodified code | Regex is too broad — make it more specific |
| `WARNING: Input file contains injected markers` | Baseline corrupted (patched output written back to baseline) | Run `mise run clean <version>` and re-patch |

## Commands Reference

```bash
claude-mod patch <version> --verbose          # download + deobfuscate + patch
claude-mod patch <version> --require-all     # fail if any patch not applicable (CI-gate)
claude-mod run <version> -- --help           # run a cached build offline
claude-mod status <version>                  # status of a cached version
claude-mod status --all                      # list cached versions
claude-mod doctor                            # check local prerequisites
claude-mod new-patch <snake_id>              # scaffold a new patch (see create-mod skill)
claude-mod install <version>                 # install or restore a chosen version
claude-mod uninstall                         # remove the managed launcher

mise run gate:version-compat                 # local macOS release check
mise run gate:fresh-install                  # packed tool in disposable HOME
bun test                                     # unit tests
node bin/lint-codemods.cjs                   # lint codemods (no hardcoded names, marker safety)
node bin/fixture-audit.cjs                   # synthetic fixtures only
```

# Contributing to claude-mod

The first release supports Claude Code **2.1.181 on macOS**. Linux runtime support and newer upstream versions require separate compatibility work.

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

- Prefer Babel AST matching. Anchor on stable properties, strings, and structure—not minified variable names.
- Keep original behavior when the mod is disabled. Guard calls to injected helpers with `typeof __isModEnabled__ === "function"`.
- Make transforms idempotent and report whether they changed the input.
- An `applied` status test must fail on the synthetic unpatched input and pass on the transformed output. Verify every injection when a transform changes several sites.
- Regex transforms must not match function bodies with `[^]*` or `[\s\S]*?`; use bounded structural traversal. Use function replacers for replacement text containing `$`.
- Test enabled and disabled behavior, near-miss inputs, structural variation, and interaction with the full batch. Syntax validity alone does not establish semantic correctness.

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

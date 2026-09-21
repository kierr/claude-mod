# Working on claude-mod

## Scope and distribution

The supported release is Claude Code 2.1.181 on macOS; fresh-install verification currently covers Apple Silicon. Linux and newer upstream compatibility are separate work, not implicit prerequisites for an unrelated change. Keep support claims aligned with actual verification and `last-tested-version`. Code-split binaries (2.1.242+) are partially supported: 43/44 patches apply on 2.1.277, with the remaining gaps tracked in `CODESPLIT_SKIP_PATCHES`.

Ship the tool and authored transformations only. Keep upstream binaries, extracted/deobfuscated code, prompt excerpts, derived deltas, caches, and private sessions out of git, packages, CI artifacts, and reports. Tests use hand-written synthetic fixtures. Automated scans help detect leaks but cannot establish provenance.

Public documentation describes the current tool. Keep development history in commits and avoid rebuilding a research archive in README or a docs directory. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the patch contract.

Comments explain constraints and non-obvious choices, not development chronology. Omit private setup references, review-dismissal labels, copied bundle excerpts, and narration of obvious operations; preserve parser-constant provenance, guard semantics, and regression intent. Check comment claims against code. Treat comment-like strings used as patch anchors or fixtures as data, not prose to reword casually.

## Source map

- `bin/patch.cjs`: CLI, version management, installation, and patch orchestration.
- `bin/webcrack-pipeline.cjs`: pinned deobfuscation and syntax validation.
- `lib/engine.cjs`: ordered patch execution and verification.
- `patches/*.yaml`: patch IDs, applicability/status tests, execution order, and mod configuration.
- `codemods/`: CommonJS transformations (regex engine preferred; Babel for cross-scope resolution, multi-pass mutation, or large AST injection).
- `test/`: Bun tests and synthetic fixtures.

The YAML `id` is the canonical mod identifier; filenames can differ. The complete ordered set is applied together, with behavior selected through runtime mod settings. Preserve disabled behavior and use guarded runtime-helper calls. Prefer structural anchors over minified names, and official configuration over a redundant patch.

## Validation

```sh
bun install --frozen-lockfile
bun test
node bin/lint-codemods.cjs
node bin/fixture-audit.cjs
actionlint
```

Add regression tests for changed behavior, near misses, and idempotence. Run the whole suite before calling a change verified. Keep the lockfile synchronized rather than bypassing frozen installation.

For runtime or packaging changes, also test the packed tool in a fresh HOME on the supported platform. A cached baseline does not prove the download/extract/deobfuscation path. The local runtime gate is `mise run gate:version-compat`; its current expected outcome is 43 applied, 0 failed, and one version-gated skip (`model_picker_search`) on 2.1.181. On 2.1.277, the same 43 patches apply with 6 code-split skips. Check offline `--version` and `--help`; do not invoke paid inference as an incidental smoke test.

webcrack 2.15.1 is pinned in the pipeline and installer. Validate its output without heuristic rewriting. If generation fails, locate the first failing stage and compare untouched producer output with post-processing using the same input, version, and flags. A syntax error moving later is not evidence of a semantically correct repair.

## Releases

Public distribution starts from an audited, single-root source snapshot, never private development history. Removing a private or upstream-derived file from the current tree does not remove it from reachable commits. Never merge or push development-history refs into the public repository. Registry publication and visibility changes require explicit release approval.

Runtime safety is a release invariant: refuse unmanaged launchers before changing installation state, run/install only complete validated patch artifacts, preserve the prior installation on failure, and never select a newer upstream version implicitly. Cover these contracts with synthetic failure-path tests; a cached happy-path smoke is insufficient.

Keep npm contents explicitly allowlisted in `package.json`. Check the actual tarball, including transitive runtime scripts; successful checkout execution is insufficient. CI is source-only on Linux and must never upload upstream-derived artifacts. Publication requires all source gates. Version changes, tags, registry publication, and repository visibility are explicit release actions, not routine cleanup.

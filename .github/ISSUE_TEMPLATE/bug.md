---
name: Bug report
about: Something broken in the patcher or a patched build
title: "[bug] "
labels: ["bug"]
---

## Versions

- `claude-mod` version (or commit):
- Claude Code version under test:
- Platform (macOS arm64 / macOS x64 / Linux x64 / Linux arm64):
- Bun version (`bun --version`):

## What happened

## What you expected

## Reproduction

Commands run, starting from a clean state if possible:

```sh
claude-mod doctor
claude-mod patch <version> --verbose
```

## Logs

Paste the relevant portion of `--verbose` output. **Redact tokens first** —
never paste `mods.json` values, API keys, or deobfuscated bundle excerpts.

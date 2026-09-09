---
name: New upstream version broken
about: A Claude Code release the patcher does not yet handle
title: "[upstream] "
labels: ["upstream"]
---

## Upstream version

Claude Code version (e.g. `2.1.250`):

## Failure stage

- [ ] download / extract (`extract-js-from-bun-binary`)
- [ ] deobfuscate (webcrack)
- [ ] patch (which patch id? paste the failure line)
- [ ] wrapper fix / smoke (`claude --version`)

## Logs

Paste the failing stage's output. **No bundle-derived excerpts** — log lines
and patch ids only.

## Notes for triage

- Single-file bundles only: versions shipping code-split `chunk-*.js` modules
  (2.1.242 and later) are a known architectural gap, not a per-patch break.
- If `last-tested-version` already covers this version, this is a duplicate —
  check the compat matrix in the latest release first.

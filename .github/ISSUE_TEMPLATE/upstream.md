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

- Code-split binaries (2.1.242+) are supported: 43 of 44 patches apply on
  2.1.277. Check the compat matrix in the latest release for current status.
- Monolithic-only patches (mods_env_panel, mods_ui) and Babel-only patches
  (remove_attribution, unlock_models, model_picker_search) are skipped
  automatically on code-split — those skips are expected, not bugs.

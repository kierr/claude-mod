#!/bin/sh
# claude-mod installer: Bun (if missing) -> npm i -g claude-mod -> doctor.
# Usage: curl -fsSL https://raw.githubusercontent.com/kierr/claude-mod/main/install.sh | sh
# First release targets macOS. Needs no sudo:
# everything installs into the user HOME (npm global prefix may need setup).
set -eu

REPO="kierr/claude-mod"
PKG="claude-mod"

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin) ;;
  *) die "unsupported OS: $OS (this release supports macOS only)" ;;
esac
case "$ARCH" in
  arm64|aarch64|x86_64) ;;
  *) die "unsupported arch: $ARCH" ;;
esac

# Bun runs the patched client; its installer requires unzip.
if command -v bun >/dev/null 2>&1; then
  log "bun present: $(bun --version)"
else
  log "installing bun (official installer)..."
  curl -fsSL https://bun.sh/install | bash
  for p in "$HOME/.bun/bin/bun" "/usr/local/bin/bun"; do
    if [ -x "$p" ]; then
      log "bun installed via $p (add its dir to PATH if needed)"
      export PATH="$(dirname "$p"):$PATH"
      break
    fi
  done
  command -v bun >/dev/null 2>&1 || die "bun install did not land on PATH; install from https://bun.sh and re-run"
fi

# Node and npm run and install the patcher.
command -v npm >/dev/null 2>&1 || die "npm not found; install Node.js 22+ (https://nodejs.org) and re-run"

# Keep webcrack aligned with WEBCRACK_VERSION in the pipeline.
# If the global prefix is not writable, use a user-owned prefix without sudo.
if npm install -g "$PKG" "webcrack@2.15.1" 2>/dev/null; then
  log "installed $PKG + webcrack globally"
else
  log "global prefix not writable; configuring ~/.npm-global ..."
  NPM_GLOBAL="$HOME/.npm-global"
  mkdir -p "$NPM_GLOBAL"
  npm config set prefix "$NPM_GLOBAL"
  case ":$PATH:" in
    *":$NPM_GLOBAL/bin:"*) ;;
    *) log "add to your shell profile: export PATH=\"$NPM_GLOBAL/bin:\$PATH\""; export PATH="$NPM_GLOBAL/bin:$PATH" ;;
  esac
  npm install -g "$PKG" "webcrack@2.15.1" || die "npm install -g $PKG failed"
fi

# Check installed prerequisites.
if command -v claude-mod >/dev/null 2>&1; then
  claude-mod doctor || die "claude-mod doctor reported gaps (see above)"
else
  die "claude-mod not on PATH after install (check npm prefix bin dir)"
fi

log ""
log "Done. Next steps:"
log "  claude-mod update            # patch latest verified build, smoke-test, promote"
log "  claude-mod install 2.1.181   # or pin a specific version"
log "See https://github.com/$REPO for docs and the patch catalog."

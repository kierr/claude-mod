# claude-mod

Local modifications for Claude Code, focused on using custom models and third-party API providers.

claude-mod downloads an official Claude Code package, transforms it on your machine, and runs the result with Bun. The repository distributes the patching tool—not Claude Code or a prepatched binary.

**Supported release: Claude Code 2.1.181 on macOS.** The fresh-install path has been verified on Apple Silicon. Linux, Intel Mac runtime compatibility, and other Claude Code versions are not certified.

This is an unofficial project, not affiliated with Anthropic. Review the terms applicable to your use of Claude Code.

## What it changes

- **Models:** custom model selection, model limits, effort settings, and session restoration.
- **Providers:** endpoint display, authentication forwarding, and configurable request retries.
- **Context:** compaction, memory limits, and cache behavior.
- **Interface:** a **Mods** tab in `/config` for behavior switches and an **Environment** tab for configuration.

The full ordered patch set is applied together; supported behavior switches are controlled at runtime. Some features still depend on upstream services or authentication. A local modification does not grant access to those services.

## Install from source

You need **Bun**, **Node.js 22+**, **npm**, and the macOS Command Line Tools. webcrack's native dependencies may also require Python 3 and a C++ toolchain.

```sh
git clone https://github.com/kierr/claude-mod.git
cd claude-mod
bun install --frozen-lockfile
npm install -g . webcrack@2.15.1
claude-mod doctor
claude-mod update
```

`update` uses the version shipped in `last-tested-version`—currently **2.1.181**—rather than the latest upstream release. It patches that version, installs native dependencies, checks `--version` and `--help`, and installs a launcher at `~/.local/bin/claude`. It refuses to replace an existing unmanaged launcher. Ensure that directory is on your `PATH`.

Open `/config` in the patched client to configure mods. Prefer an official setting or environment variable when it already provides the behavior you need.

## Commands

```sh
claude-mod update                 # patch and install the supported version
claude-mod patch 2.1.181          # build without installing a launcher
claude-mod run 2.1.181 -- --help   # run a cached build
claude-mod install 2.1.181        # install or restore a chosen version
claude-mod status --all           # list cached versions
claude-mod doctor                # check local prerequisites
claude-mod uninstall             # remove the managed launcher
```

Explicit version arguments are available for development; they do not imply that another upstream version is supported. Without a version, `run` uses an explicitly installed version or the packaged supported default. It never checks for or promotes upstream updates in the background. Use `claude-mod --help` for the full command list.

## Local files

State directories retain the legacy `claude-mods` name so existing caches, installed launchers, settings, and rollback copies remain usable without moving files. The management command is now `claude-mod`; the runtime command remains `claude`.

- `~/.cache/claude-mods/`: downloaded packages and generated builds.
- `~/.local/lib/claude-mods/`: installed versions, separate from the cache.
- `~/.local/bin/claude`: managed launcher.
- `~/.claude/mods.json`: mod settings.

Valid cached stages are reused. Failed or changed patch artifacts cannot be installed or run. `patch --force` rebuilds the patched output; it is not a request to download everything again. Installation validates an independent copy before switching the live launcher, preserving the previous build on failure. `uninstall` leaves validated installed versions available for `install <version>`, even after their build cache is removed. Older installations without a successful artifact manifest must be patched again.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development commands and patch requirements. [AGENTS.md](AGENTS.md) contains repository guidance for coding agents.

Use synthetic examples when reporting bugs. Do not attach upstream bundles, extracted code, prompt dumps, credentials, or private session data.

## License

MIT. See [LICENSE](LICENSE). This license covers claude-mod, not Claude Code.

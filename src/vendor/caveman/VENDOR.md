# Vendored: caveman

These files are vendored **verbatim** (byte-for-byte, contents unmodified) from
the [caveman](https://github.com/JuliusBrussee/caveman) Claude Code plugin.

- **Source:** https://github.com/JuliusBrussee/caveman
- **Pinned tag:** `v1.9.1`
- **Commit:** `033f918`
- **License:** MIT (see `LICENSE` in this directory)
- **Status:** security-audited before vendoring.

## Why vendored

Claude Fleet auto-installs caveman into the user's global `~/.claude` on first
launch, entirely **offline** — from this local copy only, with **no** network
fetch, `npx`, or remote code download at runtime. See `src/caveman-install.js`
(the offline installer) and `src/main.js` (the launch-time, marker-guarded,
non-blocking wiring).

Caveman installs a global Claude Code `SessionStart` hook. Every `claude`
process started afterward — including the PTYs this app spawns — then
auto-activates caveman mode.

## Layout (relative paths matter)

`hooks/caveman-activate.js` resolves `SKILL.md` via
`../skills/caveman/SKILL.md` from its own `hooks/` dir, so the `hooks/` and
`skills/caveman/` sibling layout below must be preserved.

```
src/vendor/caveman/
  hooks/
    caveman-activate.js          <- src/hooks/caveman-activate.js         (SessionStart hook, core)
    caveman-config.js            <- src/hooks/caveman-config.js           (required by activate)
    cavecrew-model-overrides.js  <- src/hooks/cavecrew-model-overrides.js (required by activate)
    caveman-mode-tracker.js      <- src/hooks/caveman-mode-tracker.js     (UserPromptSubmit hook)
    caveman-stats.js             <- src/hooks/caveman-stats.js            (run by tracker on /caveman-stats)
    caveman-statusline.sh        <- src/hooks/caveman-statusline.sh
    caveman-statusline.ps1       <- src/hooks/caveman-statusline.ps1
    package.json                 <- src/hooks/package.json               ("type":"commonjs" — loads .js hooks as CJS)
  skills/caveman/
    SKILL.md                     <- skills/caveman/SKILL.md               (source of truth for the ruleset)
    README.md                    <- skills/caveman/README.md
  commands/
    caveman.md                   <- commands/caveman.md
    caveman.toml                 <- commands/caveman.toml
    caveman-stats.md             <- commands/caveman-stats.md
    caveman-stats.toml           <- commands/caveman-stats.toml
    caveman-commit.md            <- commands/caveman-commit.md
    caveman-commit.toml          <- commands/caveman-commit.toml
    caveman-review.md            <- commands/caveman-review.md
    caveman-review.toml          <- commands/caveman-review.toml
    caveman-init.md              <- commands/caveman-init.md
    caveman-init.toml            <- commands/caveman-init.toml
  lib/
    settings.js                  <- bin/lib/settings.js                  (JSONC-tolerant idempotent settings.json merge)
  LICENSE                        <- LICENSE                              (MIT)
  VENDOR.md                      <- this file (authored, not vendored)
```

**Not vendored** (deliberately — the Claude Code runtime + offline install do
not need them): `node_modules`, `tests`, `evals`, `benchmarks`, `docs`,
`.github`, `mcp-servers`, the Python compress scripts, `install.sh`/`.ps1`,
`uninstall.*`, `checksums.sha256`, and `bin/lib/{openclaw,opencode-agent}.js`.

## How to update

1. Bump the tag/commit above to the new pinned release.
2. Re-download the pinned tarball:
   ```bash
   gh api repos/JuliusBrussee/caveman/tarball/<tag> > /tmp/caveman.tgz
   mkdir -p /tmp/caveman-src && tar xzf /tmp/caveman.tgz -C /tmp/caveman-src
   ```
3. Re-copy the exact file set above (byte-for-byte; do not edit contents) from
   the extracted dir into `src/vendor/caveman/`.
4. Re-audit the changed files (this is a security-sensitive, auto-installed dep).
5. Re-run the STEP 5 verification (syntax checks + the offline sandbox install
   test in a temp HOME) before committing.

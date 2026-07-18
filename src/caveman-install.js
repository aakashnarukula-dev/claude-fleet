// caveman-install — one-time OFFLINE install of the vendored caveman plugin
// into the user's global ~/.claude. No network, no npx, no remote fetch: the
// files ship inside this repo (src/vendor/caveman/) and are copied from that
// local, security-audited copy only.
//
// Caveman wires a global Claude Code SessionStart hook. Once installed, every
// `claude` process started afterward — including the PTYs this app spawns —
// auto-activates caveman mode. So a single global, local install is all we need.
//
// Standalone CommonJS. Intentionally does NOT require('electron') so it stays
// unit-testable under plain node with a temp HOME. Never throws into caller.

const fs = require('fs');
const os = require('os');
const path = require('path');
const SETTINGS = require('./vendor/caveman/lib/settings.js'); // static require — works in dev
                                                              // AND from inside the asar (pure stdlib)

// Recursive dir copy (mkdir -p + overwrite). Prefer fs.cpSync (Node ≥16.7);
// fall back to a manual walk on older runtimes. Preserves file contents exactly.
function copyDirSync(src, dst) {
  if (typeof fs.cpSync === 'function') {
    fs.cpSync(src, dst, { recursive: true, force: true });
    return;
  }
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

// opts: { vendorDir, homeDir = os.homedir() }
//   vendorDir = absolute path to the on-disk (unpacked) src/vendor/caveman dir.
//   homeDir   = override for testing (so a temp HOME can be used).
function ensureCaveman(opts = {}) {
  try {
    const homeDir = opts.homeDir || os.homedir();
    const vendorDir = opts.vendorDir;
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude');
    const marker = path.join(claudeDir, '.caveman-fleet-installed');
    const dest = path.join(claudeDir, 'caveman-fleet');
    const settingsPath = path.join(claudeDir, 'settings.json');

    // Read settings up front — both the fast-path health check and step 2 need it.
    let settings = SETTINGS.readSettings(settingsPath);
    if (settings === null) settings = {}; // unreadable/corrupt -> start clean, don't crash

    // 1) Fast path: already installed by us — but VERIFY, don't trust the marker
    //    blindly. A stale marker (settings.json reset/restored, hooks hand-edited
    //    out, or an earlier run that wrote the marker without fully wiring things)
    //    would otherwise silently keep caveman OFF forever. "Actually installed"
    //    = our SessionStart hook is present in settings.json AND the vendored
    //    activate script exists on disk. Healthy install → skip (fast path kept);
    //    stale marker → fall through and (re)install to self-heal.
    if (fs.existsSync(marker)) {
      const hookWired = SETTINGS.hasCavemanHook(settings, 'SessionStart');
      const filesPresent = fs.existsSync(path.join(dest, 'hooks', 'caveman-activate.js'));
      if (hookWired && filesPresent) return { skipped: 'marker' };
      // else: stale marker — treat as not-installed and re-install below.
    }

    // 2) Respect a pre-existing caveman install (user wired it themselves) —
    //    don't double-wire.
    if (SETTINGS.hasCavemanHook(settings, 'SessionStart')) {
      try {
        fs.mkdirSync(claudeDir, { recursive: true });
        fs.writeFileSync(marker, 'skipped: caveman SessionStart hook already present\n');
      } catch (_) {}
      return { skipped: 'already-present' };
    }

    // 3) Copy the vendored tree into ~/.claude/caveman-fleet/ (recursive, overwrite).
    copyDirSync(path.join(vendorDir, 'hooks'), path.join(dest, 'hooks'));
    copyDirSync(path.join(vendorDir, 'skills'), path.join(dest, 'skills'));
    // Commands go where Claude Code loads user slash-commands from:
    copyDirSync(path.join(vendorDir, 'commands'), path.join(claudeDir, 'commands')); // idempotent overwrite

    // 4) Wire the two hooks into settings.json (idempotent via basename markers).
    SETTINGS.validateHookFields(settings);
    const activate = path.join(dest, 'hooks', 'caveman-activate.js');
    const tracker = path.join(dest, 'hooks', 'caveman-mode-tracker.js');
    SETTINGS.addCommandHook(settings, 'SessionStart', {
      command: `node "${activate}"`, timeout: 5,
      statusMessage: 'Loading caveman mode...', marker: 'caveman-activate.js',
    });
    SETTINGS.addCommandHook(settings, 'UserPromptSubmit', {
      command: `node "${tracker}"`, timeout: 5,
      statusMessage: 'Tracking caveman mode...', marker: 'caveman-mode-tracker.js',
    });
    SETTINGS.writeSettings(settingsPath, settings);

    // 5) Marker LAST — only after everything above succeeded, so a partial
    //    failure retries on the next launch.
    fs.writeFileSync(marker, 'installed caveman v1.9.1 (vendored) ' + new Date().toISOString() + '\n');
    return { installed: true };
  } catch (e) {
    // Never throw into app startup. Caller also guards. Do NOT write the marker on failure.
    return { error: e && e.message };
  }
}

module.exports = { ensureCaveman };

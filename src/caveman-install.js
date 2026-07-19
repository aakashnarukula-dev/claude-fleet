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

// True iff a hook ENTRY references one of caveman's own managed scripts (exact
// basename match on each shell-ish command token — mirrors the vendored
// referencesManagedScript, which isn't exported). Anything that does NOT is a
// USER-authored entry we must preserve verbatim; a user hook whose command
// merely mentions "caveman" in some other path is therefore treated as a USER
// entry, never as ours.
function entryReferencesManaged(entry) {
  if (!entry || !Array.isArray(entry.hooks)) return false;
  const managed = SETTINGS.MANAGED_HOOK_BASENAMES;
  return entry.hooks.some(h => {
    if (!h || typeof h.command !== 'string') return false;
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(h.command)) !== null) {
      const tok = m[1] ?? m[2] ?? m[3];
      try {
        if (tok && managed.has(path.win32.basename(tok))) return true;
      } catch (_) { /* malformed token — not ours */ }
    }
    return false;
  });
}

// Snapshot every USER-authored (non-managed) hook entry, deep-cloned so nothing
// downstream can mutate it by reference. Returned shape: { [event]: entry[] }
// containing ONLY the user entries (caveman's own managed entries are omitted —
// those are (re)wired by the installer). Returns null when there are none.
function snapshotUserHooks(settings) {
  if (!settings || !settings.hooks || typeof settings.hooks !== 'object') return null;
  const snap = {};
  for (const ev of Object.keys(settings.hooks)) {
    const arr = settings.hooks[ev];
    if (!Array.isArray(arr)) continue;
    const userEntries = arr.filter(e => !entryReferencesManaged(e));
    if (userEntries.length) snap[ev] = JSON.parse(JSON.stringify(userEntries));
  }
  return Object.keys(snap).length ? snap : null;
}

// Re-insert the snapshotted user hook entries verbatim, undoing any collateral
// deletion that the vendored validateHookFields (run inside pruneOrphanedManaged-
// Hooks and, historically, before write) may have inflicted on hook shapes it
// doesn't recognize. For each event we keep caveman's freshly-computed managed
// entries and prepend the user entries exactly as they were read. This never
// resurrects a pruned ORPHAN (snapshots exclude managed entries) and never
// double-wires caveman (its entries come from the computed tree). Idempotent.
function restoreUserHooks(settings, snap) {
  if (!snap) return;
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  for (const ev of Object.keys(snap)) {
    const computed = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
    const managed = computed.filter(entryReferencesManaged);
    settings.hooks[ev] = snap[ev].concat(managed);
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

    // Read settings up front — the fast-path health check, the orphan prune,
    // and the pre-existing detection all need it.
    //
    // CRITICAL: readSettings returns `null` ONLY when settings.json EXISTS but
    // could not be parsed even by the JSONC-tolerant path (or it exists but
    // can't be read) — a deliberate "DO NOT overwrite this file" signal. A
    // MISSING file returns `{}` (a fresh install, where starting clean is
    // correct), so `null` never means "absent". If we coerced null -> {} and
    // proceeded, writeSettings would rewrite the user's global settings.json
    // down to ONLY the caveman hooks, destroying their permissions, env, model,
    // statusLine, MCP config and every other hook. So: bail out of the
    // settings-wiring entirely, don't write, and DON'T write the success marker
    // (so a later launch retries once the file is valid again).
    const settings = SETTINGS.readSettings(settingsPath);
    if (settings === null) {
      process.stderr.write(
        'caveman: ~/.claude/settings.json exists but could not be parsed; ' +
        'skipped caveman hook wiring to avoid clobbering it. ' +
        'Fix the file and relaunch to retry.\n'
      );
      return { skipped: 'settings-unparseable' };
    }

    // Snapshot the user's own (non-caveman) hook entries verbatim BEFORE any of
    // the vendored helpers below can mutate the tree. pruneOrphanedManagedHooks
    // runs validateHookFields internally, which deletes any inner hook whose
    // `type` isn't exactly 'command'/'agent' — so an unrecognized-but-valid user
    // hook would otherwise silently vanish on write. We restore these verbatim
    // before every write (see restoreUserHooks calls).
    const userHooksSnapshot = snapshotUserHooks(settings);

    // The two vendored hook scripts we manage + a full health read of the
    // install. Healthy = BOTH hooks wired (SessionStart activate + UserPromptSubmit
    // tracker) AND BOTH scripts on disk. We match on the exact script BASENAMES,
    // NOT the bare 'caveman' substring (hasCavemanHook's default) — a bare match
    // false-positives on an unrelated user hook whose command merely contains
    // "caveman" somewhere in its path, which would wrongly suppress our install.
    const activateFile = path.join(dest, 'hooks', 'caveman-activate.js');
    const trackerFile = path.join(dest, 'hooks', 'caveman-mode-tracker.js');
    const activateWired = SETTINGS.hasCavemanHook(settings, 'SessionStart', 'caveman-activate.js');
    const trackerWired = SETTINGS.hasCavemanHook(settings, 'UserPromptSubmit', 'caveman-mode-tracker.js');
    const filesPresent = fs.existsSync(activateFile) && fs.existsSync(trackerFile);
    const healthy = activateWired && trackerWired && filesPresent;

    // 1) Fast path: our marker present AND the install is fully healthy — skip.
    //    Anything less than fully healthy falls through to self-heal below. A
    //    stale marker (settings.json reset/restored, a hook hand-edited out, the
    //    tracker hook missing, or an earlier run that wrote the marker without
    //    fully wiring things) or — critically — files deleted out from under a
    //    still-wired hook must NOT keep caveman silently OFF / crashing every
    //    session on `node "<missing>"`.
    if (fs.existsSync(marker) && healthy) return { skipped: 'marker' };

    // 1b) Self-heal orphaned managed hooks: a hook we manage that points at a
    //     script no longer on disk (e.g. ~/.claude/caveman-fleet/ deleted while
    //     settings.json kept the SessionStart/UserPromptSubmit entries) makes
    //     Claude Code run `node "<missing>"` and crash every session. Prune those
    //     stale entries first so the (re)wire in step 4 installs a clean pointer
    //     instead of leaving/duplicating a broken one. A managed hook whose
    //     script still EXISTS is left untouched, so this is safe on a healthy
    //     user install and on our own healthy install alike.
    const prunedOrphans = SETTINGS.pruneOrphanedManagedHooks(settings, claudeDir);
    // prune runs validateHookFields internally, which can strip user hooks it
    // doesn't recognize — undo that collateral damage before ANY write (this
    // guards both the write just below and the pre-existing early-return path).
    restoreUserHooks(settings, userHooksSnapshot);
    if (prunedOrphans > 0) {
      SETTINGS.writeSettings(settingsPath, settings);
    }

    // 2) Respect a pre-existing GENUINE caveman install (the user wired it
    //    themselves) — don't double-wire. Two guards keep this precise:
    //     - No marker of ours: if our marker exists we OWN this install and must
    //       heal it (fall through), even when the activate hook alone still looks
    //       wired but the tracker or the vendored files are gone.
    //     - Precise + post-prune probe: after 1b, any surviving caveman-activate.js
    //       hook is guaranteed to point at a script that exists — a real, usable
    //       install, not an orphan and not a coincidental "caveman" path.
    if (!fs.existsSync(marker) &&
        SETTINGS.hasCavemanHook(settings, 'SessionStart', 'caveman-activate.js')) {
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
    //    NOTE: we intentionally do NOT call SETTINGS.validateHookFields(settings)
    //    here. That helper mutates the ENTIRE user hook tree in place, deleting
    //    any inner hook whose `type` is not exactly 'command' or 'agent' — so if
    //    Claude Code ever accepts a hook shape that predicate rejects, the user's
    //    hook would silently vanish on our write. The caveman entries we add
    //    below are well-formed by construction (`{ type:'command', command }`),
    //    and addCommandHook guards its own accesses (it creates hooks/event
    //    arrays as needed and hasCavemanHook tolerates non-array shapes), so no
    //    whole-tree normalization is needed. Pre-existing user hooks are written
    //    back verbatim.
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

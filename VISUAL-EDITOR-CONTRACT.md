# Live Preview + Visual Editor — build contract

A Claude Fleet feature: preview a product's running dev server inside the app, edit it visually,
and round-trip the edits through an agent that implements them in real source and ships via the Master.
This doc is the SHARED CONTRACT all workers build against. Decisions (locked with the user 2026-07-20):

- **Preview scope v1:** ONE product previewed at a time (the selected product's primary repo dev server).
- **Apply gate:** AUTO-APPLY high-confidence `text`/`style` edits (commit without a gate); STRUCTURAL
  (`move`/`add`/`delete`/`reorder`) and any low-confidence edit PAUSE and ask the user to confirm before commit.
- **Site coverage:** the user's sites are **React.js + plain HTML/CSS/JS** (target these two well; not Vue/Svelte/etc).
  - **React/Next** → precise: build-time `data-cfleet-oid` tagging → node-exact source location.
  - **Plain HTML/CSS/JS** → rendered ≈ source, so locate = a stable CSS selector/XPath that maps DIRECTLY to the
    source `.html` node (patch it in place); text edits via text-search; style edits map to the matching CSS rule
    (or add a class + rule). No build-time tagging needed for these — they round-trip via selector→file.
- Round-trip reuses existing Fleet plumbing (worktree panes, `.task`/`.spawn` markers, Master/Integrator ship).

## Editing surface = REAL Chrome DevTools (decided 2026-07-20, supersedes the custom-inspector idea)
The user does NOT want a custom limited inspector. The editing surface is the **actual Chrome DevTools** opened
on the preview webContents — full **Elements** tab (edit text/HTML, DRAG nodes from one div to another) + **Styles**
tab (edit any CSS rule / `element.style` / variables), same as inspecting a live site. We do NOT rebuild DevTools;
we EMBED it and CAPTURE the changes:
- Open DevTools on the preview webContents (Electron `webContents.openDevTools({mode:'right'})` / the `<webview>`'s
  `openDevTools`), docked beside the preview.
- CAPTURE the user's DevTools edits and round-trip them to the agent:
  - **DOM edits** (text, attributes/class, node MOVE across parents, add/delete) → an injected `MutationObserver`
    (in the overlay preload) records each mutation, tagged with the nearest `data-cfleet-oid` → source.
  - **CSS rule edits** (Styles tab, stylesheet rules not just inline) → attach a CDP session
    (`webContents.debugger`, enable `DOM`+`CSS`), listen for `CSS.styleSheetChanged`, and/or diff stylesheet text
    before/after; the DevTools "Changes" diff is the model to mirror.
- A "Save & send to agent" action collects the accumulated changeset → the visual-edit brief → the owning pane.
The custom inspector panel + floating toolbar from the earlier mock are DROPPED.

## Architecture (5 subsystems)
1. **Dev-server manager** (main process) — spawn `npm run dev` per worktree/product; free-port alloc; readiness
   (stdout banner + TCP probe); teardown wired into GC/liveness. IPC below.
2. **Preview surface** (`src/grid.html`) — an Electron `<webview>` pane pointed at the dev-server URL, with a
   toolbar (route, viewport, Edit toggle). Shown for a product's "Preview & edit" view.
3. **Element tagging + locate** — a build-time plugin (React/Next: stamp a stable `data-cfleet-oid` +
   file/line/col/component) injected into the PREVIEWED app's dev config by the dev-server manager; runtime
   locate tiers: oid attr → React `fiber._debugSource` (≤18) → selector/XPath + a11y (accName/role) → text.
4. **Inspect/edit overlay** (`src/preview-overlay-preload.js`, injected as the webview `preload`) — element picker
   + highlight, source chip, inline `contenteditable` text edit, style panel (colors resolve to project tokens /
   Tailwind classes), and an in-memory EDIT BUFFER. Talks to the host via `ipcRenderer.sendToHost('cfleet:edit', …)`.
5. **Agent round-trip** — buffer serializes to a VISUAL-EDIT BRIEF; a preload IPC hands it to main; main routes it
   to the owning product's pane via a `.task` (existing worker) or `.spawn` (new worker) marker; a brief-aware
   worker prompt implements → verifies → auto-applies-or-asks → commits → Master ships; preview re-anchors on rebuild.

## Shared identifiers (do NOT drift)
- **oid attribute:** `data-cfleet-oid` (value = opaque stable id; a build-time map resolves it to `{file,line,col,component}`).
- **IPC channels (preload `window.fleet`, main handlers) — ACTUAL, as implemented:**
  - `previewStart(sid, product, repo)` → `invoke('preview-start')` → `{ok, url, port, repo, commitBase} | {ok:false, error}`
  - `previewStop(sid, product)` → `invoke('preview-stop')` → `{ok}`
  - `previewStatus(sid, product)` → `invoke('preview-status')` → `{running, url, port, ready, commitBase}`
  - `previewOpenDevtools` / `previewCloseDevtools` → `invoke('preview-open-devtools'|'preview-close-devtools')`
  - `previewCdpStart` / `previewCollectChanges` / `previewCdpStop` → `invoke('preview-cdp-start'|'preview-collect-changes'|'preview-cdp-stop')`
  - `submitVisualEdits(sid, brief)` → `invoke('submit-visual-edits')` → `{ok, slug} | {ok:false, error}`
  - Args are POSITIONAL (`(sid, product, …)`), not a single object.
- **overlay↔host channels (ACTUAL):** overlay→host `ipcRenderer.sendToHost('cfleet:change', record)` + `'cfleet:ready'`;
  host→overlay `webview.send('cfleet:capture'|'cfleet:collect'|'cfleet:reset')`. (There is NO `cfleet:edit`/`cfleet:select`.)
  Host consumes overlay messages via `webview.addEventListener('ipc-message', e => …)`.

## Visual-edit brief schema (`cfleet.visual-edit/1`)
```jsonc
{
  "schema":"cfleet.visual-edit/1", "briefId":"ve-…", "sid":3, "repo":"front-server",
  "product":"storefront",                  // present in products mode (routing); null otherwise
  "route":"/pricing", "viewport":{"w":1280,"h":800,"dpr":2,"theme":"light"},  // theme = the PREVIEWED page's theme
  "commitBase":"<sha>",                    // previewed repo worktree HEAD (drift detection) — from previewStart
  "intent":"<optional one-line NL goal>",
  "edits":[{
    "editId":"e1",
    "kind":"text|style|attr|move|add|delete|reorder",
    "target":{ "oid":"…", "source":{"file":"…","line":42,"col":7,"component":"Hero"},
               "domPath":"main>section.hero>a.cta", "selector":".hero .cta",
               "role":"link","accName":"Start free trial" },   // priority: oid → source → selector/role
    "before":{ "text":"…", "className":"…", "computed":{…} },
    "after": { "prop":"className|text|…", "value":"bg-brand-green", "rawValue":"#16a34a",
               "tokenResolved":true, "tokenName":"brand-green" },
    "confidence":"high|low"                 // low ⇒ force confirm; structural kinds default low
  }],
  "screenshots":{ "before":"…","after":"…","beforeCrop":"…","afterCrop":"…" }  // corroboration only
}
```

## Apply policy (agent side)
- `text`/`style`/`attr` + `confidence:"high"` → apply via AST codemod (Tailwind class mutation + tailwind-merge for
  style), commit WITHOUT a confirm gate (auto-apply).
- `move`/`add`/`delete`/`reorder` OR `confidence:"low"` OR unresolvable oid/drift OR verify-screenshot mismatch →
  the agent RESTATES + shows the diff and ASKS in its pane; waits for the user before commit.
- After commit: worker `--done` (+ `--touched`); Master/Integrator merges → test-gates → `--ship` (existing).

## Build phases
- P1: (a) dev-server manager + IPC (main.js/preload.js + `src/devserver.js`); (b) build-time tagging plugin +
  locate module (new standalone files). Parallel.
- P2: (a) preview `<webview>` pane + toolbar (grid.html); (b) inspect/edit overlay preload + edit buffer +
  brief serializer (`src/preview-overlay-preload.js`). Parallel.
- P3: (a) `submitVisualEdits` IPC + main routing to the owning pane via markers (preload/main); (b) brief-aware
  worker prompt + apply/verify/gate policy (bin/claude-fleet). Parallel.
- P4: deep multi-agent review + fixes + end-to-end verify + ship.

Reference mock (approved UX): `scratchpad/visual-editor-mock.html`. Keep the existing terminal-grid + Products
sidebar UX unchanged; the preview is an ADDITIVE view.

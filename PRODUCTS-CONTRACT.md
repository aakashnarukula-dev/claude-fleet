# Products / Master mode — Phase 1 contract (engine + main process)

This documents the **contract** Phase 1 (engine + `src/main.js` + `src/preload.js`) exposes for Phase 2
(`src/config.html` mode UI + `src/grid.html` sidebar). Phase 1 is add-only and dormant until Phase 2 sends
`mode:'products'`; every existing mode is byte-for-byte unchanged.

## The model (3 tiers)

```
MASTER ──(watch/conflict-check/merge/test/push)──►  each repo's shared _main  ──► origin/main
  ▲
  │  product P is "ready" when its task-orchestrator runs `claude-fleet --done`
  │
TASK-ORCHESTRATOR(P) ──(integrate)──►  fleet/s<sid>/<P>/_product   (one per product; NEVER pushes)
  ▲
  │
WORKERS of P  ──(commit + --done, NO push)──►  fleet/s<sid>/<P>/<worker>   (each spans ALL repos)
```

- **Master** owns each repo's shared `_main` and is the **only pusher**. Auto-ships each product incrementally
  (green product → merge its `_product` into each touched `_main` → test-gate → `--ship` → `--merged`).
- **Task-orchestrator** (one per product) = a product-scoped gyftalala orchestrator. Integrates its workers into
  `<P>/_product`; on ALL DONE runs `--done` to signal the master. Never pushes.
- **Worker** spans every selected repo (like `--grid-plan-shared`), commits + `--done`, never pushes.

## 1. Config cfg → `window.fleet.launch(cfg)`

```js
{
  mode: 'products',
  account,                              // gh account string | null (same as gyftalala)
  repos: [ { nameWithOwner, defaultBranch, paneName } … ],   // ≥1; SAME shape gyftalala uses (cloneRepos)
  tasks: [ '<product/task name>' … ],   // ≥1 user-named products (free text; engine slugifies each)
  autonomous: true,                     // products mode is always autonomous
}
```
Every product spans **all** selected repos (no per-product repo subset). `buildFleet` returns
`{ ok:true }` or `{ ok:false, error }`.

## 2. IPC payloads (main → renderer)

### `add-session` (initial)
`sendAddSession(sid, title, color, meta, 'products', win)` with
```js
meta = [
  { id: 0, role: 'master', heading: 'Master' },                       // no product → pin at top
  { id: 1, role: 'orchestrator', heading: '<task1>', product: '<p1-slug>' },
  { id: 2, role: 'orchestrator', heading: '<task2>', product: '<p2-slug>' },
  …
]
```
`mode` field on the payload is `'products'`. `product` is a **hint** for grouping (slugified in JS via
`fleetSlug`); the **authoritative** slug per pane arrives in `s.panes` after the plan resolves (`onReady`).
Duplicate task names are NOT de-duped in the initial hint (the engine appends `-2`); read `s.panes[i].slug`
for the real value if it matters.

### `add-pane` (a worker or an added product appears later)
```js
{ sid, pane: { id, role, heading, product } }
```
- Task-orchestrator's spawned workers → `role:'worker'`, `product:'<P>'` (group under product `<P>`).
- `--add-product` (see §5) → `role:'orchestrator'`, `product:'<P>'` (a new product group).
- Master pane has **no** `product` (render pinned at top / ungrouped).

Phase-2 grouping key: **`pane.product`** (present on task-orchestrators + workers; absent on the master).

## 3. Pane roles + per-pane env (set by `spawnPane`)

| role (`p.role`)          | product? | CLAUDE_FLEET_* env set                                    | effort | pushes? | MCP |
|--------------------------|----------|----------------------------------------------------------|--------|---------|-----|
| `master`                 | no       | STATUS_DIR, MULTI, REPOS                                  | xhigh  | **yes** | yes |
| `orchestrator` (tier task)| `<P>`   | STATUS_DIR, MULTI, REPOS, **PRODUCT=`<P>`**               | high   | no      | yes |
| `worker`                 | `<P>`    | STATUS_DIR, MULTI, REPOS, **PRODUCT=`<P>`**               | high\* | no      | no  |

\* worker honors an explicit `--effort` from its spawn marker. `isCoordinator(role)` =
`orchestrator|integrator|master`. Push policy in products mode: **only `master`**
(`mayPush = s.products ? role==='master' : …`). Session flags: `s.products=true`, `s.master=true`,
`s.sharedMulti=true`, `s.coordDir=<coord>`, `s.repos=[paths]`, `s.tasks=[names]`.

## 4. preload surface (`window.fleet`)

- `addProduct({ sid, name })` → `invoke('add-product', …)` → `{ ok, heading } | { ok:false, error }`.
  Adds ONE product to a running session (new task-orchestrator pane via `add-pane`).

(Everything else — `launch`, `onAddSession`, `onAddPane`, … — is unchanged.)

## 5. Engine verbs (`bin/claude-fleet`)

- `--products-plan <N> <task-name…>` (multi-repo) — builds the whole session: each repo's shared `_main`, each
  product's `_product` branch/checkout, coord `.status` (+ `members` + `tasks` gc markers). Emits the pane JSON
  array: **master first (id 0)**, then one task-orchestrator per product. Shelled by `runProductsPlan`.
- `--add-product <name>` — scaffolds one product on a running session; prints ONE task-orchestrator pane spec.
  Shelled by main's `addProduct`.
- Product-scoping is driven by **`CLAUDE_FLEET_PRODUCT=<P>`** (add-only; every verb is unchanged when unset):
  - branch namespace → `fleet/s<sid>/<P>`; board slugs → `<P>__<worker>`; manifest/board scans → filter to `<P>__*`.
  - master context (PRODUCT unset, on a products board flagged by `.status/tasks`) → scans see only TOP-LEVEL
    product slugs (no `__`).
- Board slug convention (Phase 2 may need to parse): a worker is `<P>__<worker>`; a product/task-orchestrator is
  the bare `<P>`; the master pane's slug is the literal `master` (NOT on the manifest).
- Master's per-product landing verbs: `--watch`/`--ready` (products), `--conflicts` (cross-product overlap radar,
  `<repo>/<path>`-namespaced), `--touched <P>` (repos the product changed), `--ship <repos…>` (atomic push),
  `--merged <P>`, `--hold <P>` (defer a red/failed product).

## 6. Disk layout (session `<sid>`)

```
$SESSIONS_DIR/products-master-fleet-<sid>/        ← master coord (cwd of master pane)
    .status/                                      ← THE one shared coordination dir (single app watcher)
        manifest                                  ← product slugs <P> + worker slugs <P>__<w>
        tasks                                     ← product slugs (gc flag + master-scope signal)
        members                                   ← each <repo>-fleet-<sid> path (gc)
        <P>.done|.claims|.held|.merged            ← product-level (master consumes)
        <P>__<w>.done|.claims|.spawn|…            ← worker-level (task-orchestrator consumes)
    products/<P>/<repo-basename> -> …/_product-<P>   ← task-orchestrator P's cwd (per-repo _product checkout)
    workers/<P>__<w>/<repo-basename> -> …/<P>__<w>   ← worker's cwd (per-repo worktree)

$SESSIONS_DIR/<repo>-fleet-<sid>/                 ← per selected repo (one each)
    _main               (detached, MASTER-owned, merge target + push source; branch fleet/s<sid>/<P>/_product merges in)
    _product-<P>        (checkout on branch fleet/s<sid>/<P>/_product; task-orchestrator merges workers here)
    <P>__<w>            (worker worktree on branch fleet/s<sid>/<P>/<w>)
    .status/repo        (gc member marker → real repo path)
```

GC: the coord (flagged by `.status/tasks`) is reaped by `gc_one_products` only once every member `<repo>-fleet-<sid>`
is gone (routed from `cmd_gc_all` before the `members`/gyftalala path); members reaped by the normal `gc_one_session`
G0–G4 once their `fleet/s<sid>/*` branches are merged into main.

## What Phase 2 must build

- **config.html**: a "Products / Master mode" option under multi-repo (repo checklist + a list of product/task
  names) that calls `fleet.launch({ mode:'products', account, repos, tasks, autonomous:true })`.
- **grid.html**: group panes by `pane.product` in the sidebar (master pinned at top, ungrouped); optionally a
  "+ Product" affordance calling `fleet.addProduct({ sid, name })`.

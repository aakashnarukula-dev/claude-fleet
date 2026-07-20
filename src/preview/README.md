# Visual Editor — element tagging + runtime locate (Phase 1b)

Two standalone, dependency-free modules that turn a picked DOM element in the preview
`<webview>` into a precise source `target` for the round-trip agent. Matches
`VISUAL-EDITOR-CONTRACT.md` (oid attribute name, locate tiers, `target` shape).

- `oid-babel-plugin.js` — build-time React/JSX tagging (dev-only).
- `locate.js` — runtime `locate(el)` + `describeStyle` + `tokenForColor` (loaded inside the previewed page).
- `__tests__/preview.test.js` — `node src/preview/__tests__/preview.test.js` (no deps; uses `@babel/core` only if present).

No new dependencies. `@babel/core` is NOT in this repo — the plugin is written against
the standard Babel visitor API and is exercised by whatever Babel the previewed **target
repo** already ships (Vite/Next/CRA all bundle it). The pure helpers are unit-tested here
without it.

## 1. `oid-babel-plugin.js` (React / Next)

Stamps every JSX **host** element (lowercase tag = real DOM node; `<Component/>` skipped)
with:

- `data-cfleet-oid="cf-<hash>"` — **opaque, stable primary key** (locate Tier 0).
- `data-cfleet-loc="<file>:<line>:<col>"` — secondary, for the source chip / agent fallback.

and injects a per-file prelude that merges `oid -> {file,line,col,component}` into
`window.__CFLEET_OID_MAP__`, so the runtime + agent resolve `oid -> source` with **no
dev-server changes**.

**Stability:** the oid hashes `file + component + intra-file-index` — NOT the line number,
which drifts on every edit. The contract wants oid as the durable key; line/col in
`data-cfleet-loc` are a convenience only.

**Guard (dev-only, opt-in):** armed solely when `process.env.CFLEET_INSTRUMENT` is truthy
(the dev-server manager sets it while previewing). Unset → the plugin returns an empty
visitor = a **no-op**, so it can never affect a production build. It's also idempotent
(skips an element already carrying `data-cfleet-oid`).

### Adding it to a target repo's dev config

The dev-server manager passes the plugin path via `CFLEET_OID_PLUGIN` and arms it with
`CFLEET_INSTRUMENT=1` when it spawns the dev server. Wire it into whichever config the repo
uses (dev-mode only):

**Vite** (`vite.config.js`):
```js
import react from '@vitejs/plugin-react';
const oid = process.env.CFLEET_INSTRUMENT && process.env.CFLEET_OID_PLUGIN;
export default {
  plugins: [react({ babel: { plugins: oid ? [oid] : [] } })],
};
```

**Next.js / Babel** (`.babelrc` / `babel.config.js`):
```js
module.exports = {
  presets: ['next/babel'],
  plugins: process.env.CFLEET_INSTRUMENT ? [process.env.CFLEET_OID_PLUGIN] : [],
};
```

**CRA / raw Babel:** add `process.env.CFLEET_OID_PLUGIN` to the `plugins` array behind the
same `CFLEET_INSTRUMENT` guard.

Because the guard also lives inside the plugin, a stray include in production is still a
no-op — belt and suspenders.

## 2. `locate.js` (runtime, all stacks)

Loaded inside the previewed page by the overlay preload. `locate(el)` returns a `target`
using the tiered strategy, with a priority-ordered `locators[]` (`oid → source →
selector/role`) so the agent degrades gracefully:

| Tier | Stack | How | Reliability |
|------|-------|-----|-------------|
| 0 | React/Next (instrumented) | `el.closest('[data-cfleet-oid]')` → oid + source (from `__CFLEET_OID_MAP__`, or `data-cfleet-loc`) | node-exact |
| 1 | React ≤18 (no oid) | walk `__reactFiber$…` → `_debugSource` | best-effort — **React 19 removed `_debugSource`** |
| 2 | Plain HTML/CSS/JS (or fallback) | stable unique CSS selector + absolute XPath + ARIA `role`/`accName` + trimmed text | reliable for static HTML (rendered ≈ source → selector maps straight to the `.html` node) |

`target` fields: `oid`, `source{file,line,col,component}`, `domPath`, `selector`, `xpath`,
`role`, `accName`, `text`, `tier`, `anchor`, `reliable`, `staticHtml`, `note`, `locators[]`.

Selectors anchor on a stable `id` when present (framework-volatile ids like `:r0:`,
`radix-*` are ignored) and use `:nth-of-type` to stay unique otherwise.

### Style helpers (for the overlay style panel + agent routing)

- `describeStyle(el)` → `{system:'tailwind'|'inline'|'css'|'unknown', classes, tailwindClasses,
  hasInlineStyle, inlineStyle, hint}`. Routes a color edit to a **Tailwind class** vs an
  **inline style** vs an **external CSS rule**.
- `tokenForColor(rgbOrHex, tailwindConfig?)` → `{tokenResolved, tokenName, rawValue, hex}`.
  Normalizes hex/rgb(a), then resolves against the project's `tailwind.config` colors first,
  falling back to a built-in Tailwind palette. Always keeps `rawValue` (contract wants
  `tokenResolved`/`tokenName`/`rawValue`).

## Notes / contract gaps

- Tier 1 (`_debugSource`) is best-effort and absent under React 19; Tier 0 (build-time oid)
  is the real React path and why the plugin exists.
- `tokenForColor`'s built-in palette is a common subset; pass the project's `tailwind.config`
  colors for exact brand-token resolution. Loading that config into the overlay is the
  dev-server manager's job (out of this module's scope).

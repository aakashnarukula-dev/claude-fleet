'use strict';
/*
 * src/preview/locate.js — Claude Fleet Visual Editor, Phase 1b runtime LOCATE.
 *
 * Runs INSIDE the previewed page (loaded by the inspect/edit overlay preload).
 * Maps a picked DOM element -> a `target` object matching VISUAL-EDITOR-CONTRACT.md,
 * using a TIERED strategy and a priority-ordered multi-locator so the round-trip
 * agent can degrade gracefully:
 *
 *   Tier 0  React/Next precise : el.closest('[data-cfleet-oid]')
 *                                -> {oid, source:{file,line,col,component}}
 *   Tier 1  React <=18 fallback: walk __reactFiber$… -> fiber._debugSource
 *                                (React 19 removed _debugSource — best-effort)
 *   Tier 2  plain HTML/CSS/JS  : stable unique CSS selector + XPath + a11y
 *                                (role/accName) + trimmed text. For static HTML
 *                                rendered ≈ source, so the selector is a reliable
 *                                write anchor into the .html file.
 *
 * Also exposes overlay/agent helpers:
 *   describeStyle(el)                 -> which styling system owns this element
 *   tokenForColor(rgbOrHex, twConfig) -> best-effort color -> project/Tailwind token
 *
 * UMD-ish export: CommonJS (module.exports) for unit tests + preload require;
 * also attaches to globalThis.CFleetLocate for a plain <script> include. Written
 * against standard DOM props only (tagName/id/className/getAttribute/parentElement/
 * children/textContent/closest) so it unit-tests against minimal fake elements —
 * no jsdom/happy-dom dependency.
 */

var OID_ATTR = 'data-cfleet-oid';
var LOC_ATTR = 'data-cfleet-loc';
var MAP_GLOBAL = '__CFLEET_OID_MAP__';

/* ---------------- oid map access ---------------- */
function oidMap() {
  try {
    return (typeof window !== 'undefined' && window[MAP_GLOBAL]) || {};
  } catch (e) {
    return {};
  }
}

/* Parse a "file:line:col" data-cfleet-loc value. Filenames may contain ':' on
 * Windows, so split from the RIGHT for the two trailing numeric segments. */
function parseLoc(str) {
  if (!str || typeof str !== 'string') return null;
  var m = str.match(/^(.*):(\d+):(\d+)$/);
  if (!m) return null;
  return { file: m[1], line: parseInt(m[2], 10), col: parseInt(m[3], 10) };
}

/* ---------------- Tier 0: oid attribute ---------------- */
function tier0(el) {
  var host = el && el.closest ? el.closest('[' + OID_ATTR + ']') : null;
  if (!host) return null;
  var oid = getAttr(host, OID_ATTR);
  if (!oid) return null;
  var source = null;
  var mapped = oidMap()[oid];
  if (mapped) {
    source = {
      file: mapped.file,
      line: mapped.line,
      col: mapped.col,
      component: mapped.component || null,
    };
  } else {
    var loc = parseLoc(getAttr(host, LOC_ATTR));
    if (loc) source = { file: loc.file, line: loc.line, col: loc.col, component: null };
  }
  return { oid: oid, source: source, exact: host === el };
}

/* ---------------- Tier 1: React fiber _debugSource ---------------- */
function reactFiber(el) {
  if (!el) return null;
  for (var k in el) {
    if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) {
      return el[k];
    }
  }
  return null;
}
function tier1(el) {
  var fiber = reactFiber(el);
  var guard = 0;
  while (fiber && guard++ < 200) {
    var ds = fiber._debugSource;
    if (ds && ds.fileName) {
      return {
        source: {
          file: ds.fileName,
          line: ds.lineNumber || 0,
          col: ds.columnNumber || 0,
          component: componentNameFromFiber(fiber),
        },
      };
    }
    fiber = fiber.return || fiber._debugOwner || null;
  }
  return null;
}
function componentNameFromFiber(fiber) {
  var f = fiber;
  var guard = 0;
  while (f && guard++ < 200) {
    var ty = f.type;
    if (typeof ty === 'function') return ty.displayName || ty.name || null;
    if (ty && typeof ty === 'object' && (ty.displayName || ty.name)) return ty.displayName || ty.name;
    f = f._debugOwner || f.return || null;
  }
  return null;
}

/* ---------------- Tier 2: selector / XPath / a11y ---------------- */

function getAttr(el, name) {
  if (!el) return null;
  if (typeof el.getAttribute === 'function') return el.getAttribute(name);
  return null;
}
function tagOf(el) {
  return el && el.tagName ? String(el.tagName).toLowerCase() : '';
}
function parentOf(el) {
  return (el && (el.parentElement || el.parentNode)) || null;
}
function childrenOf(el) {
  if (!el) return [];
  if (el.children && el.children.length !== undefined) return Array.prototype.slice.call(el.children);
  return [];
}

/* CSS.escape shim (not present in all runtimes / fakes). */
function cssEscape(s) {
  if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_ -￿-]/g, function (ch) {
    return '\\' + ch;
  });
}

/* Is an id safe to use as a UNIQUE selector anchor? Non-empty, not obviously
 * framework-generated/volatile (react-*, radix-*, :r0:, pure-number). */
function isStableId(id) {
  if (!id || typeof id !== 'string') return false;
  if (/^[0-9]/.test(id)) return false;
  if (/^(react|radix|headlessui|mui|:r|ember|ext-gen)/i.test(id)) return false;
  if (/[:]/.test(id)) return false; // React useId() ":r0:" style
  return true;
}

/* Index of el among same-tag siblings (1-based, :nth-of-type). */
function nthOfType(el) {
  var parent = parentOf(el);
  if (!parent) return 1;
  var tag = tagOf(el);
  var sibs = childrenOf(parent).filter(function (c) { return tagOf(c) === tag; });
  var i = sibs.indexOf(el);
  return i < 0 ? 1 : i + 1;
}

/* Build a stable, unique-ish CSS selector by walking up to a stable id or root. */
function cssSelector(el) {
  if (!el || !tagOf(el)) return '';
  var parts = [];
  var cur = el;
  var guard = 0;
  while (cur && tagOf(cur) && guard++ < 100) {
    var id = getAttr(cur, 'id');
    if (isStableId(id)) {
      parts.unshift('#' + cssEscape(id));
      break; // an id is unique — anchor here
    }
    var seg = tagOf(cur);
    var same = 0;
    var parent = parentOf(cur);
    if (parent) {
      same = childrenOf(parent).filter(function (c) { return tagOf(c) === tagOf(cur); }).length;
    }
    if (same > 1) seg += ':nth-of-type(' + nthOfType(cur) + ')';
    parts.unshift(seg);
    cur = parent;
  }
  return parts.join(' > ');
}

/* Absolute XPath with positional predicates — stable, unambiguous. */
function xPath(el) {
  if (!el || !tagOf(el)) return '';
  var parts = [];
  var cur = el;
  var guard = 0;
  while (cur && tagOf(cur) && guard++ < 100) {
    var idx = nthOfType(cur);
    parts.unshift(tagOf(cur) + '[' + idx + ']');
    cur = parentOf(cur);
  }
  return '/' + parts.join('/');
}

/* Short readable DOM path for the source chip (tag + class hints). */
function domPath(el) {
  var parts = [];
  var cur = el;
  var guard = 0;
  while (cur && tagOf(cur) && guard++ < 6) {
    var seg = tagOf(cur);
    var cls = classList(cur)[0];
    if (cls) seg += '.' + cls;
    parts.unshift(seg);
    cur = parentOf(cur);
  }
  return parts.join('>');
}

function classList(el) {
  if (!el) return [];
  if (el.classList && el.classList.length !== undefined) return Array.prototype.slice.call(el.classList);
  var cn = el.className;
  if (typeof cn === 'string') return cn.trim().split(/\s+/).filter(Boolean);
  if (cn && typeof cn.baseVal === 'string') return cn.baseVal.trim().split(/\s+/).filter(Boolean); // SVG
  return [];
}

/* ARIA role: explicit attr, else a small implicit-role map by tag. */
var IMPLICIT_ROLE = {
  a: 'link', button: 'button', nav: 'navigation', main: 'main', header: 'banner',
  footer: 'contentinfo', aside: 'complementary', h1: 'heading', h2: 'heading',
  h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', img: 'img',
  ul: 'list', ol: 'list', li: 'listitem', input: 'textbox', textarea: 'textbox',
  select: 'combobox', form: 'form', table: 'table', section: 'region', p: null,
};
function ariaRole(el) {
  var explicit = getAttr(el, 'role');
  if (explicit) return explicit;
  var tag = tagOf(el);
  if (tag === 'a' && getAttr(el, 'href') == null) return null; // anchor w/o href is not a link
  if (tag === 'input') {
    var type = (getAttr(el, 'type') || 'text').toLowerCase();
    if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    return 'textbox';
  }
  return Object.prototype.hasOwnProperty.call(IMPLICIT_ROLE, tag) ? IMPLICIT_ROLE[tag] : null;
}

function textOf(el) {
  var t = el && (el.textContent != null ? el.textContent : el.innerText);
  return t ? String(t).replace(/\s+/g, ' ').trim() : '';
}

/* Accessible name — simplified accname algorithm (aria-label > aria-labelledby >
 * alt/title/value > trimmed text). Good enough for a locate hint. */
function accName(el) {
  var al = getAttr(el, 'aria-label');
  if (al) return al.trim();
  var lb = getAttr(el, 'aria-labelledby');
  if (lb && typeof document !== 'undefined' && document.getElementById) {
    var names = lb.split(/\s+/).map(function (id) {
      var r = document.getElementById(id);
      return r ? textOf(r) : '';
    }).filter(Boolean);
    if (names.length) return names.join(' ');
  }
  var tag = tagOf(el);
  if (tag === 'img') { var alt = getAttr(el, 'alt'); if (alt) return alt.trim(); }
  if (tag === 'input') {
    var val = getAttr(el, 'value'); if (val) return val.trim();
    var ph = getAttr(el, 'placeholder'); if (ph) return ph.trim();
  }
  var title = getAttr(el, 'title'); if (title) return title.trim();
  var txt = textOf(el);
  return txt.length > 120 ? txt.slice(0, 117) + '…' : txt;
}

function tier2(el) {
  return {
    domPath: domPath(el),
    selector: cssSelector(el),
    xpath: xPath(el),
    role: ariaRole(el),
    accName: accName(el),
    text: (function () { var t = textOf(el); return t.length > 200 ? t.slice(0, 197) + '…' : t; })(),
  };
}

/* ---------------- public: locate(el) ---------------- */
function locate(el) {
  if (!el) return null;
  var t2 = tier2(el); // always available; the universal fallback anchor
  var t0 = tier0(el);
  var t1 = !t0 ? tier1(el) : null;

  var oid = t0 ? t0.oid : null;
  var source = (t0 && t0.source) || (t1 && t1.source) || null;

  var tier = t0 ? 0 : (t1 ? 1 : 2);
  var anchor = t0 ? 'oid' : (t1 ? 'fiber' : 'selector');

  // Static HTML (no oid, no fiber): rendered ≈ source, so selector is a reliable
  // write anchor straight into the .html file.
  var staticHtml = !t0 && !t1;
  var reliable = !!t0 || staticHtml;

  var note;
  if (t0) note = 'Tier 0: build-time oid — node-exact source location.';
  else if (t1) note = 'Tier 1: React fiber _debugSource (best-effort; absent on React 19).';
  else note = 'Tier 2: plain HTML/CSS/JS — selector maps directly to the source .html node (reliable write anchor).';

  // Priority-ordered multi-locator: oid → source → selector/role.
  var locators = [];
  if (oid) locators.push({ type: 'oid', value: oid });
  if (source) locators.push({ type: 'source', value: source });
  locators.push({ type: 'selector', value: t2.selector, xpath: t2.xpath, role: t2.role, accName: t2.accName });

  return {
    oid: oid,
    source: source,
    domPath: t2.domPath,
    selector: t2.selector,
    xpath: t2.xpath,
    role: t2.role,
    accName: t2.accName,
    text: t2.text,
    tier: tier,
    anchor: anchor,
    reliable: reliable,
    staticHtml: staticHtml,
    note: note,
    locators: locators,
  };
}

/* ---------------- public: describeStyle(el) ---------------- */

// Heuristic: does a class token look like a Tailwind utility?
var TW_UTILITY = /^(-?(?:sm|md|lg|xl|2xl|hover|focus|active|dark|group-hover|first|last|odd|even|disabled|motion-safe|motion-reduce|print|rtl|ltr):)*-?(bg|text|border|from|via|to|ring|shadow|fill|stroke|decoration|divide|placeholder|accent|caret|outline|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|w|h|min-w|min-h|max-w|max-h|gap|space|flex|grid|col|row|justify|items|content|self|order|rounded|font|leading|tracking|opacity|z|inset|top|bottom|left|right|translate|scale|rotate|skew|transition|duration|ease|delay|animate)(-[a-z0-9./[\]#%-]+)?$/;
function looksTailwind(cls) { return TW_UTILITY.test(cls); }

function describeStyle(el) {
  var classes = classList(el);
  var tw = classes.filter(looksTailwind);
  var hasInline = false;
  var inlineStyle = getAttr(el, 'style');
  if (inlineStyle && inlineStyle.trim()) hasInline = true;
  else if (el && el.style && typeof el.style === 'object') {
    // jsdom/real DOM: a set inline prop
    if (el.style.cssText && el.style.cssText.trim()) hasInline = true;
  }

  var system, hint;
  if (tw.length > 0) {
    system = 'tailwind';
    hint = 'Route color/spacing edits to a Tailwind utility class (e.g. bg-*, text-*); mutate the className via AST + tailwind-merge.';
  } else if (hasInline) {
    system = 'inline';
    hint = 'Element carries an inline style attribute; a style edit should patch the inline style prop directly.';
  } else if (classes.length > 0) {
    system = 'css';
    hint = 'Non-Tailwind class(es) present; a style edit maps to the matching external CSS rule (or add a class + rule).';
  } else {
    system = 'unknown';
    hint = 'No classes and no inline style; a style edit should ADD a class (+ CSS rule) or an inline style.';
  }

  return {
    system: system,
    classes: classes,
    tailwindClasses: tw,
    hasInlineStyle: hasInline,
    inlineStyle: inlineStyle || null,
    hint: hint,
  };
}

/* ---------------- public: tokenForColor(rgbOrHex, twConfig) ---------------- */

function normalizeHex(input) {
  if (input == null) return null;
  var s = String(input).trim().toLowerCase();
  var m;
  if ((m = s.match(/^#([0-9a-f]{3})$/))) {
    return '#' + m[1].split('').map(function (c) { return c + c; }).join('');
  }
  if (s.match(/^#([0-9a-f]{6})$/)) return s;
  if (s.match(/^#([0-9a-f]{8})$/)) return s.slice(0, 7); // drop alpha
  if ((m = s.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/))) {
    return '#' + [m[1], m[2], m[3]].map(function (n) {
      var h = Math.max(0, Math.min(255, parseInt(n, 10))).toString(16);
      return h.length === 1 ? '0' + h : h;
    }).join('');
  }
  return null;
}

// Small default Tailwind palette (subset) — enough to resolve common brand colors.
var DEFAULT_TW_COLORS = {
  '#000000': 'black', '#ffffff': 'white',
  '#ef4444': 'red-500', '#dc2626': 'red-600',
  '#f97316': 'orange-500', '#f59e0b': 'amber-500',
  '#eab308': 'yellow-500', '#22c55e': 'green-500', '#16a34a': 'green-600',
  '#10b981': 'emerald-500', '#14b8a6': 'teal-500', '#06b6d4': 'cyan-500',
  '#3b82f6': 'blue-500', '#2563eb': 'blue-600', '#6366f1': 'indigo-500',
  '#8b5cf6': 'violet-500', '#a855f7': 'purple-500', '#ec4899': 'pink-500',
  '#64748b': 'slate-500', '#6b7280': 'gray-500', '#71717a': 'zinc-500',
  '#111827': 'gray-900', '#1f2937': 'gray-800', '#f3f4f6': 'gray-100',
};

/* Flatten a tailwind.config theme.colors object into {hex: 'name-shade'}. */
function flattenTwConfig(twConfig) {
  var out = {};
  if (!twConfig || typeof twConfig !== 'object') return out;
  var colors = (twConfig.theme && (twConfig.theme.extend && twConfig.theme.extend.colors || twConfig.theme.colors)) || twConfig.colors || twConfig;
  (function walk(obj, prefix) {
    if (!obj || typeof obj !== 'object') return;
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      var name = prefix ? prefix + '-' + k : k;
      if (typeof v === 'string') {
        var hex = normalizeHex(v);
        if (hex) out[hex] = (k === 'DEFAULT' && prefix) ? prefix : name;
      } else if (v && typeof v === 'object') {
        walk(v, name);
      }
    });
  })(colors, '');
  return out;
}

function tokenForColor(rgbOrHex, twConfig) {
  var rawValue = rgbOrHex == null ? null : String(rgbOrHex);
  var hex = normalizeHex(rgbOrHex);
  if (!hex) {
    return { tokenResolved: false, tokenName: null, rawValue: rawValue, hex: null };
  }
  // Project config wins over the default palette.
  var projectMap = flattenTwConfig(twConfig);
  var name = projectMap[hex] || DEFAULT_TW_COLORS[hex] || null;
  return {
    tokenResolved: !!name,
    tokenName: name,
    rawValue: rawValue,
    hex: hex,
  };
}

/* ---------------- exports (UMD-ish) ---------------- */
var api = {
  locate: locate,
  describeStyle: describeStyle,
  tokenForColor: tokenForColor,
  // internals exposed for unit tests
  _cssSelector: cssSelector,
  _xPath: xPath,
  _accName: accName,
  _ariaRole: ariaRole,
  _normalizeHex: normalizeHex,
  _parseLoc: parseLoc,
  _isStableId: isStableId,
  OID_ATTR: OID_ATTR,
  LOC_ATTR: LOC_ATTR,
  MAP_GLOBAL: MAP_GLOBAL,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.CFleetLocate = api;

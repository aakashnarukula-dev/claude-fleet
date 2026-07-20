'use strict';
/*
 * src/preview-overlay-preload.js — Claude Fleet Visual Editor, Phase 2.
 *
 * The CAPTURE overlay for the Live Preview. Injected as the `preload` of the preview
 * <webview> (grid.html), so it runs INSIDE the previewed dev-server page with ipcRenderer
 * available (sandbox-safe: sendToHost / on / require('electron')).
 *
 * The user EDITS in the REAL Chrome DevTools (Elements + Styles), docked to the right of
 * the preview — we do NOT reimplement any inspector. This file's only job is to CAPTURE
 * whatever the user changes and report it to the host:
 *
 *   1. DOM edits (Elements tab: edit text/HTML, edit attributes/inline style/class, drag
 *      nodes) via a MutationObserver over document (childList/attributes+oldValue/
 *      characterData+oldValue). Each change is tagged with the nearest data-cfleet-oid via
 *      Phase-1 locate() and coalesced per element+prop (typing => one record).
 *   2. CSS stylesheet-RULE edits (Styles tab editing a matched rule in a .css file — these
 *      don't mutate the DOM) via a CSSOM snapshot+diff of document.styleSheets. This works
 *      WITH DevTools open (DevTools applies rule edits to the live CSSOM). main.js also runs
 *      a best-effort CDP path for source-file mapping, but CDP can't attach while DevTools
 *      holds the debugger — so this CSSOM diff is the reliable path.
 *
 * MESSAGE PROTOCOL (this file owns BOTH ends; grid.html is the host):
 *   overlay -> host   ipcRenderer.sendToHost(channel, payload)
 *     'cfleet:ready'   {}                        capture overlay installed
 *     'cfleet:change'  {record}                  one coalesced change record
 *   host -> overlay   ipcRenderer.on(channel, (_e,payload) => …)
 *     'cfleet:capture' {on}                       start/stop capturing (Edit toggle)
 *     'cfleet:collect' {}                         flush pending + diff CSSOM now (on Save)
 *     'cfleet:reset'   {}                          clear buffers + re-baseline CSSOM
 *
 * change record: { kind:'text'|'style'|'attr'|'move'|'add'|'delete', prop, target(oid→
 *   source→selector/role, from locate()), name, before, after, confidence:'high'|'low',
 *   cssRule?, sourceURL?, rawValue?, tokenName? }
 *
 * SELF-CONTAINED: the Phase-1 locate/describeStyle/tokenForColor logic is INLINED (a
 * sandboxed webview preload cannot require() arbitrary repo files). No external deps,
 * never triggers alert/confirm/prompt, never throws into the page.
 */

const { ipcRenderer } = require('electron');

/* ================================================================= *
 *  Inlined Phase-1 LOCATE (mirror of src/preview/locate.js). Isolated
 *  in its own scope so its helpers can't collide with the capture code.
 * ================================================================= */
var L = (function () {
  var OID_ATTR = 'data-cfleet-oid';
  var LOC_ATTR = 'data-cfleet-loc';
  var MAP_GLOBAL = '__CFLEET_OID_MAP__';

  function oidMap() {
    try { return (typeof window !== 'undefined' && window[MAP_GLOBAL]) || {}; } catch (e) { return {}; }
  }
  function parseLoc(str) {
    if (!str || typeof str !== 'string') return null;
    var m = str.match(/^(.*):(\d+):(\d+)$/);
    if (!m) return null;
    return { file: m[1], line: parseInt(m[2], 10), col: parseInt(m[3], 10) };
  }
  function getAttr(el, name) {
    if (!el) return null;
    if (typeof el.getAttribute === 'function') return el.getAttribute(name);
    return null;
  }
  function tagOf(el) { return el && el.tagName ? String(el.tagName).toLowerCase() : ''; }
  function parentOf(el) { return (el && (el.parentElement || el.parentNode)) || null; }
  function childrenOf(el) {
    if (!el) return [];
    if (el.children && el.children.length !== undefined) return Array.prototype.slice.call(el.children);
    return [];
  }
  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (ch) { return '\\' + ch; });
  }
  function isStableId(id) {
    if (!id || typeof id !== 'string') return false;
    if (/^[0-9]/.test(id)) return false;
    if (/^(react|radix|headlessui|mui|:r|ember|ext-gen)/i.test(id)) return false;
    if (/[:]/.test(id)) return false;
    return true;
  }
  function nthOfType(el) {
    var parent = parentOf(el);
    if (!parent) return 1;
    var tag = tagOf(el);
    var sibs = childrenOf(parent).filter(function (c) { return tagOf(c) === tag; });
    var i = sibs.indexOf(el);
    return i < 0 ? 1 : i + 1;
  }
  function cssSelector(el) {
    if (!el || !tagOf(el)) return '';
    var parts = [], cur = el, guard = 0;
    while (cur && tagOf(cur) && guard++ < 100) {
      var id = getAttr(cur, 'id');
      if (isStableId(id)) { parts.unshift('#' + cssEscape(id)); break; }
      var seg = tagOf(cur), same = 0, parent = parentOf(cur);
      if (parent) same = childrenOf(parent).filter(function (c) { return tagOf(c) === tagOf(cur); }).length;
      if (same > 1) seg += ':nth-of-type(' + nthOfType(cur) + ')';
      parts.unshift(seg);
      cur = parent;
    }
    return parts.join(' > ');
  }
  function xPath(el) {
    if (!el || !tagOf(el)) return '';
    var parts = [], cur = el, guard = 0;
    while (cur && tagOf(cur) && guard++ < 100) { parts.unshift(tagOf(cur) + '[' + nthOfType(cur) + ']'); cur = parentOf(cur); }
    return '/' + parts.join('/');
  }
  function classList(el) {
    if (!el) return [];
    if (el.classList && el.classList.length !== undefined) return Array.prototype.slice.call(el.classList);
    var cn = el.className;
    if (typeof cn === 'string') return cn.trim().split(/\s+/).filter(Boolean);
    if (cn && typeof cn.baseVal === 'string') return cn.baseVal.trim().split(/\s+/).filter(Boolean);
    return [];
  }
  function domPath(el) {
    var parts = [], cur = el, guard = 0;
    while (cur && tagOf(cur) && guard++ < 6) {
      var seg = tagOf(cur), cls = classList(cur)[0];
      if (cls) seg += '.' + cls;
      parts.unshift(seg);
      cur = parentOf(cur);
    }
    return parts.join('>');
  }
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
    if (tag === 'a' && getAttr(el, 'href') == null) return null;
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
  function accName(el) {
    var al = getAttr(el, 'aria-label');
    if (al) return al.trim();
    var lb = getAttr(el, 'aria-labelledby');
    if (lb && typeof document !== 'undefined' && document.getElementById) {
      var names = lb.split(/\s+/).map(function (id) { var r = document.getElementById(id); return r ? textOf(r) : ''; }).filter(Boolean);
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
  function tier0(el) {
    var host = el && el.closest ? el.closest('[' + OID_ATTR + ']') : null;
    if (!host) return null;
    var oid = getAttr(host, OID_ATTR);
    if (!oid) return null;
    var source = null, mapped = oidMap()[oid];
    if (mapped) source = { file: mapped.file, line: mapped.line, col: mapped.col, component: mapped.component || null };
    else { var loc = parseLoc(getAttr(host, LOC_ATTR)); if (loc) source = { file: loc.file, line: loc.line, col: loc.col, component: null }; }
    return { oid: oid, source: source, exact: host === el };
  }
  function reactFiber(el) {
    if (!el) return null;
    for (var k in el) { if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) return el[k]; }
    return null;
  }
  function componentNameFromFiber(fiber) {
    var f = fiber, guard = 0;
    while (f && guard++ < 200) {
      var ty = f.type;
      if (typeof ty === 'function') return ty.displayName || ty.name || null;
      if (ty && typeof ty === 'object' && (ty.displayName || ty.name)) return ty.displayName || ty.name;
      f = f._debugOwner || f.return || null;
    }
    return null;
  }
  function tier1(el) {
    var fiber = reactFiber(el), guard = 0;
    while (fiber && guard++ < 200) {
      var ds = fiber._debugSource;
      if (ds && ds.fileName) return { source: { file: ds.fileName, line: ds.lineNumber || 0, col: ds.columnNumber || 0, component: componentNameFromFiber(fiber) } };
      fiber = fiber.return || fiber._debugOwner || null;
    }
    return null;
  }
  function tier2(el) {
    return {
      domPath: domPath(el), selector: cssSelector(el), xpath: xPath(el), role: ariaRole(el), accName: accName(el),
      text: (function () { var t = textOf(el); return t.length > 200 ? t.slice(0, 197) + '…' : t; })(),
    };
  }
  function locate(el) {
    if (!el) return null;
    var t2 = tier2(el), t0 = tier0(el), t1 = !t0 ? tier1(el) : null;
    var oid = t0 ? t0.oid : null;
    var source = (t0 && t0.source) || (t1 && t1.source) || null;
    var tier = t0 ? 0 : (t1 ? 1 : 2);
    var anchor = t0 ? 'oid' : (t1 ? 'fiber' : 'selector');
    var staticHtml = !t0 && !t1;
    var reliable = !!t0 || staticHtml;
    var note;
    if (t0) note = 'Tier 0: build-time oid — node-exact source location.';
    else if (t1) note = 'Tier 1: React fiber _debugSource (best-effort; absent on React 19).';
    else note = 'Tier 2: selector maps directly to the source node (reliable write anchor for static HTML).';
    var locators = [];
    if (oid) locators.push({ type: 'oid', value: oid });
    if (source) locators.push({ type: 'source', value: source });
    locators.push({ type: 'selector', value: t2.selector, xpath: t2.xpath, role: t2.role, accName: t2.accName });
    return {
      oid: oid, source: source, domPath: t2.domPath, selector: t2.selector, xpath: t2.xpath,
      role: t2.role, accName: t2.accName, text: t2.text, tier: tier, anchor: anchor,
      reliable: reliable, staticHtml: staticHtml, note: note, locators: locators,
    };
  }

  var TW_UTILITY = /^(-?(?:sm|md|lg|xl|2xl|hover|focus|active|dark|group-hover|first|last|odd|even|disabled|motion-safe|motion-reduce|print|rtl|ltr):)*-?(bg|text|border|from|via|to|ring|shadow|fill|stroke|decoration|divide|placeholder|accent|caret|outline|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|w|h|min-w|min-h|max-w|max-h|gap|space|flex|grid|col|row|justify|items|content|self|order|rounded|font|leading|tracking|opacity|z|inset|top|bottom|left|right|translate|scale|rotate|skew|transition|duration|ease|delay|animate)(-[a-z0-9./[\]#%-]+)?$/;
  function looksTailwind(cls) { return TW_UTILITY.test(cls); }
  function describeStyle(el) {
    var classes = classList(el), tw = classes.filter(looksTailwind), hasInline = false;
    var inlineStyle = getAttr(el, 'style');
    if (inlineStyle && inlineStyle.trim()) hasInline = true;
    else if (el && el.style && typeof el.style === 'object' && el.style.cssText && el.style.cssText.trim()) hasInline = true;
    var system, hint;
    if (tw.length > 0) { system = 'tailwind'; hint = 'Route color/spacing edits to a Tailwind utility class; mutate className via AST + tailwind-merge.'; }
    else if (hasInline) { system = 'inline'; hint = 'Element carries an inline style attribute; patch the inline style prop directly.'; }
    else if (classes.length > 0) { system = 'css'; hint = 'Non-Tailwind class(es); a style edit maps to the matching external CSS rule (or add a class + rule).'; }
    else { system = 'unknown'; hint = 'No classes and no inline style; a style edit should ADD a class (+ rule) or an inline style.'; }
    return { system: system, classes: classes, tailwindClasses: tw, hasInlineStyle: hasInline, inlineStyle: inlineStyle || null, hint: hint };
  }

  function normalizeHex(input) {
    if (input == null) return null;
    var s = String(input).trim().toLowerCase(), m;
    if ((m = s.match(/^#([0-9a-f]{3})$/))) return '#' + m[1].split('').map(function (c) { return c + c; }).join('');
    if (s.match(/^#([0-9a-f]{6})$/)) return s;
    if (s.match(/^#([0-9a-f]{8})$/)) return s.slice(0, 7);
    if ((m = s.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/))) {
      return '#' + [m[1], m[2], m[3]].map(function (n) { var h = Math.max(0, Math.min(255, parseInt(n, 10))).toString(16); return h.length === 1 ? '0' + h : h; }).join('');
    }
    return null;
  }
  var DEFAULT_TW_COLORS = {
    '#000000': 'black', '#ffffff': 'white', '#ef4444': 'red-500', '#dc2626': 'red-600',
    '#f97316': 'orange-500', '#f59e0b': 'amber-500', '#eab308': 'yellow-500', '#22c55e': 'green-500',
    '#16a34a': 'green-600', '#10b981': 'emerald-500', '#14b8a6': 'teal-500', '#06b6d4': 'cyan-500',
    '#3b82f6': 'blue-500', '#2563eb': 'blue-600', '#6366f1': 'indigo-500', '#8b5cf6': 'violet-500',
    '#a855f7': 'purple-500', '#ec4899': 'pink-500', '#64748b': 'slate-500', '#6b7280': 'gray-500',
    '#71717a': 'zinc-500', '#111827': 'gray-900', '#1f2937': 'gray-800', '#f3f4f6': 'gray-100',
    '#0ea5e9': 'sky-500',
  };
  function flattenTwConfig(twConfig) {
    var out = {};
    if (!twConfig || typeof twConfig !== 'object') return out;
    var colors = (twConfig.theme && (twConfig.theme.extend && twConfig.theme.extend.colors || twConfig.theme.colors)) || twConfig.colors || twConfig;
    (function walk(obj, prefix) {
      if (!obj || typeof obj !== 'object') return;
      Object.keys(obj).forEach(function (k) {
        var v = obj[k], name = prefix ? prefix + '-' + k : k;
        if (typeof v === 'string') { var hex = normalizeHex(v); if (hex) out[hex] = (k === 'DEFAULT' && prefix) ? prefix : name; }
        else if (v && typeof v === 'object') walk(v, name);
      });
    })(colors, '');
    return out;
  }
  function tokenForColor(rgbOrHex, twConfig) {
    var rawValue = rgbOrHex == null ? null : String(rgbOrHex), hex = normalizeHex(rgbOrHex);
    if (!hex) return { tokenResolved: false, tokenName: null, rawValue: rawValue, hex: null };
    var projectMap = flattenTwConfig(twConfig);
    var name = projectMap[hex] || DEFAULT_TW_COLORS[hex] || null;
    return { tokenResolved: !!name, tokenName: name, rawValue: rawValue, hex: hex };
  }

  return { locate: locate, describeStyle: describeStyle, tokenForColor: tokenForColor, OID_ATTR: OID_ATTR };
})();

/* ================================================================= *
 *  Capture: MutationObserver (DOM edits) + CSSOM diff (rule edits).
 * ================================================================= */
(function () {
  var CAP = false;                 // capturing? (driven by host 'cfleet:capture')
  var mo = null;                   // the MutationObserver
  var pending = new Map();         // key -> record (coalesced non-structural edits)
  var flushT = null;
  var cssBaseline = null;          // [{ href, map:{ 'idx::selector': declText } }]

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }
  function tagOf(el) { return el && el.tagName ? String(el.tagName).toLowerCase() : ''; }
  function firstClass(el) {
    var cn = el && el.className;
    if (typeof cn === 'string' && cn.trim()) return cn.trim().split(/\s+/)[0];
    if (cn && typeof cn.baseVal === 'string' && cn.baseVal.trim()) return cn.baseVal.trim().split(/\s+/)[0];
    return '';
  }
  function nameOf(el, info) {
    var tag = tagOf(el), cls = firstClass(el);
    var base = '<' + (cls ? tag + '.' + cls : tag) + '>';
    if (info && info.source && info.source.component) return base + ' · ' + info.source.component;
    return base;
  }
  function parentDesc(node) {
    var p = node && node.parentElement;
    if (!p) return 'root';
    var i = L.locate(p);
    return (i && i.oid) ? i.oid : nameOf(p, i);
  }
  function norm(s) { return (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim(); }

  // nodes whose mutations we never care about (framework/head/self plumbing)
  function ignore(el) {
    if (!el || el.nodeType !== 1) return true;
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'script' || tag === 'link' || tag === 'meta' || tag === 'head' || tag === 'html' || tag === 'style' || tag === 'title') return true;
    try { if (el.closest && el.closest('head')) return true; } catch (_) {}
    return false;
  }

  // -------- outbound --------
  function send(rec) { try { ipcRenderer.sendToHost('cfleet:change', rec); } catch (_) {} }
  function scheduleFlush() { if (flushT) return; flushT = setTimeout(flush, 300); }
  function flush() {
    if (flushT) { clearTimeout(flushT); flushT = null; }
    if (!pending.size) return;
    var batch = pending; pending = new Map();
    batch.forEach(send);
  }
  function keyFor(target, kind, prop) {
    var t = target || {};
    return (t.oid || t.selector || t.domPath || '?') + '|' + kind + '|' + (prop || '');
  }
  // coalesce a non-structural edit: keep the FIRST-captured `before`, update `after`.
  function coalesce(rec) {
    var k = keyFor(rec.target, rec.kind, rec.prop);
    var ex = pending.get(k);
    if (ex) { ex.after = rec.after; ex.rawValue = rec.rawValue; ex.tokenName = rec.tokenName; ex.tokenResolved = rec.tokenResolved; }
    else pending.set(k, rec);
    scheduleFlush();
  }

  // -------- DOM mutation -> records --------
  function textRecord(host, oldValue) {
    if (ignore(host)) return null;
    var before = norm(oldValue), after = norm(host.textContent);
    if (before === after) return null;
    var info = L.locate(host);
    return { kind: 'text', prop: 'text', target: info, name: nameOf(host, info), before: before, after: after, confidence: 'high' };
  }
  function attrRecord(el, attr, oldValue) {
    if (ignore(el)) return null;
    var after = el.getAttribute(attr);
    if ((oldValue || '') === (after || '')) return null;
    var isStyleish = (attr === 'style' || attr === 'class');
    var info = L.locate(el);
    var rec = {
      kind: isStyleish ? 'style' : 'attr', prop: attr, target: info, name: nameOf(el, info),
      before: oldValue || '', after: after || '', confidence: 'high',
    };
    // best-effort token resolution when an inline color is set directly
    if (attr === 'style') {
      var m = String(after || '').match(/(?:^|;)\s*(?:background(?:-color)?|color)\s*:\s*([^;]+)/i);
      if (m) { var tok = L.tokenForColor(m[1].trim()); if (tok) { rec.rawValue = tok.rawValue; rec.tokenName = tok.tokenName; rec.tokenResolved = tok.tokenResolved; } }
    }
    return rec;
  }
  function structuralRec(kind, node, desc) {
    var info = L.locate(node);
    send({ kind: kind, prop: kind, target: info, name: nameOf(node, info), before: '', after: desc, confidence: 'low', structural: true });
  }

  function onMutations(list) {
    if (!CAP) return;
    var removed = [], added = [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m.type === 'characterData') {
        var host = m.target && m.target.parentElement;
        if (host) { var r = textRecord(host, m.oldValue); if (r) coalesce(r); }
      } else if (m.type === 'attributes') {
        var r2 = attrRecord(m.target, m.attributeName, m.oldValue);
        if (r2) coalesce(r2);
      } else if (m.type === 'childList') {
        for (var a = 0; a < m.removedNodes.length; a++) { var rn = m.removedNodes[a]; if (rn.nodeType === 1 && !ignore(rn)) removed.push(rn); }
        for (var b = 0; b < m.addedNodes.length; b++) { var an = m.addedNodes[b]; if (an.nodeType === 1 && !ignore(an)) added.push(an); }
      }
    }
    if (removed.length || added.length) processStructural(removed, added);
  }

  // Correlate childList add/remove within ONE observer batch (a moved node appears in both):
  //   removed & (also added OR still connected) => move ;  removed only & detached => delete ;
  //   added only => add.
  function processStructural(removed, added) {
    var addedSet = new Set(added), removedSet = new Set(removed), handled = new Set();
    removed.forEach(function (n) {
      if (addedSet.has(n) || n.isConnected) { handled.add(n); structuralRec('move', n, 'moved into ' + parentDesc(n)); }
      else structuralRec('delete', n, 'deleted element');
    });
    added.forEach(function (n) {
      if (handled.has(n) || removedSet.has(n)) return;   // the other half of a move
      structuralRec('add', n, 'added ' + tagOf(n));
    });
  }

  // -------- CSSOM stylesheet-rule diff (Styles-tab edits to matched rules) --------
  function shortHref(href) {
    if (!href) return '(inline)';
    try { var u = new URL(href, document.baseURI); return u.pathname + (u.search || ''); } catch (_) { return href; }
  }
  function snapshotCSS() {
    var out = [], sheets = document.styleSheets;
    for (var i = 0; i < sheets.length; i++) {
      var sh = sheets[i], rules;
      try { rules = sh.cssRules; } catch (_) { continue; }   // cross-origin — skip
      if (!rules) continue;
      var map = {};
      for (var j = 0; j < rules.length; j++) {
        var rule = rules[j];
        if (rule && rule.type === 1 && rule.selectorText) map[j + '::' + rule.selectorText] = rule.style ? rule.style.cssText : '';
      }
      out.push({ href: sh.href || ('inline#' + i), map: map });
    }
    return out;
  }
  function baselineCSS() { cssBaseline = snapshotCSS(); }
  function collectCSS() {
    var now = snapshotCSS();
    if (!cssBaseline) { cssBaseline = now; return; }
    now.forEach(function (cur) {
      var base = null;
      for (var k = 0; k < cssBaseline.length; k++) { if (cssBaseline[k].href === cur.href) { base = cssBaseline[k]; break; } }
      var baseMap = (base && base.map) || {};
      Object.keys(cur.map).forEach(function (key) {
        var after = cur.map[key], before = baseMap[key];
        if (before === undefined) emitCss(cur.href, key, '', after, 'add');
        else if (before !== after) emitCss(cur.href, key, before, after, 'style');
      });
      Object.keys(baseMap).forEach(function (key) { if (!(key in cur.map)) emitCss(cur.href, key, baseMap[key], '', 'delete'); });
    });
    cssBaseline = now;   // re-baseline so a second Save reports only NEW rule edits
  }
  function emitCss(href, key, before, after, sub) {
    var selector = key.split('::').slice(1).join('::');
    var target = { selector: selector, source: { file: shortHref(href), line: 0, col: 0, component: null }, cssRule: true };
    var kind = sub === 'style' ? 'style' : sub;   // 'style' | 'add' | 'delete'
    send({
      kind: kind, prop: 'css-rule', target: target, name: selector, before: before, after: after,
      confidence: sub === 'style' ? 'high' : 'low', cssRule: true, sourceURL: href,
    });
  }

  // -------- host -> overlay control --------
  function setCapture(on) {
    CAP = !!on;
    if (CAP) {
      if (!mo) mo = new MutationObserver(onMutations);
      try {
        mo.observe(document.documentElement || document, {
          subtree: true, childList: true, attributes: true, attributeOldValue: true,
          characterData: true, characterDataOldValue: true,
        });
      } catch (_) {}
      baselineCSS();
    } else {
      if (mo) { try { mo.disconnect(); } catch (_) {} }
      flush();
    }
  }
  ipcRenderer.on('cfleet:capture', function (_e, m) { try { setCapture(m && m.on); } catch (_) {} });
  ipcRenderer.on('cfleet:collect', function () { try { flush(); collectCSS(); } catch (_) {} });
  ipcRenderer.on('cfleet:reset', function () { try { pending.clear(); baselineCSS(); } catch (_) {} });

  ready(function () { try { ipcRenderer.sendToHost('cfleet:ready', {}); } catch (_) {} });
})();

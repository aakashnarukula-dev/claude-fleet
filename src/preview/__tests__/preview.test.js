'use strict';
/*
 * Dependency-free unit tests for the Visual Editor Phase 1b modules.
 * Run: node src/preview/__tests__/preview.test.js
 * No @babel/core, no jsdom — pure helpers + minimal fake DOM elements.
 */

var assert = require('assert');

var plugin = require('../oid-babel-plugin.js');
// locate.js reads process.env at construction? no — safe to require directly.
var L = require('../locate.js');

var pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ok - ' + name); }
  catch (e) { console.error('  FAIL - ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}

/* ============ oid-babel-plugin helpers ============ */
console.log('oid-babel-plugin:');

ok('hashId deterministic + base36', function () {
  assert.strictEqual(plugin.hashId('abc'), plugin.hashId('abc'));
  assert.notStrictEqual(plugin.hashId('abc'), plugin.hashId('abd'));
  assert.ok(/^[0-9a-z]+$/.test(plugin.hashId('src/App.jsx#Hero#0')));
});

ok('makeOid stable across line drift (file+component+index only)', function () {
  var a = plugin.makeOid({ file: 'src/App.jsx', component: 'Hero', index: 2 });
  var b = plugin.makeOid({ file: 'src/App.jsx', component: 'Hero', index: 2 });
  assert.strictEqual(a, b);
  assert.ok(a.indexOf('cf-') === 0);
  // different index => different oid
  assert.notStrictEqual(a, plugin.makeOid({ file: 'src/App.jsx', component: 'Hero', index: 3 }));
});

ok('isHostElementName: lowercase host yes, Component no, member no', function () {
  assert.strictEqual(plugin.isHostElementName('div'), true);
  assert.strictEqual(plugin.isHostElementName('a'), true);
  assert.strictEqual(plugin.isHostElementName('my-web-component'), true);
  assert.strictEqual(plugin.isHostElementName('Hero'), false);
  assert.strictEqual(plugin.isHostElementName('Foo.Bar'), false);
  assert.strictEqual(plugin.isHostElementName(''), false);
});

ok('instrumentEnabled guard', function () {
  assert.strictEqual(plugin.instrumentEnabled({}), false);
  assert.strictEqual(plugin.instrumentEnabled({ CFLEET_INSTRUMENT: '' }), false);
  assert.strictEqual(plugin.instrumentEnabled({ CFLEET_INSTRUMENT: '0' }), false);
  assert.strictEqual(plugin.instrumentEnabled({ CFLEET_INSTRUMENT: 'false' }), false);
  assert.strictEqual(plugin.instrumentEnabled({ CFLEET_INSTRUMENT: '1' }), true);
  assert.strictEqual(plugin.instrumentEnabled({ CFLEET_INSTRUMENT: 'on' }), true);
});

ok('plugin factory: no-op visitor when CFLEET_INSTRUMENT unset', function () {
  var saved = process.env.CFLEET_INSTRUMENT;
  delete process.env.CFLEET_INSTRUMENT;
  var p = plugin({ types: {} });
  assert.deepStrictEqual(p.visitor, {});
  if (saved !== undefined) process.env.CFLEET_INSTRUMENT = saved;
});

ok('plugin factory: armed visitor when CFLEET_INSTRUMENT set', function () {
  var saved = process.env.CFLEET_INSTRUMENT;
  process.env.CFLEET_INSTRUMENT = '1';
  var p = plugin({ types: {} });
  assert.ok(p.visitor.JSXOpeningElement, 'JSXOpeningElement visitor present');
  assert.ok(p.visitor.Program, 'Program visitor present');
  if (saved === undefined) delete process.env.CFLEET_INSTRUMENT; else process.env.CFLEET_INSTRUMENT = saved;
});

/* Full transform test IF @babel/core happens to be installed (real repos have it). */
ok('babel transform stamps host elements + builds map (skipped if no @babel/core)', function () {
  var babel;
  try { babel = require('@babel/core'); } catch (e) { console.log('    (skip: @babel/core not installed)'); return; }
  var saved = process.env.CFLEET_INSTRUMENT;
  process.env.CFLEET_INSTRUMENT = '1';
  var src = 'function Hero(){ return <section><a href="#">Go</a><Widget/></section>; }';
  var out = babel.transformSync(src, {
    filename: 'src/Hero.jsx',
    cwd: '/proj',
    plugins: [['@babel/plugin-syntax-jsx'], [plugin]],
  });
  assert.ok(/data-cfleet-oid="cf-/.test(out.code), 'oid stamped');
  assert.ok(/data-cfleet-loc="src\/Hero\.jsx:/.test(out.code), 'loc stamped');
  assert.ok(/__CFLEET_OID_MAP__/.test(out.code), 'map prelude injected');
  // <Widget/> is a component, must NOT be stamped:
  var widgetTagged = /Widget[^>]*data-cfleet-oid/.test(out.code);
  assert.strictEqual(widgetTagged, false, 'component element not stamped');
  if (saved === undefined) delete process.env.CFLEET_INSTRUMENT; else process.env.CFLEET_INSTRUMENT = saved;
});

/* ============ locate.js with fake DOM ============ */
console.log('locate:');

// Minimal fake element factory.
function makeEl(spec) {
  spec = spec || {};
  var attrs = spec.attrs || {};
  var el = {
    tagName: (spec.tag || 'div').toUpperCase(),
    id: attrs.id || '',
    className: spec.className || '',
    children: [],
    parentElement: null,
    textContent: spec.text || '',
    style: spec.style ? { cssText: spec.style } : {},
    _attrs: attrs,
    getAttribute: function (n) { return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null; },
    hasAttribute: function (n) { return Object.prototype.hasOwnProperty.call(this._attrs, n); },
    closest: function (sel) {
      // supports '[data-cfleet-oid]' only (what tier0 uses)
      var m = sel.match(/^\[([^\]]+)\]$/);
      var attr = m ? m[1] : null;
      var cur = this;
      while (cur) {
        if (attr && cur.hasAttribute(attr)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
  };
  if (spec.style) el._attrs.style = el._attrs.style || spec.style;
  (spec.children || []).forEach(function (c) { c.parentElement = el; el.children.push(c); });
  return el;
}

ok('Tier 0: element with data-cfleet-oid returns oid + source', function () {
  var saved = (typeof global !== 'undefined') ? global.__CFLEET_OID_MAP__ : undefined;
  // simulate window map
  global.window = global.window || {};
  global.window.__CFLEET_OID_MAP__ = { 'cf-abc': { file: 'src/Hero.jsx', line: 5, col: 3, component: 'Hero' } };
  var host = makeEl({ tag: 'section', attrs: { 'data-cfleet-oid': 'cf-abc', 'data-cfleet-loc': 'src/Hero.jsx:5:3' } });
  var child = makeEl({ tag: 'a', text: 'Go', attrs: { href: '#' } });
  child.parentElement = host; host.children.push(child);
  var target = L.locate(child);
  assert.strictEqual(target.tier, 0);
  assert.strictEqual(target.oid, 'cf-abc');
  assert.strictEqual(target.source.file, 'src/Hero.jsx');
  assert.strictEqual(target.source.component, 'Hero');
  assert.strictEqual(target.locators[0].type, 'oid');
  assert.strictEqual(target.reliable, true);
  delete global.window;
});

ok('Tier 0 falls back to data-cfleet-loc when map missing', function () {
  var host = makeEl({ tag: 'div', attrs: { 'data-cfleet-oid': 'cf-xyz', 'data-cfleet-loc': 'a/b.jsx:12:4' } });
  var t = L.locate(host);
  assert.strictEqual(t.oid, 'cf-xyz');
  assert.strictEqual(t.source.file, 'a/b.jsx');
  assert.strictEqual(t.source.line, 12);
});

ok('Tier 2: plain element gets stable unique selector + role + accName', function () {
  var main = makeEl({ tag: 'main' });
  var s1 = makeEl({ tag: 'section', className: 'hero' });
  var s2 = makeEl({ tag: 'section', className: 'feat' });
  var cta = makeEl({ tag: 'a', className: 'cta', text: 'Start free trial', attrs: { href: '/signup' } });
  s1.children.push(cta); cta.parentElement = s1;
  main.children.push(s1, s2); s1.parentElement = main; s2.parentElement = main;
  var t = L.locate(cta);
  assert.strictEqual(t.tier, 2);
  assert.strictEqual(t.role, 'link');
  assert.strictEqual(t.accName, 'Start free trial');
  assert.ok(t.selector.length > 0, 'has selector');
  assert.ok(t.xpath.indexOf('/main[1]') === 0, 'xpath absolute: ' + t.xpath);
  assert.strictEqual(t.staticHtml, true);
  assert.strictEqual(t.reliable, true);
  assert.strictEqual(t.locators[t.locators.length - 1].type, 'selector');
});

ok('Tier 2 selector uses nth-of-type to disambiguate same-tag siblings', function () {
  var ul = makeEl({ tag: 'ul' });
  var li1 = makeEl({ tag: 'li', text: 'one' });
  var li2 = makeEl({ tag: 'li', text: 'two' });
  ul.children.push(li1, li2); li1.parentElement = ul; li2.parentElement = ul;
  var t = L.locate(li2);
  assert.ok(/li:nth-of-type\(2\)/.test(t.selector), 'selector: ' + t.selector);
  assert.strictEqual(t.role, 'listitem');
});

ok('Tier 2 anchors on a stable id', function () {
  var wrap = makeEl({ tag: 'div', attrs: { id: 'pricing' } });
  var btn = makeEl({ tag: 'button', text: 'Buy' });
  wrap.children.push(btn); btn.parentElement = wrap;
  var t = L.locate(btn);
  assert.ok(t.selector.indexOf('#pricing') === 0, 'selector anchors id: ' + t.selector);
  assert.strictEqual(t.role, 'button');
});

ok('describeStyle distinguishes Tailwind vs inline vs css', function () {
  var tw = makeEl({ tag: 'a', className: 'bg-brand-green text-white px-4 rounded-lg' });
  var d1 = L.describeStyle(tw);
  assert.strictEqual(d1.system, 'tailwind');
  assert.ok(d1.tailwindClasses.indexOf('px-4') !== -1);

  var inl = makeEl({ tag: 'div', attrs: { style: 'color: #fff; padding: 4px' } });
  var d2 = L.describeStyle(inl);
  assert.strictEqual(d2.system, 'inline');
  assert.strictEqual(d2.hasInlineStyle, true);

  var css = makeEl({ tag: 'div', className: 'card promo' });
  var d3 = L.describeStyle(css);
  assert.strictEqual(d3.system, 'css');

  var none = makeEl({ tag: 'span' });
  assert.strictEqual(L.describeStyle(none).system, 'unknown');
});

ok('tokenForColor maps known hex to token, retains rawValue', function () {
  var r = L.tokenForColor('#16a34a');
  assert.strictEqual(r.tokenResolved, true);
  assert.strictEqual(r.tokenName, 'green-600');
  assert.strictEqual(r.rawValue, '#16a34a');

  var rgb = L.tokenForColor('rgb(22, 163, 74)');
  assert.strictEqual(rgb.tokenName, 'green-600');
  assert.strictEqual(rgb.hex, '#16a34a');

  var unknown = L.tokenForColor('#123457');
  assert.strictEqual(unknown.tokenResolved, false);
  assert.strictEqual(unknown.tokenName, null);
  assert.strictEqual(unknown.rawValue, '#123457');

  // project config wins
  var withCfg = L.tokenForColor('#16a34a', { theme: { extend: { colors: { brand: { green: '#16a34a' } } } } });
  assert.strictEqual(withCfg.tokenName, 'brand-green');
});

ok('normalizeHex handles #abc / rgb / rgba', function () {
  assert.strictEqual(L._normalizeHex('#fff'), '#ffffff');
  assert.strictEqual(L._normalizeHex('rgb(255,255,255)'), '#ffffff');
  assert.strictEqual(L._normalizeHex('rgba(0,0,0,0.5)'), '#000000');
  assert.strictEqual(L._normalizeHex('nonsense'), null);
});

console.log('\n' + pass + ' assertions passed' + (process.exitCode ? ' (with failures above)' : ''));

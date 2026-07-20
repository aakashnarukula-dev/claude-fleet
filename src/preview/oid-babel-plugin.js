'use strict';
/*
 * src/preview/oid-babel-plugin.js — Claude Fleet Visual Editor, Phase 1b.
 *
 * A DEV-ONLY Babel plugin for React/JSX. On each JSX *host* element (lowercase
 * tag = real DOM node) it stamps two attributes:
 *   - data-cfleet-oid="<opaque stable id>"   ← durable primary key (locate Tier 0)
 *   - data-cfleet-loc="<file>:<line>:<col>"  ← secondary, human/agent readable
 * and records a build-time map  oid -> {file,line,col,component}. The map is
 * injected per-file as a prelude that merges into window.__CFLEET_OID_MAP__, so
 * the runtime + the round-trip agent can resolve oid -> source with NO dev-server
 * changes.
 *
 * STABILITY: the oid is derived from file + enclosing component + an intra-file
 * counter (NOT the raw line number — line numbers drift when a file is edited).
 * The contract wants oid as the durable primary key; data-cfleet-loc carries the
 * (drift-prone) line/col only as a convenience chip.
 *
 * GUARD: opt-in + dev-only via process.env.CFLEET_INSTRUMENT (the dev-server
 * manager sets it while previewing). Unset  =>  the plugin is a NO-OP visitor,
 * so it can never affect a production build.
 *
 * @babel/core is NOT a dependency of this repo. Real React/Next/Vite repos bring
 * their own Babel; this file is written against the standard Babel plugin visitor
 * API (factory receives { types }). The pure helpers below (hashId / makeOid /
 * isHostElementName / instrumentEnabled) are exported so the transform logic is
 * unit-testable WITHOUT @babel/core installed.
 */

var OID_ATTR = 'data-cfleet-oid';
var LOC_ATTR = 'data-cfleet-loc';
var MAP_GLOBAL = '__CFLEET_OID_MAP__';

/* Deterministic, dependency-free short hash (FNV-1a → base36). Same input always
 * yields the same id, across processes and machines — required for a STABLE oid. */
function hashId(str) {
  var h = 0x811c9dc5; // FNV offset basis
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // FNV prime 16777619, kept in 32-bit unsigned range via Math.imul
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/* Build the opaque, stable oid for one host element.
 *   file      — the source file (relative preferred; kept verbatim in the hash)
 *   component — nearest enclosing component name ('' if unknown)
 *   index     — 0-based intra-file counter of stamped host elements
 * Prefix "cf-" makes the attribute value greppable and unambiguous. */
function makeOid(parts) {
  var file = (parts && parts.file) || '';
  var component = (parts && parts.component) || '';
  var index = (parts && typeof parts.index === 'number') ? parts.index : 0;
  return 'cf-' + hashId(file + '#' + component + '#' + index);
}

/* React host elements are lowercase JSX identifiers with no member/namespace part
 * (<div>, <a>, <my-web-component>). Uppercase (<Hero>) = a component, not a DOM
 * node; dotted (<Foo.Bar>) = member expression. Neither gets a DOM attribute. */
function isHostElementName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name.indexOf('.') !== -1 || name.indexOf(':') !== -1) return false;
  var c = name[0];
  return c === c.toLowerCase() && c !== c.toUpperCase() || /[a-z]/.test(c);
}

/* The dev-only guard. Truthy CFLEET_INSTRUMENT (except literal "0"/"false") arms
 * the plugin; anything else makes it a no-op. */
function instrumentEnabled(env) {
  var v = env && env.CFLEET_INSTRUMENT;
  if (v === undefined || v === null || v === '') return false;
  var s = String(v).toLowerCase();
  return s !== '0' && s !== 'false' && s !== 'off';
}

/* ------------------------------------------------------------------ *
 * The Babel plugin factory.                                          *
 * ------------------------------------------------------------------ */
function cfleetOidPlugin(babel) {
  var t = (babel && babel.types) || {};

  // Armed once, at plugin construction, from the ambient env.
  if (!instrumentEnabled(typeof process !== 'undefined' ? process.env : {})) {
    return { name: 'cfleet-oid', visitor: {} }; // production / not-previewing: no-op
  }

  return {
    name: 'cfleet-oid',
    visitor: {
      Program: {
        enter: function (path, state) {
          state.__cfleetIndex = 0;
          state.__cfleetMap = {}; // oid -> {file,line,col,component}
        },
        exit: function (path, state) {
          var map = state.__cfleetMap;
          if (!map || Object.keys(map).length === 0) return;
          // Merge this file's slice into window.__CFLEET_OID_MAP__ at module load.
          var json = JSON.stringify(map);
          var prelude = t.expressionStatement(
            t.logicalExpression(
              '&&',
              t.binaryExpression(
                '!==',
                t.unaryExpression('typeof', t.identifier('window'), true),
                t.stringLiteral('undefined')
              ),
              t.assignmentExpression(
                '=',
                t.memberExpression(t.identifier('window'), t.identifier(MAP_GLOBAL)),
                t.callExpression(
                  t.memberExpression(t.identifier('Object'), t.identifier('assign')),
                  [
                    t.logicalExpression(
                      '||',
                      t.memberExpression(t.identifier('window'), t.identifier(MAP_GLOBAL)),
                      t.objectExpression([])
                    ),
                    // JSON.parse('<map>') — compact + avoids re-AST-ing the literal
                    t.callExpression(
                      t.memberExpression(t.identifier('JSON'), t.identifier('parse')),
                      [t.stringLiteral(json)]
                    ),
                  ]
                )
              )
            )
          );
          path.node.body.unshift(prelude);
        },
      },

      JSXOpeningElement: function (path, state) {
        var node = path.node;
        // Only host elements (lowercase JSXIdentifier name).
        if (!t.isJSXIdentifier(node.name)) return;
        var tagName = node.name.name;
        if (!isHostElementName(tagName)) return;
        // Skip if already stamped (idempotent).
        if (hasAttr(t, node, OID_ATTR)) return;

        var file = (state.file && state.file.opts && state.file.opts.filename) || 'unknown';
        var rel = relativize(file, state.file && state.file.opts && state.file.opts.cwd);
        var loc = node.loc && node.loc.start ? node.loc.start : { line: 0, column: 0 };
        var component = enclosingComponentName(path) || '';
        var index = state.__cfleetIndex++;
        var oid = makeOid({ file: rel, component: component, index: index });
        var locStr = rel + ':' + loc.line + ':' + (loc.column + 1);

        node.attributes.push(jsxAttr(t, OID_ATTR, oid));
        node.attributes.push(jsxAttr(t, LOC_ATTR, locStr));

        state.__cfleetMap[oid] = {
          file: rel,
          line: loc.line,
          col: loc.column + 1,
          component: component,
        };
      },
    },
  };
}

/* --- small AST helpers (kept internal; rely on injected `t`) --- */
function jsxAttr(t, name, value) {
  return t.jsxAttribute(t.jsxIdentifier(name), t.stringLiteral(value));
}
function hasAttr(t, openingNode, name) {
  return openingNode.attributes.some(function (a) {
    return t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === name;
  });
}
function relativize(file, cwd) {
  if (!cwd || typeof file !== 'string') return file;
  var norm = file.replace(/\\/g, '/');
  var base = cwd.replace(/\\/g, '/').replace(/\/$/, '') + '/';
  return norm.indexOf(base) === 0 ? norm.slice(base.length) : norm;
}
/* Nearest enclosing named function/class = the component. Best-effort. */
function enclosingComponentName(path) {
  var p = path;
  while (p) {
    var n = p.node;
    if (!n) { p = p.parentPath; continue; }
    if ((n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') && n.id) {
      return n.id.name;
    }
    if ((n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression')) {
      var parent = p.parentPath && p.parentPath.node;
      if (parent) {
        if (parent.type === 'VariableDeclarator' && parent.id && parent.id.name) return parent.id.name;
        if (parent.type === 'AssignmentExpression' && parent.left && parent.left.name) return parent.left.name;
        if ((parent.type === 'CallExpression') && p.parentPath.parentPath) {
          var gp = p.parentPath.parentPath.node; // e.g. const X = memo(() => …)
          if (gp && gp.type === 'VariableDeclarator' && gp.id && gp.id.name) return gp.id.name;
        }
      }
    }
    p = p.parentPath;
  }
  return '';
}

module.exports = cfleetOidPlugin;
module.exports.default = cfleetOidPlugin;
// pure helpers exported for unit tests (no @babel/core needed)
module.exports.hashId = hashId;
module.exports.makeOid = makeOid;
module.exports.isHostElementName = isHostElementName;
module.exports.instrumentEnabled = instrumentEnabled;
module.exports.OID_ATTR = OID_ATTR;
module.exports.LOC_ATTR = LOC_ATTR;
module.exports.MAP_GLOBAL = MAP_GLOBAL;

/* Fusión de documentos personales. Las lápidas se conservan para dispositivos sin conexión. */
(function (root) {
  'use strict';
  var lists = ['moves', 'goals', 'debts', 'quicks', 'wallets', 'owed', 'xfers', 'recur'];
  function copy(x) { return JSON.parse(JSON.stringify(x)); }
  // JSONB puede devolver las claves en otro orden: eso no es una edición.
  function stable(x) {
    if (!x || typeof x !== 'object') return JSON.stringify(x);
    if (Array.isArray(x)) return '[' + x.map(stable).join(',') + ']';
    return '{' + Object.keys(x).sort().map(function (k) { return JSON.stringify(k) + ':' + stable(x[k]); }).join(',') + '}';
  }
  function same(a, b) { return stable(a) === stable(b); }
  function clean(x) { var y = copy(x); delete y.u; return y; }
  function stamp(at, by, seq, deleted) { return { at: at, by: by || '', seq: seq || 0, deleted: !!deleted }; }
  function cmp(a, b) { return a.at - b.at || (a.by < b.by ? -1 : a.by > b.by ? 1 : 0) || a.seq - b.seq; }
  function fields(d, prefix, out) {
    Object.keys(d).sort().forEach(function (k) {
      if (!prefix.length && (lists.indexOf(k) >= 0 || k === '_sync')) return;
      var p = prefix.concat(k), v = d[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) fields(v, p, out);
      else out[JSON.stringify(p)] = v;
    });
    return out;
  }
  function normalize(data, at) {
    var d = copy(data), m = d._sync || { version: 1, items: {}, fields: {} };
    if (m.version !== 1) throw new Error('Versión de sincronización desconocida');
    m.items = m.items || {}; m.fields = m.fields || {};
    lists.forEach(function (name) {
      var ix = m.items[name] = m.items[name] || {};
      (d[name] || []).forEach(function (x) {
        if (!x.id || ['__proto__', 'prototype', 'constructor'].indexOf(x.id) >= 0) throw new Error('Identificador inválido');
        if (!ix[x.id]) ix[x.id] = stamp(Date.parse(x.u || at || '') || 0);
      });
    });
    var ff = fields(d, [], {});
    Object.keys(ff).forEach(function (k) { if (!m.fields[k]) m.fields[k] = stamp(Date.parse(at || '') || 0); });
    d._sync = m; return d;
  }
  function latest(m) {
    var n = 0;
    Object.keys(m.fields).forEach(function (k) { n = Math.max(n, m.fields[k].at); });
    lists.forEach(function (l) { Object.keys(m.items[l]).forEach(function (k) { n = Math.max(n, m.items[l][k].at); }); });
    return n;
  }
  function track(before, current, at, by, seq) {
    var prev = normalize(before, at), d = normalize(current, at), m = copy(prev._sync);
    var now = Math.max(Date.now(), latest(m) + 1);
    lists.forEach(function (name) {
      var old = new Map((prev[name] || []).map(function (x) { return [x.id, x]; }));
      var cur = new Map((d[name] || []).map(function (x) { return [x.id, x]; }));
      cur.forEach(function (x, id) {
        if (!old.has(id) || !same(clean(x), clean(old.get(id)))) {
          m.items[name][id] = stamp(now, by, seq); x.u = new Date(now).toISOString();
        }
      });
      old.forEach(function (_, id) { if (!cur.has(id)) m.items[name][id] = stamp(now, by, seq, true); });
    });
    var pf = fields(prev, [], {}), cf = fields(d, [], {});
    new Set(Object.keys(pf).concat(Object.keys(cf))).forEach(function (k) {
      if (!same(pf[k], cf[k])) m.fields[k] = stamp(now, by, seq, !Object.prototype.hasOwnProperty.call(cf, k));
    });
    d._sync = m; return d;
  }
  function put(d, path, value) {
    var o = d;
    path.slice(0, -1).forEach(function (k) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') throw new Error('Campo inválido');
      if (!o[k] || typeof o[k] !== 'object') o[k] = {}; o = o[k];
    });
    var k = path[path.length - 1];
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') throw new Error('Campo inválido');
    o[k] = copy(value);
  }
  function unversioned() { var e = new Error('Cambios sin historial de edición compatible'); e.code = 'UNVERSIONED'; throw e; }
  function merge(local, remote, localAt, remoteAt) {
    var a = normalize(local, localAt), b = normalize(remote, remoteAt);
    var out = {}, meta = { version: 1, items: {}, fields: {} }, conflicts = 0;
    lists.forEach(function (name) {
      var am = a._sync.items[name], bm = b._sync.items[name], om = meta.items[name] = {};
      var ai = new Map((a[name] || []).map(function (x) { return [x.id, x]; }));
      var bi = new Map((b[name] || []).map(function (x) { return [x.id, x]; }));
      var result = [];
      Array.from(new Set(Object.keys(am).concat(Object.keys(bm)))).sort().forEach(function (id) {
        var x = am[id], y = bm[id], useA = !y || (x && cmp(x, y) >= 0), win = useA ? x : y;
        if ((x && !x.deleted && !ai.has(id)) || (y && !y.deleted && !bi.has(id))) unversioned();
        if (x && y && !cmp(x, y) && !x.deleted && !same(clean(ai.get(id)), clean(bi.get(id)))) unversioned();
        if (x && y && cmp(x, y) && (x.by && y.by) && !same(ai.get(id), bi.get(id))) conflicts++;
        om[id] = copy(win);
        var item = (useA ? ai : bi).get(id);
        if (!win.deleted && item) result.push(copy(item));
      });
      if (a[name] || b[name] || result.length) out[name] = result;
    });
    var af = fields(a, [], {}), bf = fields(b, [], {});
    Array.from(new Set(Object.keys(a._sync.fields).concat(Object.keys(b._sync.fields)))).sort(function (x, y) { return JSON.parse(x).length - JSON.parse(y).length || x.localeCompare(y); }).forEach(function (key) {
      var x = a._sync.fields[key], y = b._sync.fields[key], useA = !y || (x && cmp(x, y) >= 0), win = useA ? x : y;
      if (x && y && !cmp(x, y) && !x.deleted && !same(af[key], bf[key])) unversioned();
      meta.fields[key] = copy(win);
      if (!win.deleted) put(out, JSON.parse(key), (useA ? af : bf)[key]);
    });
    out._sync = meta; return { data: out, conflicts: conflicts };
  }
  var api = { normalize: normalize, track: track, merge: merge, copy: copy };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PCSyncModel = api;
})(typeof window !== 'undefined' ? window : globalThis);

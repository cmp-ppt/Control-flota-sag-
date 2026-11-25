/* DEMO: ejecuta el servidor real de la app dentro del navegador.
   Intercepta fetch('/api/...') y responde con las mismas rutas de server/index.js. Datos en IndexedDB (solo este dispositivo). */
(function () {
  'use strict';
  var process = { env: {} };
  var __dirname = '/';
  var Buffer = { from: function (x) { return x; } };
  var defs = {}, cache = {};
  function def(name, fn) { defs[name] = fn; }
  function hex(n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }

  // ---------- express en miniatura ----------
  function express() {
    var routes = [], mws = [];
    var app = {
      set: function () {},
      use: function (a) { if (typeof a === 'function' && a.length < 4) mws.push(a); },
      listen: function () {},
    };
    ['get', 'post'].forEach(function (m) {
      app[m] = function (p) {
        var h = Array.prototype.slice.call(arguments, 1);
        var names = [];
        var re = new RegExp('^' + p.replace(/\./g, '\\.').replace(/:(\w+)/g, function (_, n) { names.push(n); return '([^/]+)'; }) + '$');
        routes.push({ m: m.toUpperCase(), re: re, names: names, h: h });
      };
    });
    app._handle = async function (method, pathname, req, res) {
      var r = routes.find(function (x) { return x.m === method && x.re.test(pathname); });
      if (!r) return res.status(404).json({ error: 'No encontrado' });
      var m = r.re.exec(pathname);
      req.params = {}; r.names.forEach(function (n, i) { req.params[n] = decodeURIComponent(m[i + 1]); });
      var chain = mws.concat(r.h), i = 0;
      var next = async function () { var fn = chain[i++]; if (fn) await fn(req, res, next); };
      try { await next(); } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno' }); }
    };
    return app;
  }
  express.json = function () { return function (q, s, n) { n(); }; };
  express.static = function () { return function (q, s, n) { n(); }; };

  // ---------- almacenamiento en IndexedDB ----------
  var DB = null, idb = null;
  function idbOpen() {
    return new Promise(function (ok, fail) {
      var r = indexedDB.open('flota-demo', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onsuccess = function () { ok(r.result); };
      r.onerror = function () { fail(r.error); };
    });
  }
  function persist() {
    if (!idb) return;
    try { var t = idb.transaction('kv', 'readwrite'); t.objectStore('kv').put(JSON.stringify(DB), 'db'); } catch (e) { /* sin espacio */ }
  }
  var store = {
    UPLOADS: '/uploads', DATA_DIR: '/data',
    load: function () { return DB; },
    save: persist,
    reset: function (n) { DB = n; persist(); },
    saveImage: function (d) { return d; }, // en la demo las imágenes quedan como data URL
  };

  var stubs = {
    express: express,
    path: { join: function () { return Array.prototype.join.call(arguments, '/'); }, basename: function (p) { return String(p).split('/').pop(); } },
    crypto: {
      randomBytes: function (n) { var h = hex(n); return { toString: function () { return h; } }; },
      scryptSync: function () { return { toString: function () { return 'x'; } }; },
      timingSafeEqual: function () { return true; },
    },
    qrcode: {
      toString: function (text) {
        var q = window.qrcode(0, 'M'); q.addData(text); q.make();
        return Promise.resolve(q.createSvgTag({ scalable: true, margin: 2 }));
      },
    },
    exceljs: window.ExcelJS,
    './store': store,
  };

  function req(name) {
    if (name in stubs) return stubs[name];
    if (cache[name]) return cache[name].exports;
    if (!defs[name]) throw new Error('Módulo no disponible en la demo: ' + name);
    var module = { exports: {} };
    cache[name] = module;
    var r = function (n) { return req(n); };
    defs[name](module, module.exports, r); // `require.main` queda indefinido: no se ejecuta el arranque del servidor
    return module.exports;
  }

  /*__MODULES__*/

  // En la demo cualquier PIN es válido y no se calculan hashes.
  var seedReal = req('./seed.real');
  stubs['./seed'] = {
    build: seedReal.build,
    hashPin: function () { return 'demo'; },
    checkPin: function () { return true; },
  };

  var app = null;
  var ready = (async function () {
    try { idb = await idbOpen(); } catch (e) { idb = null; }
    var saved = null;
    if (idb) {
      saved = await new Promise(function (ok) {
        var g = idb.transaction('kv').objectStore('kv').get('db');
        g.onsuccess = function () { ok(g.result); }; g.onerror = function () { ok(null); };
      });
    }
    DB = saved ? JSON.parse(saved) : seedReal.build();
    if (!saved) persist();
    app = req('./index');
  })();

  // ---------- intercepta fetch('/api/...') ----------
  var realFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    init = init || {};
    var url = new URL(typeof input === 'string' ? input : input.url, location.href);
    var i = url.pathname.indexOf('/api/');
    if (url.origin !== location.origin || i < 0) return realFetch(input, init);
    await ready;
    var headers = {};
    Object.keys(init.headers || {}).forEach(function (k) { headers[k.toLowerCase()] = init.headers[k]; });
    var status = 200, rh = {}, done, p = new Promise(function (r) { done = r; });
    var res = {
      status: function (c) { status = c; return res; },
      type: function (t) { rh['Content-Type'] = t; return res; },
      setHeader: function (k, v) { rh[k] = v; },
      json: function (o) { rh['Content-Type'] = 'application/json'; done(new Response(JSON.stringify(o), { status: status, headers: rh })); },
      send: function (x) { done(new Response(x, { status: status, headers: rh })); },
      end: function () { done(new Response(null, { status: status, headers: rh })); },
    };
    var q = {}; url.searchParams.forEach(function (v, k) { q[k] = v; });
    var rq = { headers: headers, query: q, body: init.body ? JSON.parse(init.body) : undefined };
    app._handle(init.method || 'GET', url.pathname.slice(i), rq, res);
    return p;
  };

  // ---------- aviso de demo ----------
  window.addEventListener('DOMContentLoaded', function () {
    var b = document.createElement('div');
    b.style.cssText = 'background:#fff3cd;color:#5c4400;font:13px/1.4 system-ui,sans-serif;padding:8px 12px;text-align:center;border-bottom:1px solid #e8c766';
    b.innerHTML = '<b>DEMO</b> · los datos quedan solo en este navegador (no se comparten). Usuarios: <code>cond1@ejemplo.cl</code> (conductor) · <code>sup.norte@ejemplo.cl</code> · <code>admin@ejemplo.cl</code> — PIN: cualquiera. ' +
      '<a href="#" id="demo-reset">Reiniciar demo</a> · <a href="' + (location.pathname.indexOf('/admin') >= 0 ? '../' : 'admin/') + '">' + (location.pathname.indexOf('/admin') >= 0 ? 'ir a la app del conductor' : 'ir al panel') + '</a>';
    document.body.insertBefore(b, document.body.firstChild);
    document.getElementById('demo-reset').onclick = function (e) {
      e.preventDefault();
      if (!confirm('¿Borrar todos los datos de la demo en este navegador?')) return;
      try { localStorage.clear(); } catch (x) { /* */ }
      indexedDB.deleteDatabase('flota-demo'); indexedDB.deleteDatabase('flota');
      setTimeout(function () { location.reload(); }, 300);
    };
  });
})();

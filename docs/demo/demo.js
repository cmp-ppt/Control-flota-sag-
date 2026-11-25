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

  def("./logic", function (module, exports, require) {
// Reglas de negocio: estado de vehículos, vencimientos, alertas y bitácora.
const HOUR = 3600000;
const DAY = 86400000;

const byId = (arr, id) => arr.find((x) => x.id === id);

function viajeAbierto(db, idVehiculo) {
  return db.viajes
    .filter((v) => v.id_vehiculo === idVehiculo && v.estado_viaje === 'ABIERTO')
    .sort((a, b) => (b.hora_salida || '').localeCompare(a.hora_salida || ''))[0] || null;
}

function umbralHoras(db, veh) {
  const area = byId(db.areas, veh.id_area);
  return veh.horas_max_en_uso || (area && area.horas_max_en_uso) || db.config.horas_en_uso;
}

function estadoVehiculo(db, veh, now = new Date()) {
  if (veh.estado_manual === 'MANTENCION') return { estado: 'MANTENCION', viaje: null, horas: 0 };
  const viaje = viajeAbierto(db, veh.id);
  if (!viaje) return { estado: 'DISPONIBLE', viaje: null, horas: 0 };
  const horas = (now - new Date(viaje.hora_salida)) / HOUR;
  return { estado: horas > umbralHoras(db, veh) ? 'ATRASADO' : 'EN_USO', viaje, horas };
}

function ultimosDocumentos(db, idVehiculo) {
  const por = {};
  for (const d of db.documentos.filter((x) => x.id_vehiculo === idVehiculo)) {
    if (!por[d.tipo] || d.fecha_vencimiento > por[d.tipo].fecha_vencimiento) por[d.tipo] = d;
  }
  return Object.values(por);
}

function diasPara(fechaISO, now = new Date()) {
  const hoy = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const [y, m, d] = fechaISO.split('-').map(Number);
  return Math.round((new Date(y, m - 1, d) - hoy) / DAY);
}

function estadoDocumento(doc, now) {
  const dias = diasPara(doc.fecha_vencimiento, now);
  return { dias, estado: dias < 0 ? 'VENCIDO' : dias <= 30 ? 'POR_VENCER' : 'VIGENTE' };
}

function contactosArea(db, idArea) {
  return db.contactos
    .filter((c) => c.id_area === idArea && c.activo)
    .sort((a, b) => a.orden - b.orden)
    .map((c) => {
      const p = byId(db.personas, c.id_persona);
      return { ...c, nombre: p ? p.nombre_completo : '' };
    });
}

function areasDe(db, persona) {
  if (persona.rol === 'ADMIN') return db.areas.map((a) => a.id);
  return [persona.id_area];
}

// ---- Alertas -------------------------------------------------------------
function computeAlertas(db, now = new Date()) {
  const out = [];
  const cfg = db.config;
  const push = (a) => {
    const st = db.alertas_estado[a.key] || {};
    out.push({ ...a, estado: st.estado || 'ABIERTA', comentario: st.comentario || '', atendida_por: st.por || null });
  };

  for (const veh of db.vehiculos.filter((v) => v.activo)) {
    const e = estadoVehiculo(db, veh, now);
    if (e.estado === 'ATRASADO') {
      const crit = e.horas > cfg.horas_en_uso_critica;
      const cond = byId(db.personas, e.viaje.id_conductor);
      push({
        key: `ATRASO:${e.viaje.id}`, tipo: 'VEHICULO_ATRASADO', severidad: crit ? 'CRITICA' : 'AVISO',
        id_vehiculo: veh.id, id_area: veh.id_area, creada_en: e.viaje.hora_salida,
        mensaje: `${veh.patente} lleva ${e.horas.toFixed(1)} h en uso sin registrar llegada` +
          (cond ? ` (conductor: ${cond.nombre_completo})` : ''),
        id_conductor: e.viaje.id_conductor,
      });
    }
    for (const d of ultimosDocumentos(db, veh.id)) {
      const { dias, estado } = estadoDocumento(d, now);
      const max = Math.max(...cfg.doc_dias_antes);
      if (dias <= max) {
        const sev = dias <= 7 ? 'CRITICA' : dias <= 15 ? 'AVISO' : 'INFO';
        push({
          key: `DOC:${d.id}`, tipo: 'DOCUMENTO', severidad: sev, id_vehiculo: veh.id, id_area: veh.id_area,
          creada_en: now.toISOString(),
          mensaje: estado === 'VENCIDO'
            ? `${veh.patente}: ${d.tipo.replace('_', ' ')} VENCIDO hace ${-dias} día(s)`
            : `${veh.patente}: ${d.tipo.replace('_', ' ')} vence en ${dias} día(s) (${d.fecha_vencimiento})`,
        });
      }
    }
  }

  for (const c of db.cargas) {
    const veh = byId(db.vehiculos, c.id_vehiculo);
    if (!veh) continue;
    const edad = (now - new Date(c.fecha_hora)) / DAY;
    if (!['3/4', 'Lleno'].includes(c.nivel_estanque_llegada) && edad < 3) {
      push({
        key: `ESTANQUE:${c.id}`, tipo: 'ESTANQUE_BAJO', severidad: 'AVISO', id_vehiculo: veh.id, id_area: veh.id_area,
        creada_en: c.fecha_hora, mensaje: `${veh.patente}: estanque en ${c.nivel_estanque_llegada} (mínimo 3/4)`,
      });
    }
    if (!c.boleta_fisica_recibida && edad > cfg.boleta_pendiente_dias) {
      push({
        key: `BOLETA:${c.id}`, tipo: 'BOLETA_PENDIENTE', severidad: 'AVISO', id_vehiculo: veh.id, id_area: veh.id_area,
        creada_en: c.fecha_hora, mensaje: `${veh.patente}: boleta N° ${c.numero_boleta} sin entregar hace ${Math.floor(edad)} días`,
      });
    }
  }

  for (const p of db.personas.filter((x) => x.rol === 'CONDUCTOR' && x.licencia_vencimiento && x.activo)) {
    const dias = diasPara(p.licencia_vencimiento, now);
    if (dias <= cfg.licencia_dias_antes) {
      push({
        key: `LIC:${p.id}:${p.licencia_vencimiento}`, tipo: 'LICENCIA', severidad: dias <= 7 ? 'CRITICA' : 'AVISO',
        id_vehiculo: null, id_area: p.id_area, creada_en: now.toISOString(),
        mensaje: `${p.nombre_completo}: licencia ${dias < 0 ? 'VENCIDA' : `vence en ${dias} día(s)`}`,
      });
    }
  }

  const rank = { CRITICA: 0, AVISO: 1, INFO: 2 };
  out.sort((a, b) => rank[a.severidad] - rank[b.severidad] || (a.creada_en < b.creada_en ? 1 : -1));
  return out;
}

// ---- Bitácora mensual -----------------------------------------------------
const hhmm = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function bitacora(db, { mes, id_vehiculo, id_area }) {
  const viajes = db.viajes.filter((v) =>
    v.fecha && v.fecha.startsWith(mes) && v.estado_viaje !== 'ANULADO' &&
    (!id_vehiculo || v.id_vehiculo === id_vehiculo) &&
    (!id_area || (byId(db.vehiculos, v.id_vehiculo) || {}).id_area === id_area));
  const cargas = db.cargas.filter((c) => (c.fecha_hora || '').length && cargaFecha(c).startsWith(mes) &&
    (!id_vehiculo || c.id_vehiculo === id_vehiculo) &&
    (!id_area || (byId(db.vehiculos, c.id_vehiculo) || {}).id_area === id_area));

  const porViaje = {};
  const sueltas = [];
  for (const c of cargas) {
    let target = c.id_viaje && viajes.find((v) => v.id === c.id_viaje);
    if (!target) {
      const fecha = cargaFecha(c);
      const delDia = viajes.filter((v) => v.id_vehiculo === c.id_vehiculo && v.fecha === fecha)
        .sort((a, b) => (a.hora_salida || '').localeCompare(b.hora_salida || ''));
      target = [...delDia].reverse().find((v) => v.hora_salida <= c.fecha_hora) || delDia[0];
    }
    if (target) (porViaje[target.id] = porViaje[target.id] || []).push(c);
    else sueltas.push(c);
  }

  const rows = [];
  const base = (v) => {
    const veh = byId(db.vehiculos, v.id_vehiculo) || {};
    const prog = byId(db.programas, veh.id_programa) || {};
    const cond = byId(db.personas, v.id_conductor) || {};
    const dest = byId(db.destinos, v.id_destino);
    return { veh, prog, cond, dest };
  };
  for (const v of viajes) {
    const { veh, prog, cond, dest } = base(v);
    const cs = porViaje[v.id] || [];
    rows.push({
      fecha: v.fecha, patente: veh.patente || '', conductor: cond.nombre_completo || '', programa: prog.nombre || '',
      rol: v.rol_conductor || '', origen: v.origen || '', destino: (dest && dest.nombre) || v.destino_texto_nuevo || '',
      km_inicial: v.km_inicial, km_final: v.km_final ?? '', hora_salida: hhmm(v.hora_salida), hora_llegada: hhmm(v.hora_llegada),
      pasajeros: v.pasajeros, litros: cs.reduce((s, c) => s + (+c.litros || 0), 0) || '',
      valor: cs.reduce((s, c) => s + (+c.monto || 0), 0) || '', boleta: cs.map((c) => c.numero_boleta).join(' / '),
      firma: v.firma_llegada || v.firma_salida || '',
      observaciones: [v.observaciones, v.origen_registro === 'PAPEL' ? '[Transcrito de papel]' : '',
        v.estado_viaje === 'ABIERTO' ? '[Sin llegada registrada]' : ''].filter(Boolean).join(' '),
      origen_registro: v.origen_registro, foto_respaldo_papel: v.foto_respaldo_papel || '',
      _sort: `${v.fecha} ${v.hora_salida || ''}`,
    });
  }
  for (const c of sueltas) {
    const veh = byId(db.vehiculos, c.id_vehiculo) || {};
    const prog = byId(db.programas, veh.id_programa) || {};
    const cond = byId(db.personas, c.id_conductor) || {};
    rows.push({
      fecha: cargaFecha(c), patente: veh.patente || '', conductor: cond.nombre_completo || '', programa: prog.nombre || '',
      rol: '', origen: '', destino: '', km_inicial: '', km_final: '', hora_salida: '', hora_llegada: '', pasajeros: '',
      litros: c.litros, valor: c.monto, boleta: c.numero_boleta, firma: '', observaciones: 'Solo carga de combustible',
      origen_registro: 'APP', foto_respaldo_papel: '', _sort: `${cargaFecha(c)} ${c.fecha_hora}`,
    });
  }
  rows.sort((a, b) => (a.patente + a._sort).localeCompare(b.patente + b._sort));
  return rows;
}

function cargaFecha(c) {
  const d = new Date(c.fecha_hora);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = {
  byId, viajeAbierto, estadoVehiculo, umbralHoras, ultimosDocumentos, estadoDocumento, diasPara,
  contactosArea, areasDe, computeAlertas, bitacora, hhmm,
};

});
def("./seed.real", function (module, exports, require) {
// Datos de ejemplo (ficticios). Reemplazar por los reales desde el panel o editando data/db.json.
const crypto = require('crypto');

function hashPin(pin) {
  const salt = crypto.randomBytes(8).toString('hex');
  const h = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return `${salt}:${h}`;
}
function checkPin(pin, stored) {
  if (!stored) return false;
  const [salt, h] = stored.split(':');
  const x = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(x, 'hex'));
}

function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function build() {
  const pin = hashPin('1234'); // PIN inicial de TODOS los usuarios de ejemplo: cámbielo
  const areas = [
    { id: 'AR01', nombre: 'Área Norte', horas_max_en_uso: 8, activa: true },
    { id: 'AR02', nombre: 'Área Sur', horas_max_en_uso: 10, activa: true },
    { id: 'AR03', nombre: 'Área Centro', horas_max_en_uso: 8, activa: true },
  ];
  const programas = [
    { id: 'PG01', nombre: 'Programa Fiscalización', id_area: 'AR01' },
    { id: 'PG02', nombre: 'Programa Terreno', id_area: 'AR02' },
    { id: 'PG03', nombre: 'Programa Apoyo', id_area: 'AR03' },
  ];
  const mk = (id, pat, marca, modelo, area, prog, km) => ({
    id, patente: pat, marca, modelo, anio: 2022, id_area: area, id_programa: prog,
    codigo_qr: `VEH-${pat}`, km_actual: km, estado_manual: null, horas_max_en_uso: null,
    tipo_combustible: 'Diésel', activo: true,
  });
  const vehiculos = [
    mk('V001', 'ABCD12', 'Toyota', 'Hilux', 'AR01', 'PG01', 45210),
    mk('V002', 'EFGH34', 'Nissan', 'NP300', 'AR01', 'PG01', 78030),
    mk('V003', 'IJKL56', 'Mitsubishi', 'L200', 'AR02', 'PG02', 61500),
    mk('V004', 'MNOP78', 'Chevrolet', 'D-Max', 'AR02', 'PG02', 33900),
    mk('V005', 'QRST90', 'Ford', 'Ranger', 'AR03', 'PG03', 90120),
    mk('V006', 'UVWX11', 'Toyota', 'Hilux', 'AR03', 'PG03', 12040),
  ];
  const p = (id, nombre, rut, tel, email, rol, area) => ({
    id, nombre_completo: nombre, rut, telefono: tel, email, rol, id_area: area,
    pin_hash: pin, licencia_clase: rol === 'CONDUCTOR' ? 'B' : '', licencia_vencimiento: '', activo: true,
  });
  const personas = [
    p('P000', 'Administrador Flota', '10.000.000-0', '+56900000000', 'admin@ejemplo.cl', 'ADMIN', 'AR01'),
    p('P001', 'Supervisor Norte', '11.111.111-1', '+56911111111', 'sup.norte@ejemplo.cl', 'SUPERVISOR', 'AR01'),
    p('P002', 'Supervisor Sur', '12.222.222-2', '+56922222222', 'sup.sur@ejemplo.cl', 'SUPERVISOR', 'AR02'),
    p('P003', 'Supervisor Centro', '13.333.333-3', '+56933333333', 'sup.centro@ejemplo.cl', 'SUPERVISOR', 'AR03'),
    p('P010', 'Conductor Norte 1', '14.444.444-4', '+56944444444', 'cond1@ejemplo.cl', 'CONDUCTOR', 'AR01'),
    p('P011', 'Conductor Norte 2', '15.555.555-5', '+56955555555', 'cond2@ejemplo.cl', 'CONDUCTOR', 'AR01'),
    p('P012', 'Conductor Sur 1', '16.666.666-6', '+56966666666', 'cond3@ejemplo.cl', 'CONDUCTOR', 'AR02'),
    p('P013', 'Conductor Centro 1', '17.777.777-7', '+56977777777', 'cond4@ejemplo.cl', 'CONDUCTOR', 'AR03'),
  ];
  personas.find((x) => x.id === 'P010').licencia_vencimiento = addDays(20); // demo alerta licencia
  const contactos = [
    { id: 'C001', id_area: 'AR01', id_persona: 'P001', tipo: 'SUPERVISOR', telefono: '+56911111111', orden: 1, horario: 'Lun–Vie 08–18', activo: true },
    { id: 'C002', id_area: 'AR01', id_persona: 'P000', tipo: 'ENCARGADO_FLOTA', telefono: '+56900000000', orden: 2, horario: '24/7', activo: true },
    { id: 'C003', id_area: 'AR02', id_persona: 'P002', tipo: 'SUPERVISOR', telefono: '+56922222222', orden: 1, horario: 'Lun–Vie 08–18', activo: true },
    { id: 'C004', id_area: 'AR02', id_persona: 'P000', tipo: 'ENCARGADO_FLOTA', telefono: '+56900000000', orden: 2, horario: '24/7', activo: true },
    { id: 'C005', id_area: 'AR03', id_persona: 'P003', tipo: 'SUPERVISOR', telefono: '+56933333333', orden: 1, horario: 'Lun–Vie 08–18', activo: true },
    { id: 'C006', id_area: 'AR03', id_persona: 'P000', tipo: 'ENCARGADO_FLOTA', telefono: '+56900000000', orden: 2, horario: '24/7', activo: true },
  ];
  const destinos = [
    { id: 'D001', nombre: 'Oficina Central', id_area: null, frecuente: true, estado: 'APROBADO', activo: true },
    { id: 'D002', nombre: 'Bodega Regional', id_area: null, frecuente: true, estado: 'APROBADO', activo: true },
    { id: 'D003', nombre: 'Aeropuerto', id_area: null, frecuente: true, estado: 'APROBADO', activo: true },
    { id: 'D004', nombre: 'Taller mecánico', id_area: null, frecuente: true, estado: 'APROBADO', activo: true },
    { id: 'D005', nombre: 'Puesto fronterizo', id_area: 'AR01', frecuente: true, estado: 'APROBADO', activo: true },
  ];
  const tarjetas = vehiculos.map((v, i) => ({
    id: `T00${i + 1}`, numero_tarjeta: `${4000 + i}`, id_vehiculo: v.id, id_area: v.id_area, estado: 'ACTIVA', cupo_mensual: 400000,
  }));
  const doc = (id, v, tipo, venc) => ({
    id, id_vehiculo: v, tipo, fecha_emision: addDays(-300), fecha_vencimiento: venc, archivo: null, reemplazado_por: null, costo: null,
  });
  const documentos = [
    doc('DOC001', 'V001', 'REVISION_TECNICA', addDays(120)),
    doc('DOC002', 'V001', 'PERMISO_CIRCULACION', addDays(120)),
    doc('DOC003', 'V002', 'REVISION_TECNICA', addDays(12)),   // demo: por vencer
    doc('DOC004', 'V002', 'PERMISO_CIRCULACION', addDays(200)),
    doc('DOC005', 'V003', 'REVISION_TECNICA', addDays(-5)),   // demo: vencida
    doc('DOC006', 'V003', 'PERMISO_CIRCULACION', addDays(45)),
    doc('DOC007', 'V004', 'REVISION_TECNICA', addDays(300)),
    doc('DOC008', 'V004', 'PERMISO_CIRCULACION', addDays(300)),
    doc('DOC009', 'V005', 'REVISION_TECNICA', addDays(90)),
    doc('DOC010', 'V005', 'PERMISO_CIRCULACION', addDays(90)),
    doc('DOC011', 'V006', 'REVISION_TECNICA', addDays(180)),
    doc('DOC012', 'V006', 'PERMISO_CIRCULACION', addDays(180)),
  ];
  const config = {
    horas_en_uso: 8,               // atraso por defecto (si el área/vehículo no define)
    horas_en_uso_critica: 12,
    doc_dias_antes: [60, 30, 15, 7, 0],
    licencia_dias_antes: 30,
    boleta_pendiente_dias: 5,
    km_max_viaje: 500,
    bloquear_salida_doc_vencido: false,
  };
  return {
    areas, programas, vehiculos, personas, contactos, destinos, tarjetas, tarjeta_entregas: [],
    documentos, viajes: [], cargas: [], llamadas: [], alertas_estado: {}, sessions: {}, config,
  };
}

module.exports = { build, hashPin, checkPin };

if (require.main === module) {
  const store = require('./store');
  const fs = require('fs');
  const path = require('path');
  if (fs.existsSync(path.join(store.DATA_DIR, 'db.json')) && !process.argv.includes('--force')) {
    console.log('Ya existe data/db.json. Use --force para reiniciar con datos de ejemplo.');
  } else {
    store.reset(build());
    console.log('Base de datos de ejemplo creada.');
  }
}

});
def("./index", function (module, exports, require) {
process.env.TZ = process.env.TZ || 'America/Santiago';
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const ExcelJS = require('exceljs');
const store = require('./store');
const { checkPin } = require('./seed');
const L = require('./logic');

const app = express();
app.set('trust proxy', 1); // detrás del proxy HTTPS del alojamiento
app.use((req, res, next) => {
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use(express.json({ limit: '25mb' }));
const db = () => store.load();
const uid = (p) => `${p}${crypto.randomBytes(5).toString('hex')}`;
const nowISO = () => new Date().toISOString();

// ---------------- Autenticación ----------------
function auth(roles) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : req.query.t;
    const s = token && db().sessions[token];
    if (!s || Date.now() - s.creado > 30 * 86400000) return res.status(401).json({ error: 'No autenticado' });
    const persona = L.byId(db().personas, s.id_persona);
    if (!persona || !persona.activo) return res.status(401).json({ error: 'Usuario inactivo' });
    if (roles && !roles.includes(persona.rol)) return res.status(403).json({ error: 'Sin permiso' });
    req.persona = persona;
    next();
  };
}
const staff = auth(['ADMIN', 'SUPERVISOR']);
const adminOnly = auth(['ADMIN']);
const publicPersona = (p) => ({
  id: p.id, nombre_completo: p.nombre_completo, rol: p.rol, id_area: p.id_area, email: p.email, telefono: p.telefono,
});

const intentos = {};
app.post('/api/login', (req, res) => {
  const { email, pin } = req.body || {};
  const key = String(email || '').toLowerCase();
  const t = intentos[key] || { n: 0, hasta: 0 };
  if (Date.now() < t.hasta) return res.status(429).json({ error: 'Demasiados intentos, espere unos minutos' });
  const p = db().personas.find((x) => x.email.toLowerCase() === key && x.activo);
  if (!p || !checkPin(pin, p.pin_hash)) {
    t.n += 1;
    if (t.n >= 5) { t.hasta = Date.now() + 5 * 60000; t.n = 0; }
    intentos[key] = t;
    return res.status(401).json({ error: 'Correo o PIN incorrecto' });
  }
  intentos[key] = { n: 0, hasta: 0 };
  const token = crypto.randomBytes(24).toString('hex');
  db().sessions[token] = { id_persona: p.id, creado: Date.now() };
  store.save();
  res.json({ token, persona: publicPersona(p) });
});

app.post('/api/cambiar-pin', auth(), (req, res) => {
  const { pin_actual, pin_nuevo } = req.body || {};
  if (!checkPin(pin_actual, req.persona.pin_hash)) return res.status(400).json({ error: 'PIN actual incorrecto' });
  if (!/^\d{4,8}$/.test(String(pin_nuevo))) return res.status(400).json({ error: 'El PIN debe tener 4 a 8 dígitos' });
  req.persona.pin_hash = require('./seed').hashPin(pin_nuevo);
  store.save();
  res.json({ ok: true });
});

// ---------------- App del conductor ----------------
app.get('/api/bootstrap', auth(), (req, res) => {
  const d = db();
  const me = req.persona;
  const areas = me.rol === 'CONDUCTOR' ? [me.id_area] : L.areasDe(d, me);
  const vehiculos = d.vehiculos.filter((v) => v.activo).map((v) => {
    const docs = L.ultimosDocumentos(d, v.id).map((x) => ({ tipo: x.tipo, fecha_vencimiento: x.fecha_vencimiento }));
    return {
      id: v.id, patente: v.patente, marca: v.marca, modelo: v.modelo, id_area: v.id_area, id_programa: v.id_programa,
      codigo_qr: v.codigo_qr, km_actual: v.km_actual, documentos: docs,
    };
  });
  res.json({
    persona: publicPersona(me),
    config: { km_max_viaje: d.config.km_max_viaje, bloquear_salida_doc_vencido: d.config.bloquear_salida_doc_vencido },
    areas: d.areas, programas: d.programas, vehiculos,
    personas: d.personas.filter((p) => p.activo && p.rol === 'CONDUCTOR').map((p) => ({ id: p.id, nombre_completo: p.nombre_completo, id_area: p.id_area })),
    destinos: d.destinos.filter((x) => x.activo && (!x.id_area || areas.includes(x.id_area) || me.rol !== 'CONDUCTOR')),
    contactos: d.areas.reduce((acc, a) => ({ ...acc, [a.id]: L.contactosArea(d, a.id) }), {}),
    viajes_abiertos: d.viajes.filter((v) => v.estado_viaje === 'ABIERTO'),
    mis_viajes: d.viajes.filter((v) => v.id_conductor === me.id && v.fecha >= new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)),
    server_time: nowISO(),
  });
});

const IMG_FIELDS_V = ['firma_salida', 'firma_llegada', 'foto_respaldo_papel'];
const VIAJE_FIELDS = ['id', 'id_vehiculo', 'id_conductor', 'fecha', 'rol_conductor', 'origen', 'id_destino', 'destino_texto_nuevo',
  'km_inicial', 'hora_salida', 'pasajeros', 'firma_salida', 'km_final', 'hora_llegada', 'firma_llegada', 'estado_viaje',
  'observaciones', 'origen_registro', 'foto_respaldo_papel', 'creado_offline', 'creado_en', 'sin_qr'];
const CARGA_FIELDS = ['id', 'id_vehiculo', 'id_conductor', 'id_viaje', 'fecha_hora', 'litros', 'monto', 'numero_boleta', 'foto_boleta',
  'nivel_estanque_llegada', 'id_tarjeta', 'km_al_cargar', 'creado_offline', 'creado_en'];
const ADMIN_CARGA = ['estado_revision', 'boleta_fisica_recibida', 'fecha_recepcion_fisica', 'validada_por', 'fecha_validacion', 'observacion_revision'];
const pick = (o, f) => f.reduce((r, k) => (o[k] !== undefined ? { ...r, [k]: o[k] } : r), {});
const num = (x) => (x === '' || x === null || x === undefined ? null : Number(x));

function upsertViaje(d, inc, persona, extra = {}) {
  const v = pick(inc, VIAJE_FIELDS);
  if (!/^[\w-]{6,64}$/.test(String(v.id || ''))) throw new Error('ID de viaje inválido');
  const veh = L.byId(d.vehiculos, v.id_vehiculo);
  if (!veh) throw new Error(`Vehículo desconocido (${v.id_vehiculo})`);
  if (num(v.pasajeros) === null || num(v.pasajeros) < 0) throw new Error('Pasajeros obligatorio');
  const prev = d.viajes.find((x) => x.id === v.id);
  if (prev && prev.estado_viaje === 'CERRADO' && v.estado_viaje === 'ABIERTO') return prev; // registro viejo, ignorar
  for (const f of IMG_FIELDS_V) if (v[f]) v[f] = store.saveImage(v[f], `${v.id}_${f}`);
  for (const f of ['km_inicial', 'km_final', 'pasajeros']) if (f in v) v[f] = num(v[f]);
  const rec = { ...(prev || {}), ...v, ...extra, sincronizado_en: nowISO() };
  if (!prev) {
    rec.registrado_por = rec.registrado_por || persona.id;
    d.viajes.push(rec);
  } else Object.assign(prev, rec);
  const out = prev || rec;
  if (out.estado_viaje === 'CERRADO' && out.km_final > veh.km_actual) veh.km_actual = out.km_final;
  else if (out.estado_viaje === 'ABIERTO' && out.km_inicial > veh.km_actual) veh.km_actual = out.km_inicial;
  return out;
}

app.post('/api/sync', auth(), (req, res) => {
  const d = db();
  const { viajes = [], cargas = [] } = req.body || {};
  const aceptados = { viajes: [], cargas: [] };
  const errores = [];
  for (const v of viajes) {
    try {
      if (req.persona.rol === 'CONDUCTOR' && v.origen_registro === 'PAPEL') throw new Error('No permitido');
      upsertViaje(d, v, req.persona);
      aceptados.viajes.push(v.id);
    } catch (e) { errores.push({ id: v && v.id, error: e.message }); if (v && /inválido|desconocido|obligatorio/.test(e.message)) aceptados.viajes.push(v.id); }
  }
  for (const c of cargas) {
    try {
      const x = pick(c, CARGA_FIELDS);
      if (!/^[\w-]{6,64}$/.test(String(x.id || ''))) throw new Error('ID de carga inválido');
      if (!L.byId(d.vehiculos, x.id_vehiculo)) throw new Error('Vehículo desconocido');
      if (!x.foto_boleta) throw new Error('Foto de boleta obligatoria');
      x.foto_boleta = store.saveImage(x.foto_boleta, `${x.id}_boleta`);
      for (const f of ['litros', 'monto', 'km_al_cargar']) x[f] = num(x[f]);
      const prev = d.cargas.find((y) => y.id === x.id);
      if (prev) Object.assign(prev, x, pick(prev, ADMIN_CARGA));
      else d.cargas.push({ estado_revision: 'PENDIENTE', boleta_fisica_recibida: false, ...x, sincronizado_en: nowISO() });
      aceptados.cargas.push(x.id);
    } catch (e) { errores.push({ id: c && c.id, error: e.message }); if (c && /inválido|desconocido|obligatoria/.test(e.message)) aceptados.cargas.push(c.id); }
  }
  store.save();
  res.json({ aceptados, errores, server_time: nowISO() });
});

// ---------------- Archivos subidos (requieren sesión) ----------------
app.use('/uploads', auth(), express.static(store.UPLOADS, { maxAge: '7d' }));

// ---------------- Panel de administración ----------------
const inAreas = (req, areaId) => req.persona.rol === 'ADMIN' || areaId === req.persona.id_area;

app.get('/api/admin/estado', staff, (req, res) => {
  const d = db();
  const now = new Date();
  const items = d.vehiculos.filter((v) => v.activo && inAreas(req, v.id_area)).map((v) => {
    const e = L.estadoVehiculo(d, v, now);
    const cond = e.viaje && L.byId(d.personas, e.viaje.id_conductor);
    const dest = e.viaje && (L.byId(d.destinos, e.viaje.id_destino) || {}).nombre;
    const docs = L.ultimosDocumentos(d, v.id).map((x) => ({ id: x.id, tipo: x.tipo, fecha_vencimiento: x.fecha_vencimiento, ...L.estadoDocumento(x, now) }));
    const ultima = d.cargas.filter((c) => c.id_vehiculo === v.id).sort((a, b) => b.fecha_hora.localeCompare(a.fecha_hora))[0];
    return {
      id: v.id, patente: v.patente, marca: v.marca, modelo: v.modelo, id_area: v.id_area,
      area: (L.byId(d.areas, v.id_area) || {}).nombre, estado: e.estado, horas: +e.horas.toFixed(1),
      umbral: L.umbralHoras(d, v), km_actual: v.km_actual,
      conductor: cond ? cond.nombre_completo : null, conductor_tel: cond ? cond.telefono : null,
      destino: dest || (e.viaje && e.viaje.destino_texto_nuevo) || null, hora_salida: e.viaje && e.viaje.hora_salida,
      id_viaje: e.viaje && e.viaje.id, estanque: ultima ? ultima.nivel_estanque_llegada : null, documentos: docs,
      contactos: L.contactosArea(d, v.id_area),
    };
  });
  res.json({ items, resumen: items.reduce((r, x) => ({ ...r, [x.estado]: (r[x.estado] || 0) + 1 }), {}) });
});

app.get('/api/admin/alertas', staff, (req, res) => {
  const d = db();
  const todas = L.computeAlertas(d).filter((a) => !a.id_area || inAreas(req, a.id_area));
  const items = (req.query.todas ? todas : todas.filter((a) => a.estado !== 'CERRADA')).map((a) => ({
    ...a, patente: a.id_vehiculo ? (L.byId(d.vehiculos, a.id_vehiculo) || {}).patente : null,
    contactos: a.id_area ? L.contactosArea(d, a.id_area) : [],
  }));
  res.json({ items });
});
app.post('/api/admin/alertas/estado', staff, (req, res) => {
  const { key, estado, comentario } = req.body || {};
  if (!key || !['ABIERTA', 'ATENDIDA', 'CERRADA'].includes(estado)) return res.status(400).json({ error: 'Datos inválidos' });
  db().alertas_estado[key] = { estado, comentario: comentario || '', por: req.persona.id, en: nowISO() };
  store.save();
  res.json({ ok: true });
});

app.get('/api/admin/documentos', staff, (req, res) => {
  const d = db();
  const now = new Date();
  const items = [];
  for (const v of d.vehiculos.filter((x) => x.activo && inAreas(req, x.id_area))) {
    for (const x of L.ultimosDocumentos(d, v.id)) items.push({ ...x, patente: v.patente, id_area: v.id_area, ...L.estadoDocumento(x, now) });
  }
  items.sort((a, b) => a.dias - b.dias);
  res.json({ items, vehiculos: d.vehiculos.filter((v) => v.activo).map((v) => ({ id: v.id, patente: v.patente })) });
});
app.post('/api/admin/documentos', adminOnly, (req, res) => {
  const d = db();
  const b = req.body || {};
  if (!L.byId(d.vehiculos, b.id_vehiculo) || !b.tipo || !/^\d{4}-\d{2}-\d{2}$/.test(b.fecha_vencimiento || '')) {
    return res.status(400).json({ error: 'Vehículo, tipo y fecha de vencimiento son obligatorios' });
  }
  const id = uid('DOC');
  const anterior = L.ultimosDocumentos(d, b.id_vehiculo).find((x) => x.tipo === b.tipo);
  const doc = {
    id, id_vehiculo: b.id_vehiculo, tipo: b.tipo, fecha_emision: b.fecha_emision || null, fecha_vencimiento: b.fecha_vencimiento,
    archivo: b.archivo ? store.saveImage(b.archivo, `${id}_doc`) : null, reemplazado_por: null, costo: num(b.costo),
  };
  d.documentos.push(doc);
  if (anterior) anterior.reemplazado_por = id;
  store.save();
  res.json(doc);
});

app.get('/api/admin/cargas', staff, (req, res) => {
  const d = db();
  let items = d.cargas.filter((c) => inAreas(req, (L.byId(d.vehiculos, c.id_vehiculo) || {}).id_area));
  if (req.query.estado) items = items.filter((c) => c.estado_revision === req.query.estado);
  if (req.query.pendiente_fisica) items = items.filter((c) => !c.boleta_fisica_recibida);
  items = items.sort((a, b) => b.fecha_hora.localeCompare(a.fecha_hora)).slice(0, 300).map((c) => ({
    ...c, patente: (L.byId(d.vehiculos, c.id_vehiculo) || {}).patente,
    conductor: (L.byId(d.personas, c.id_conductor) || {}).nombre_completo,
  }));
  res.json({ items });
});
app.post('/api/admin/cargas/:id/validar', staff, (req, res) => {
  const c = L.byId(db().cargas, req.params.id);
  if (!c) return res.status(404).json({ error: 'No existe' });
  const { estado_revision, boleta_fisica_recibida, observacion_revision } = req.body || {};
  if (!['PENDIENTE', 'VALIDADA', 'OBSERVADA'].includes(estado_revision)) return res.status(400).json({ error: 'Estado inválido' });
  Object.assign(c, {
    estado_revision, boleta_fisica_recibida: !!boleta_fisica_recibida, observacion_revision: observacion_revision || '',
    fecha_recepcion_fisica: boleta_fisica_recibida ? (c.fecha_recepcion_fisica || nowISO().slice(0, 10)) : null,
    validada_por: req.persona.id, fecha_validacion: nowISO().slice(0, 10),
  });
  store.save();
  res.json(c);
});

app.get('/api/admin/tarjetas', staff, (req, res) => {
  const d = db();
  res.json({
    tarjetas: d.tarjetas.map((t) => ({ ...t, patente: (L.byId(d.vehiculos, t.id_vehiculo) || {}).patente })),
    entregas: d.tarjeta_entregas.map((e) => ({
      ...e, conductor: (L.byId(d.personas, e.id_conductor) || {}).nombre_completo,
      numero_tarjeta: (L.byId(d.tarjetas, e.id_tarjeta) || {}).numero_tarjeta,
    })).reverse(),
    conductores: d.personas.filter((p) => p.rol === 'CONDUCTOR' && p.activo).map((p) => ({ id: p.id, nombre_completo: p.nombre_completo })),
  });
});
app.post('/api/admin/tarjetas/entrega', staff, (req, res) => {
  const d = db();
  const b = req.body || {};
  if (!L.byId(d.tarjetas, b.id_tarjeta) || !L.byId(d.personas, b.id_conductor)) return res.status(400).json({ error: 'Tarjeta y conductor son obligatorios' });
  const id = uid('ENT');
  const e = {
    id, id_tarjeta: b.id_tarjeta, id_conductor: b.id_conductor, fecha_entrega: nowISO().slice(0, 10), fecha_devolucion: null,
    entregado_por: req.persona.id, firma: b.firma ? store.saveImage(b.firma, `${id}_firma`) : null, observaciones: b.observaciones || '',
  };
  d.tarjeta_entregas.push(e);
  store.save();
  res.json(e);
});
app.post('/api/admin/tarjetas/devolucion/:id', staff, (req, res) => {
  const e = L.byId(db().tarjeta_entregas, req.params.id);
  if (!e) return res.status(404).json({ error: 'No existe' });
  e.fecha_devolucion = nowISO().slice(0, 10);
  store.save();
  res.json(e);
});

// Transcripción de bitácora de emergencia (papel)
app.post('/api/admin/viajes/papel', staff, (req, res) => {
  try {
    const b = req.body || {};
    const id = uid('PAP');
    const iso = (f, h) => (f && h ? new Date(`${f}T${h}:00`).toISOString() : null);
    const veh = L.byId(db().vehiculos, b.id_vehiculo);
    if (!veh || !inAreas(req, veh.id_area)) throw new Error('Vehículo inválido');
    const v = upsertViaje(db(), {
      id, id_vehiculo: b.id_vehiculo, id_conductor: b.id_conductor, fecha: b.fecha, rol_conductor: b.rol_conductor || 'Titular',
      origen: b.origen || '', id_destino: b.id_destino || null, destino_texto_nuevo: b.destino_texto_nuevo || '',
      km_inicial: b.km_inicial, km_final: b.km_final, hora_salida: iso(b.fecha, b.hora_salida), hora_llegada: iso(b.fecha, b.hora_llegada),
      pasajeros: b.pasajeros, estado_viaje: b.km_final ? 'CERRADO' : 'ABIERTO', observaciones: b.observaciones || '',
      origen_registro: 'PAPEL', foto_respaldo_papel: b.foto, creado_offline: false, creado_en: nowISO(),
    }, req.persona);
    store.save();
    res.json(v);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/admin/resumen', staff, (req, res) => {
  const d = db();
  const mes = req.query.mes || nowISO().slice(0, 7);
  const vs = d.viajes.filter((v) => v.fecha && v.fecha.startsWith(mes) && v.estado_viaje !== 'ANULADO');
  const papel = vs.filter((v) => v.origen_registro === 'PAPEL').length;
  res.json({ mes, viajes: vs.length, papel, app: vs.length - papel, pct_app: vs.length ? Math.round(((vs.length - papel) / vs.length) * 100) : null });
});

app.get('/api/admin/viajes', staff, (req, res) => {
  const d = db();
  const mes = req.query.mes || nowISO().slice(0, 7);
  const items = d.viajes.filter((v) => v.fecha && v.fecha.startsWith(mes)).sort((a, b) => (b.hora_salida || '').localeCompare(a.hora_salida || ''))
    .slice(0, 300).map((v) => ({
      ...v, patente: (L.byId(d.vehiculos, v.id_vehiculo) || {}).patente,
      conductor: (L.byId(d.personas, v.id_conductor) || {}).nombre_completo,
      destino: (L.byId(d.destinos, v.id_destino) || {}).nombre || v.destino_texto_nuevo,
    }));
  res.json({ items });
});
app.post('/api/admin/viajes/:id/anular', staff, (req, res) => {
  const v = L.byId(db().viajes, req.params.id);
  if (!v) return res.status(404).json({ error: 'No existe' });
  v.estado_viaje = 'ANULADO';
  v.observaciones = `${v.observaciones || ''} [Anulado por ${req.persona.nombre_completo}: ${(req.body && req.body.motivo) || 's/m'}]`.trim();
  store.save();
  res.json(v);
});

app.get('/api/admin/destinos', staff, (req, res) => res.json({ items: db().destinos }));
app.post('/api/admin/destinos', staff, (req, res) => {
  const b = req.body || {};
  if (b.id) {
    const x = L.byId(db().destinos, b.id);
    if (!x) return res.status(404).json({ error: 'No existe' });
    if (b.estado) x.estado = b.estado;
    if (b.merge_en) { // fusionar un destino nuevo con uno existente
      for (const v of db().viajes) if (v.id_destino === b.id) v.id_destino = b.merge_en;
      x.activo = false;
    }
  } else {
    if (!b.nombre) return res.status(400).json({ error: 'Nombre obligatorio' });
    db().destinos.push({ id: uid('D'), nombre: b.nombre, id_area: b.id_area || null, frecuente: true, estado: 'APROBADO', activo: true });
  }
  store.save();
  res.json({ ok: true });
});

app.get('/api/admin/maestros', staff, (req, res) => {
  const d = db();
  res.json({
    vehiculos: d.vehiculos.map((v) => ({ ...v, area: (L.byId(d.areas, v.id_area) || {}).nombre })),
    areas: d.areas, programas: d.programas,
    personas: d.personas.map(publicPersonaAdmin),
    contactos: d.contactos.map((c) => ({ ...c, nombre: (L.byId(d.personas, c.id_persona) || {}).nombre_completo })),
    config: d.config,
  });
});
function publicPersonaAdmin(p) {
  return { id: p.id, nombre_completo: p.nombre_completo, rut: p.rut, telefono: p.telefono, email: p.email, rol: p.rol, id_area: p.id_area,
    licencia_vencimiento: p.licencia_vencimiento, activo: p.activo };
}
app.post('/api/admin/contactos', adminOnly, (req, res) => {
  const b = req.body || {};
  const d = db();
  if (b.id) {
    const c = L.byId(d.contactos, b.id);
    if (!c) return res.status(404).json({ error: 'No existe' });
    Object.assign(c, pick(b, ['telefono', 'horario', 'orden', 'tipo', 'activo', 'id_persona']));
  } else {
    if (!L.byId(d.areas, b.id_area) || !b.telefono) return res.status(400).json({ error: 'Área y teléfono obligatorios' });
    d.contactos.push({ id: uid('C'), id_area: b.id_area, id_persona: b.id_persona || null, tipo: b.tipo || 'SUPERVISOR',
      telefono: b.telefono, orden: num(b.orden) || 1, horario: b.horario || '', activo: true });
  }
  store.save();
  res.json({ ok: true });
});
app.post('/api/admin/personas', adminOnly, (req, res) => {
  const b = req.body || {};
  const d = db();
  const { hashPin } = require('./seed');
  if (b.id) {
    const p = L.byId(d.personas, b.id);
    if (!p) return res.status(404).json({ error: 'No existe' });
    Object.assign(p, pick(b, ['nombre_completo', 'rut', 'telefono', 'email', 'rol', 'id_area', 'licencia_vencimiento', 'activo']));
    if (b.pin) p.pin_hash = hashPin(b.pin);
  } else {
    if (!b.nombre_completo || !b.email || !/^\d{4,8}$/.test(String(b.pin || ''))) return res.status(400).json({ error: 'Nombre, correo y PIN (4-8 dígitos) obligatorios' });
    if (d.personas.some((p) => p.email.toLowerCase() === b.email.toLowerCase())) return res.status(400).json({ error: 'Correo ya registrado' });
    d.personas.push({ id: uid('P'), nombre_completo: b.nombre_completo, rut: b.rut || '', telefono: b.telefono || '', email: b.email,
      rol: b.rol || 'CONDUCTOR', id_area: b.id_area, pin_hash: hashPin(b.pin), licencia_clase: '', licencia_vencimiento: b.licencia_vencimiento || '', activo: true });
  }
  store.save();
  res.json({ ok: true });
});
app.post('/api/admin/vehiculos', adminOnly, (req, res) => {
  const b = req.body || {};
  const d = db();
  if (b.id) {
    const v = L.byId(d.vehiculos, b.id);
    if (!v) return res.status(404).json({ error: 'No existe' });
    Object.assign(v, pick(b, ['marca', 'modelo', 'anio', 'id_area', 'id_programa', 'horas_max_en_uso', 'tipo_combustible', 'activo', 'estado_manual']));
  } else {
    if (!b.patente || !L.byId(d.areas, b.id_area)) return res.status(400).json({ error: 'Patente y área obligatorias' });
    const pat = b.patente.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (d.vehiculos.some((v) => v.patente === pat)) return res.status(400).json({ error: 'Patente ya registrada' });
    d.vehiculos.push({ id: uid('V'), patente: pat, marca: b.marca || '', modelo: b.modelo || '', anio: num(b.anio), id_area: b.id_area,
      id_programa: b.id_programa || null, codigo_qr: `VEH-${pat}`, km_actual: num(b.km_actual) || 0, estado_manual: null,
      horas_max_en_uso: null, tipo_combustible: b.tipo_combustible || 'Diésel', activo: true });
  }
  store.save();
  res.json({ ok: true });
});
app.post('/api/admin/llamadas', staff, (req, res) => {
  const b = req.body || {};
  db().llamadas.push({ id: uid('LL'), fecha_hora: nowISO(), id_vehiculo: b.id_vehiculo || null, id_contacto: b.id_contacto || null,
    motivo: b.motivo || 'CONSULTA', registrado_por: req.persona.id, nota: b.nota || '' });
  store.save();
  res.json({ ok: true });
});

// QR del vehículo (SVG) para imprimir y pegar
app.get('/api/admin/vehiculos/:id/qr.svg', staff, async (req, res) => {
  const v = L.byId(db().vehiculos, req.params.id);
  if (!v) return res.status(404).end();
  const svg = await QRCode.toString(v.codigo_qr, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').send(svg);
});

// ---------------- Bitácora ----------------
function bitParams(req) {
  const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : nowISO().slice(0, 7);
  let id_area = req.query.area || null;
  if (req.persona.rol !== 'ADMIN') id_area = req.persona.id_area;
  return { mes, id_vehiculo: req.query.vehiculo || null, id_area };
}
app.get('/api/admin/bitacora', staff, (req, res) => {
  const p = bitParams(req);
  res.json({ ...p, rows: L.bitacora(db(), p) });
});
const COLS = [
  ['Fecha', 'fecha', 12], ['Patente', 'patente', 10], ['Conductor', 'conductor', 24], ['Programa', 'programa', 22], ['Rol', 'rol', 10],
  ['Origen', 'origen', 18], ['Destino', 'destino', 22], ['KM Inicial', 'km_inicial', 11], ['KM Final', 'km_final', 11],
  ['Hora Salida', 'hora_salida', 11], ['Hora Llegada', 'hora_llegada', 12], ['Pasajeros', 'pasajeros', 10], ['Litros', 'litros', 9],
  ['Valor', 'valor', 11], ['N° Boleta', 'boleta', 14], ['Firma', 'firma', 16], ['Observaciones', 'observaciones', 34],
];
app.get('/api/admin/bitacora.xlsx', staff, async (req, res) => {
  const p = bitParams(req);
  const rows = L.bitacora(db(), p);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(`Bitácora ${p.mes}`);
  ws.columns = COLS.map(([h, k, w]) => ({ header: h, key: k, width: w }));
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
  const firmaCol = COLS.findIndex((c) => c[1] === 'firma');
  rows.forEach((r, i) => {
    const row = ws.addRow({ ...r, firma: '' });
    row.height = 34;
    row.alignment = { vertical: 'middle', wrapText: true };
    if (r.firma && r.firma.startsWith('/uploads/')) {
      const file = path.join(store.UPLOADS, path.basename(r.firma));
      try {
        const id = wb.addImage({ filename: file, extension: file.endsWith('.png') ? 'png' : 'jpeg' });
        ws.addImage(id, { tl: { col: firmaCol + 0.05, row: i + 1.05 }, ext: { width: 90, height: 40 } });
      } catch (e) { /* firma ilegible: se omite */ }
    }
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: 'A1', to: { row: 1, column: COLS.length } };
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="bitacora_${p.mes}${p.id_vehiculo ? '_' + p.id_vehiculo : ''}.xlsx"`);
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
});

// ---------------- Archivos estáticos ----------------
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, f) => { if (/sw\.js$|\.html$/.test(f)) res.setHeader('Cache-Control', 'no-cache'); },
}));

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Error interno' }); });

if (require.main === module) {
  const port = process.env.PORT || 3000;
  store.load();
  app.listen(port, () => console.log(`Control de flota en http://localhost:${port}  (admin: /admin/)`));
}
module.exports = app;

});

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

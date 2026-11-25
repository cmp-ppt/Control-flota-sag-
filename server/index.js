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

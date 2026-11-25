// Prueba de extremo a extremo de la API (usa una base temporal).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flota-'));
const app = require('../server/index');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (p, body, token) => {
    const r = await fetch(base + p, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  const login = async (email) => (await call('/api/login', { email, pin: '1234' })).data.token;

  // login
  assert.strictEqual((await call('/api/login', { email: 'cond1@ejemplo.cl', pin: '0000' })).status, 401);
  const tc = await login('cond1@ejemplo.cl');
  const ta = await login('admin@ejemplo.cl');
  const ts = await login('sup.sur@ejemplo.cl');
  assert.strictEqual((await call('/api/admin/estado', null, tc)).status, 403, 'conductor no entra al panel');

  const boot = (await call('/api/bootstrap', null, tc)).data;
  assert.ok(boot.vehiculos.length >= 6);
  const veh = boot.vehiculos.find((v) => v.patente === 'ABCD12');

  // salida sin pasajeros → rechazada (se descarta, no se reintenta)
  const t0 = new Date(Date.now() - 10 * 3600000).toISOString(); // salió hace 10 h → atrasado (límite 8 h)
  const d0 = new Date();
  const hoy = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;
  const viaje = {
    id: 'trip-0001', id_vehiculo: veh.id, id_conductor: 'P010', fecha: hoy, rol_conductor: 'Titular', origen: 'Base',
    id_destino: 'D001', km_inicial: 45210, hora_salida: t0, pasajeros: 2, firma_salida: PNG, estado_viaje: 'ABIERTO', origen_registro: 'APP',
  };
  let r = await call('/api/sync', { viajes: [{ ...viaje, id: 'trip-bad01', pasajeros: '' }] }, tc);
  assert.strictEqual(r.data.errores.length, 1);

  // sync (idempotente: enviar dos veces no duplica)
  await call('/api/sync', { viajes: [viaje] }, tc);
  await call('/api/sync', { viajes: [viaje] }, tc);
  let est = (await call('/api/admin/estado', null, ta)).data;
  const e1 = est.items.find((i) => i.patente === 'ABCD12');
  assert.strictEqual(e1.estado, 'ATRASADO', 'vehículo con 10 h debe estar atrasado');
  assert.strictEqual(e1.contactos[0].telefono, '+56911111111', 'contacto del supervisor del área');
  assert.strictEqual(est.items.filter((i) => i.estado === 'DISPONIBLE').length, 5);

  // supervisor del Sur no ve vehículos del Norte
  est = (await call('/api/admin/estado', null, ts)).data;
  assert.ok(est.items.every((i) => i.id_area === 'AR02'));

  // alertas: atraso + docs (V002 por vencer, V003 vencida) + licencia
  const al = (await call('/api/admin/alertas', null, ta)).data.items;
  const tipos = al.map((a) => a.tipo);
  assert.ok(tipos.includes('VEHICULO_ATRASADO') && tipos.includes('DOCUMENTO') && tipos.includes('LICENCIA'));
  assert.ok(al.find((a) => a.mensaje.includes('IJKL56') && a.mensaje.includes('VENCIDO')));

  // combustible sin foto → rechazada; con foto OK; estanque bajo genera alerta
  const carga = { id: 'fuel-0001', id_vehiculo: veh.id, id_conductor: 'P010', fecha_hora: new Date().toISOString(), litros: 40, monto: 52000,
    numero_boleta: '12345', foto_boleta: PNG, nivel_estanque_llegada: '1/2', km_al_cargar: 45300 };
  r = await call('/api/sync', { cargas: [{ ...carga, id: 'fuel-bad01', foto_boleta: '' }] }, tc);
  assert.strictEqual(r.data.errores.length, 1);
  await call('/api/sync', { cargas: [carga] }, tc);
  assert.ok((await call('/api/admin/alertas', null, ta)).data.items.some((a) => a.tipo === 'ESTANQUE_BAJO'));

  // llegada (cierra viaje) → disponible, km actualizado
  await call('/api/sync', { viajes: [{ ...viaje, km_final: 45290, hora_llegada: new Date().toISOString(), firma_llegada: PNG, estado_viaje: 'CERRADO' }] }, tc);
  // reenvío de un registro viejo ABIERTO no reabre el viaje
  await call('/api/sync', { viajes: [viaje] }, tc);
  est = (await call('/api/admin/estado', null, ta)).data;
  const e2 = est.items.find((i) => i.patente === 'ABCD12');
  assert.strictEqual(e2.estado, 'DISPONIBLE');
  assert.strictEqual(e2.km_actual, 45290);

  // validación cruzada de boleta (solo si recibió física)
  let cs = (await call('/api/admin/cargas', null, ta)).data.items;
  assert.strictEqual(cs.length, 1);
  await call(`/api/admin/cargas/${cs[0].id}/validar`, { estado_revision: 'VALIDADA', boleta_fisica_recibida: true }, ta);
  await call('/api/sync', { cargas: [carga] }, tc); // un reenvío no pisa la validación
  cs = (await call('/api/admin/cargas', null, ta)).data.items;
  assert.strictEqual(cs[0].estado_revision, 'VALIDADA');

  // transcripción de papel
  r = await call('/api/admin/viajes/papel', { fecha: hoy, id_vehiculo: 'V002', id_conductor: 'P011', km_inicial: 45290, km_final: 45350,
    hora_salida: '22:00', hora_llegada: '23:30', pasajeros: 1, id_destino: 'D002', foto: PNG }, ta);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));

  // bitácora: columnas + junta viajes de app, papel y combustible
  const mes = hoy.slice(0, 7);
  const bit = (await call(`/api/admin/bitacora?mes=${mes}`, null, ta)).data.rows;
  assert.strictEqual(bit.length, 2);
  const row = bit.find((b) => b.rol === 'Titular' && b.pasajeros === 2);
  assert.strictEqual(row.litros, 40);
  assert.strictEqual(row.boleta, '12345');
  assert.strictEqual(row.destino, 'Oficina Central');
  assert.ok(bit.some((b) => b.origen_registro === 'PAPEL'));

  // Excel
  const x = await call(`/api/admin/bitacora.xlsx?mes=${mes}`, null, ta);
  assert.strictEqual(x.status, 200);
  assert.strictEqual(x.data.slice(0, 2).toString(), 'PK', 'xlsx es un zip');

  // QR
  const qr = await call(`/api/admin/vehiculos/${veh.id}/qr.svg`, null, ta);
  assert.strictEqual(qr.status, 200);
  assert.ok(qr.data.toString().includes('<svg'));

  // uploads protegidos
  const up = (await call('/api/admin/cargas', null, ta)).data.items[0].foto_boleta;
  assert.strictEqual((await fetch(base + up)).status, 401);
  assert.strictEqual((await fetch(`${base}${up}?t=${ta}`)).status, 200);

  console.log('✅ Todas las pruebas de API pasaron');
  srv.close();
  process.exit(0);
})().catch((e) => { console.error('❌', e); process.exit(1); });

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

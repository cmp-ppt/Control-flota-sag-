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

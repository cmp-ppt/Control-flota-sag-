'use strict';
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const main = $('#main');
let S = null; // {token, persona}
try { S = JSON.parse(localStorage.getItem('admin_session') || 'null'); } catch (e) { /* sin almacenamiento */ }
let tab = 'semaforo', timer = null;

const fmtDT = (iso) => (iso ? new Date(iso).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const money = (n) => (n === '' || n == null ? '' : '$' + Number(n).toLocaleString('es-CL'));
const img = (u) => (u ? `${u}?t=${S.token}` : '');
function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3000); }

async function A(path, body, raw) {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${S.token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { logout(); throw new Error('Sesión vencida'); }
  if (raw) return r;
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { toast(d.error || 'Error'); throw new Error(d.error || r.status); }
  return d;
}
function logout() { S = null; try { localStorage.removeItem('admin_session'); } catch (e) { /* */ } render(); }

function modal(html, onReady) {
  const d = document.createElement('dialog');
  d.innerHTML = html;
  document.body.appendChild(d);
  d.addEventListener('close', () => d.remove());
  d.showModal();
  d.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => d.close()));
  if (onReady) onReady(d);
  return d;
}
const fileToDataURL = (file, max = 1600) => new Promise((ok, fail) => {
  const im = new Image();
  im.onload = () => {
    const k = Math.min(1, max / Math.max(im.width, im.height)), c = document.createElement('canvas');
    c.width = im.width * k; c.height = im.height * k; c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    ok(c.toDataURL('image/jpeg', 0.75));
  };
  im.onerror = () => fail(new Error('Imagen inválida'));
  im.src = URL.createObjectURL(file);
});

// ---------- navegación ----------
const TABS = [
  ['semaforo', '🚦 Semáforo'], ['alertas', '🔔 Alertas'], ['venc', '📅 Vencimientos'], ['boletas', '⛽ Combustible y boletas'],
  ['tarjetas', '💳 Tarjetas'], ['papel', '📝 Papel'], ['bitacora', '📖 Bitácora'], ['maestros', '⚙ Maestros'],
];
function render() {
  clearInterval(timer);
  if (!S) return loginView();
  $('#who').innerHTML = `${esc(S.persona.nombre_completo)} (${S.persona.rol.toLowerCase()}) · <a href="#" id="lo" style="color:#fff">salir</a>`;
  $('#lo').onclick = (e) => { e.preventDefault(); logout(); };
  $('#nav').innerHTML = TABS.map(([k, n]) => `<a data-t="${k}" class="${k === tab ? 'on' : ''}">${n}</a>`).join('');
  $('#nav').onclick = (e) => { const a = e.target.closest('[data-t]'); if (a) { tab = a.dataset.t; render(); } };
  ({ semaforo, alertas, venc, boletas, tarjetas, papel, bitacora, maestros })[tab]();
}
function loginView() {
  $('#who').textContent = ''; $('#nav').innerHTML = '';
  main.innerHTML = `<div class="card" style="max-width:360px;margin:60px auto;border-top-color:var(--brand)"><h2>Ingresar</h2>
    <p><input id="em" type="email" placeholder="Correo" style="width:100%"></p>
    <p><input id="pn" type="password" placeholder="PIN" style="width:100%"></p><p id="er" style="color:var(--bad)"></p>
    <button id="ok" style="width:100%">Entrar</button></div>`;
  const go = async () => {
    try {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('#em').value.trim(), pin: $('#pn').value }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      if (d.persona.rol === 'CONDUCTOR') throw new Error('Este panel es para supervisores y administradores');
      S = d; try { localStorage.setItem('admin_session', JSON.stringify(S)); } catch (e) { /* */ }
      render();
    } catch (e) { $('#er').textContent = e.message; }
  };
  $('#ok').onclick = go; $('#pn').onkeydown = (e) => e.key === 'Enter' && go();
}

const callBtns = (cs, label = '📞') => (cs || []).map((c) => `<a class="call" href="tel:${esc(c.telefono)}" title="${esc(c.horario || '')}">${label} ${esc(c.nombre || c.tipo)} · ${esc(c.telefono)}</a>`).join('');

// ---------- Semáforo ----------
async function semaforo() {
  const draw = async () => {
    const { items, resumen } = await A('/api/admin/estado');
    const res = await A('/api/admin/resumen');
    const areas = [...new Set(items.map((i) => i.area))];
    const f = $('#fa') ? $('#fa').value : '';
    main.innerHTML = `<div class="kpis">
      <div class="kpi"><b style="color:var(--ok)">${resumen.DISPONIBLE || 0}</b>🟢 Disponibles</div>
      <div class="kpi"><b style="color:var(--bad)">${resumen.EN_USO || 0}</b>🔴 En uso</div>
      <div class="kpi"><b style="color:var(--warn)">${resumen.ATRASADO || 0}</b>🟡 Atrasados</div>
      <div class="kpi"><b>${res.pct_app ?? '—'}${res.pct_app != null ? '%' : ''}</b>viajes por app (${res.mes})</div></div>
      <div class="bar"><label>Área<select id="fa"><option value="">Todas</option>${areas.map((a) => `<option ${a === f ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
      <span class="muted">Se actualiza solo cada 30 s</span></div>
      <div class="cards">${items.filter((i) => !f || i.area === f).sort((a, b) => ['ATRASADO', 'EN_USO', 'MANTENCION', 'DISPONIBLE'].indexOf(a.estado) - ['ATRASADO', 'EN_USO', 'MANTENCION', 'DISPONIBLE'].indexOf(b.estado)).map((i) => {
        const icon = { DISPONIBLE: '🟢', EN_USO: '🔴', ATRASADO: '🟡', MANTENCION: '⚪' }[i.estado];
        const docBad = i.documentos.filter((d) => d.estado !== 'VIGENTE');
        return `<div class="card ${i.estado}"><div style="display:flex;justify-content:space-between"><b style="font-size:18px">${icon} ${esc(i.patente)}</b><span class="muted">${esc(i.area)}</span></div>
        <div class="muted">${esc(i.marca)} ${esc(i.modelo)} · ${i.km_actual.toLocaleString('es-CL')} km${i.estanque ? ' · estanque ' + esc(i.estanque) : ''}</div>
        ${i.estado === 'DISPONIBLE' || i.estado === 'MANTENCION' ? '' : `<p>👤 ${esc(i.conductor || '?')}<br>➡ ${esc(i.destino || '—')}<br>⏱ salió ${fmtDT(i.hora_salida)} · <b>${i.horas} h</b> (límite ${i.umbral} h)</p>`}
        ${docBad.map((d) => `<span class="tag t-${d.estado}">${esc(d.tipo.replace('_', ' '))}: ${d.dias < 0 ? 'vencida' : d.dias + ' d'}</span> `).join('')}
        ${i.estado === 'ATRASADO' || i.estado === 'EN_USO' ? `<div style="margin-top:8px">${callBtns(i.contactos, '📞')}${i.conductor_tel ? `<a class="call" style="background:var(--brand)" href="tel:${esc(i.conductor_tel)}">📞 Conductor</a>` : ''}
        <button class="sec" data-ll="${i.id}" data-v="${esc(i.patente)}" style="font-size:12px">Registrar llamada</button></div>` : ''}</div>`;
      }).join('')}</div>`;
    $('#fa').onchange = draw;
    main.querySelectorAll('[data-ll]').forEach((b) => (b.onclick = () => {
      modal(`<h3>Registrar llamada · ${esc(b.dataset.v)}</h3><div class="fg"><label class="full">Motivo<select id="mo"><option value="VEHICULO_NO_REGRESA">Vehículo no regresa</option><option value="CONSULTA">Consulta</option><option value="EMERGENCIA">Emergencia</option></select></label>
        <label class="full">Nota<textarea id="no" rows="3"></textarea></label></div><p><button id="g">Guardar</button> <button class="sec" data-close>Cancelar</button></p>`,
      (d) => { d.querySelector('#g').onclick = async () => { await A('/api/admin/llamadas', { id_vehiculo: b.dataset.ll, motivo: d.querySelector('#mo').value, nota: d.querySelector('#no').value }); d.close(); toast('Llamada registrada'); }; });
    }));
  };
  await draw();
  timer = setInterval(() => { if (tab === 'semaforo' && !document.querySelector('dialog')) draw(); }, 30000);
}

// ---------- Alertas ----------
async function alertas() {
  const todas = $('#todas') ? $('#todas').checked : false;
  const { items } = await A('/api/admin/alertas' + (todas ? '?todas=1' : ''));
  main.innerHTML = `<div class="bar"><label style="flex-direction:row;align-items:center"><input type="checkbox" id="todas" ${todas ? 'checked' : ''}> Mostrar cerradas</label><span class="muted">${items.length} alerta(s)</span></div>
    <div class="scroll"><table><tr><th>Severidad</th><th>Alerta</th><th>Estado</th><th>Llamar</th><th></th></tr>
    ${items.map((a) => `<tr><td><span class="tag t-${a.severidad}">${a.severidad}</span></td><td>${esc(a.mensaje)}<div class="muted">${fmtDT(a.creada_en)}${a.comentario ? ' · “' + esc(a.comentario) + '”' : ''}</div></td>
      <td>${a.estado}</td><td>${callBtns(a.contactos)}</td>
      <td style="white-space:nowrap"><button class="sec" data-k="${esc(a.key)}" data-e="ATENDIDA">Atender</button> <button data-k="${esc(a.key)}" data-e="CERRADA">Cerrar</button></td></tr>`).join('') || '<tr><td colspan="5">Sin alertas 🎉</td></tr>'}</table></div>`;
  $('#todas').onchange = alertas;
  main.querySelectorAll('[data-k]').forEach((b) => (b.onclick = () => {
    const c = prompt(b.dataset.e === 'CERRADA' ? 'Comentario de cierre (ej. “Llamé al conductor, volvía por ruta alterna”)' : 'Comentario (opcional)', '');
    if (c === null) return;
    A('/api/admin/alertas/estado', { key: b.dataset.k, estado: b.dataset.e, comentario: c }).then(alertas);
  }));
}

// ---------- Vencimientos ----------
async function venc() {
  const { items, vehiculos } = await A('/api/admin/documentos');
  const adm = S.persona.rol === 'ADMIN';
  main.innerHTML = `<div class="bar">${adm ? '<button id="nv">➕ Registrar / renovar documento</button>' : ''}</div>
    <div class="scroll"><table><tr><th>Vehículo</th><th>Documento</th><th>Vence</th><th>Días</th><th>Estado</th><th>Archivo</th></tr>
    ${items.map((d) => `<tr><td><b>${esc(d.patente)}</b></td><td>${esc(d.tipo.replace(/_/g, ' '))}</td><td>${d.fecha_vencimiento}</td><td>${d.dias}</td>
      <td><span class="tag t-${d.estado}">${d.estado.replace('_', ' ')}</span></td><td>${d.archivo ? `<a href="${img(d.archivo)}" target="_blank">ver</a>` : '—'}</td></tr>`).join('')}</table></div>`;
  if (!adm) return;
  $('#nv').onclick = () => modal(`<h3>Documento del vehículo</h3><p class="muted">Si ya existe uno del mismo tipo, el nuevo lo reemplaza (el anterior queda en el historial).</p><div class="fg">
    <label>Vehículo<select id="v">${vehiculos.map((v) => `<option value="${v.id}">${esc(v.patente)}</option>`).join('')}</select></label>
    <label>Tipo<select id="t"><option value="REVISION_TECNICA">Revisión técnica</option><option value="PERMISO_CIRCULACION">Permiso de circulación</option><option value="SEGURO_SOAP">SOAP</option><option value="CERT_EMISIONES">Cert. emisiones</option><option value="OTRO">Otro</option></select></label>
    <label>Fecha de emisión<input type="date" id="fe"></label><label>Fecha de vencimiento<input type="date" id="fv"></label>
    <label class="full">Foto o imagen del documento<input type="file" id="ar" accept="image/*"></label></div>
    <p><button id="g">Guardar</button> <button class="sec" data-close>Cancelar</button></p>`, (d) => {
    d.querySelector('#g').onclick = async () => {
      const f = d.querySelector('#ar').files[0];
      await A('/api/admin/documentos', { id_vehiculo: d.querySelector('#v').value, tipo: d.querySelector('#t').value, fecha_emision: d.querySelector('#fe').value || null,
        fecha_vencimiento: d.querySelector('#fv').value, archivo: f ? await fileToDataURL(f) : null });
      d.close(); toast('Documento guardado'); venc();
    };
  });
}

// ---------- Combustible y boletas ----------
async function boletas() {
  const pend = $('#pf') ? $('#pf').checked : true;
  const { items } = await A('/api/admin/cargas' + (pend ? '?pendiente_fisica=1' : ''));
  main.innerHTML = `<div class="bar"><label style="flex-direction:row;align-items:center"><input type="checkbox" id="pf" ${pend ? 'checked' : ''}> Solo con boleta física pendiente</label></div>
    <div class="scroll"><table><tr><th>Fecha</th><th>Vehículo</th><th>Conductor</th><th>Litros</th><th>Monto</th><th>N° boleta</th><th>Foto</th><th>Estanque</th><th>Revisión</th><th></th></tr>
    ${items.map((c) => `<tr><td>${fmtDT(c.fecha_hora)}</td><td><b>${esc(c.patente)}</b></td><td>${esc(c.conductor)}</td><td>${c.litros}</td><td>${money(c.monto)}</td><td>${esc(c.numero_boleta)}</td>
      <td><a href="${img(c.foto_boleta)}" target="_blank"><img class="thumb" src="${img(c.foto_boleta)}"></a></td><td>${esc(c.nivel_estanque_llegada)}</td>
      <td><span class="tag t-${c.estado_revision}">${c.estado_revision}</span>${c.boleta_fisica_recibida ? '<br><span class="muted">📄 física recibida</span>' : '<br><span class="muted">sin boleta física</span>'}${c.observacion_revision ? `<div class="muted">${esc(c.observacion_revision)}</div>` : ''}</td>
      <td><button data-c="${c.id}">Revisar</button></td></tr>`).join('') || '<tr><td colspan="10">Sin registros</td></tr>'}</table></div>`;
  $('#pf').onchange = boletas;
  main.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => {
    const c = items.find((x) => x.id === b.dataset.c);
    modal(`<h3>Validación cruzada · ${esc(c.patente)}</h3><p>Compare la foto de la app con la boleta física firmada.</p>
      <img src="${img(c.foto_boleta)}" style="max-width:100%;max-height:320px;display:block;margin:auto">
      <p><b>${c.litros} L · ${money(c.monto)} · boleta ${esc(c.numero_boleta)}</b></p>
      <label><input type="checkbox" id="fr" ${c.boleta_fisica_recibida ? 'checked' : ''}> Boleta física firmada recibida en oficina</label>
      <p><textarea id="ob" rows="2" style="width:100%" placeholder="Observación (diferencia de monto, ilegible…)">${esc(c.observacion_revision || '')}</textarea></p>
      <p><button class="ok" id="v">✅ Validar</button> <button class="warn" id="o">⚠ Observar</button> <button class="sec" data-close>Cancelar</button></p>`, (d) => {
      const send = async (estado) => { await A(`/api/admin/cargas/${c.id}/validar`, { estado_revision: estado, boleta_fisica_recibida: d.querySelector('#fr').checked, observacion_revision: d.querySelector('#ob').value }); d.close(); toast('Guardado'); boletas(); };
      d.querySelector('#v').onclick = () => { if (!d.querySelector('#fr').checked) return toast('Marque que recibió la boleta física para validar'); send('VALIDADA'); };
      d.querySelector('#o').onclick = () => send('OBSERVADA');
    });
  }));
}

// ---------- Tarjetas ----------
async function tarjetas() {
  const d = await A('/api/admin/tarjetas');
  main.innerHTML = `<h3>Tarjetas de combustible</h3><div class="scroll"><table><tr><th>Tarjeta</th><th>Vehículo</th><th>Estado</th><th>Cupo</th><th></th></tr>
    ${d.tarjetas.map((t) => `<tr><td>•••• ${esc(t.numero_tarjeta)}</td><td>${esc(t.patente)}</td><td>${t.estado}</td><td>${money(t.cupo_mensual)}</td><td><button data-t="${t.id}">Registrar entrega</button></td></tr>`).join('')}</table></div>
    <h3>Entregas</h3><div class="scroll"><table><tr><th>Fecha</th><th>Tarjeta</th><th>Conductor</th><th>Devolución</th><th>Obs.</th><th></th></tr>
    ${d.entregas.map((e) => `<tr><td>${e.fecha_entrega}</td><td>•••• ${esc(e.numero_tarjeta)}</td><td>${esc(e.conductor)}</td><td>${e.fecha_devolucion || '<b>en poder del conductor</b>'}</td><td>${esc(e.observaciones)}</td>
      <td>${e.fecha_devolucion ? '' : `<button class="sec" data-d="${e.id}">Devolución</button>`}</td></tr>`).join('') || '<tr><td colspan="6">Sin entregas</td></tr>'}</table></div>`;
  main.querySelectorAll('[data-d]').forEach((b) => (b.onclick = async () => { await A(`/api/admin/tarjetas/devolucion/${b.dataset.d}`, {}); tarjetas(); }));
  main.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => modal(`<h3>Entrega de tarjeta</h3><div class="fg">
    <label class="full">Conductor<select id="c">${d.conductores.map((c) => `<option value="${c.id}">${esc(c.nombre_completo)}</option>`).join('')}</select></label>
    <label class="full">Observaciones<input id="o"></label></div><p><button id="g">Guardar</button> <button class="sec" data-close>Cancelar</button></p>`, (m) => {
    m.querySelector('#g').onclick = async () => { await A('/api/admin/tarjetas/entrega', { id_tarjeta: b.dataset.t, id_conductor: m.querySelector('#c').value, observaciones: m.querySelector('#o').value }); m.close(); tarjetas(); };
  })));
}

// ---------- Papel (bitácora de emergencia) ----------
async function papel() {
  const m = await A('/api/admin/maestros');
  const destinos = (await A('/api/admin/destinos')).items.filter((d) => d.activo);
  const conds = m.personas.filter((p) => p.rol === 'CONDUCTOR' && p.activo);
  const hoy = new Date().toISOString().slice(0, 10);
  main.innerHTML = `<h3>Transcribir bitácora de emergencia (papel)</h3><div class="card" style="max-width:760px"><div class="fg">
    <label>Fecha<input type="date" id="f" value="${hoy}"></label>
    <label>Vehículo<select id="v">${m.vehiculos.filter((v) => v.activo).map((v) => `<option value="${v.id}">${esc(v.patente)}</option>`).join('')}</select></label>
    <label>Conductor<select id="c">${conds.map((c) => `<option value="${c.id}">${esc(c.nombre_completo)}</option>`).join('')}</select></label>
    <label>Rol<select id="r"><option>Titular</option><option>Reemplazo</option><option>Apoyo</option></select></label>
    <label>KM inicial<input type="number" id="ki"></label><label>KM final<input type="number" id="kf"></label>
    <label>Hora salida<input type="time" id="hs"></label><label>Hora llegada<input type="time" id="hl"></label>
    <label>Origen<input id="or"></label>
    <label>Destino<select id="d"><option value="">—</option>${destinos.map((d) => `<option value="${d.id}">${esc(d.nombre)}</option>`).join('')}<option value="__o">Otro…</option></select></label>
    <label>Destino (si “Otro”)<input id="dn"></label><label>N° pasajeros<input type="number" id="pa" min="0"></label>
    <label class="full">Observaciones<input id="ob"></label>
    <label class="full">Foto de la hoja de papel<input type="file" id="ft" accept="image/*"></label></div>
    <p><button id="g">Guardar transcripción</button></p></div>`;
  $('#g').onclick = async () => {
    const f = $('#ft').files[0];
    if (!f) return toast('Suba la foto de la hoja de papel');
    const dsel = $('#d').value;
    await A('/api/admin/viajes/papel', {
      fecha: $('#f').value, id_vehiculo: $('#v').value, id_conductor: $('#c').value, rol_conductor: $('#r').value, km_inicial: $('#ki').value, km_final: $('#kf').value || null,
      hora_salida: $('#hs').value, hora_llegada: $('#hl').value || null, origen: $('#or').value, id_destino: dsel && dsel !== '__o' ? dsel : null,
      destino_texto_nuevo: dsel === '__o' ? $('#dn').value : '', pasajeros: $('#pa').value, observaciones: $('#ob').value, foto: await fileToDataURL(f),
    });
    toast('Transcripción guardada'); papel();
  };
}

// ---------- Bitácora ----------
async function bitacora() {
  const m = await A('/api/admin/maestros');
  const mes = (sessionStorage.getItem('bmes')) || new Date().toISOString().slice(0, 7);
  main.innerHTML = `<div class="bar noprint"><label>Mes<input type="month" id="mes" value="${mes}"></label>
    <label>Vehículo<select id="ve"><option value="">Todos</option>${m.vehiculos.map((v) => `<option value="${v.id}">${esc(v.patente)}</option>`).join('')}</select></label>
    ${S.persona.rol === 'ADMIN' ? `<label>Área<select id="ar"><option value="">Todas</option>${m.areas.map((a) => `<option value="${a.id}">${esc(a.nombre)}</option>`).join('')}</select></label>` : ''}
    <button id="ver">Ver</button><button class="ok" id="xl">⬇ Excel</button><button class="sec" id="pr">🖨 PDF / Imprimir</button></div><div id="out"></div>`;
  const q = () => `mes=${$('#mes').value}&vehiculo=${$('#ve').value}&area=${$('#ar') ? $('#ar').value : ''}`;
  const draw = async () => {
    try { sessionStorage.setItem('bmes', $('#mes').value); } catch (e) { /* */ }
    const d = await A('/api/admin/bitacora?' + q());
    const tot = d.rows.reduce((t, r) => ({ km: t.km + ((+r.km_final || 0) - (+r.km_inicial || 0) > 0 ? (+r.km_final) - (+r.km_inicial) : 0), l: t.l + (+r.litros || 0), v: t.v + (+r.valor || 0) }), { km: 0, l: 0, v: 0 });
    $('#out').innerHTML = `<h3 style="margin:6px 0">Bitácora ${d.mes}</h3><div class="scroll"><table><tr><th>Fecha</th><th>Patente</th><th>Conductor</th><th>Programa</th><th>Rol</th><th>Origen</th><th>Destino</th><th>KM Inicial</th><th>KM Final</th><th>Hora Salida</th><th>Hora Llegada</th><th>Pasajeros</th><th>Litros</th><th>Valor</th><th>N° Boleta</th><th>Firma</th><th>Observaciones</th></tr>
      ${d.rows.map((r) => `<tr><td>${r.fecha}</td><td>${esc(r.patente)}</td><td>${esc(r.conductor)}</td><td>${esc(r.programa)}</td><td>${esc(r.rol)}</td><td>${esc(r.origen)}</td><td>${esc(r.destino)}</td><td>${r.km_inicial}</td><td>${r.km_final}</td><td>${r.hora_salida}</td><td>${r.hora_llegada}</td><td>${r.pasajeros}</td><td>${r.litros}</td><td>${money(r.valor)}</td><td>${esc(r.boleta)}</td>
      <td>${r.firma ? `<img src="${img(r.firma)}" style="height:34px;background:#fff">` : ''}</td><td>${esc(r.observaciones)}${r.foto_respaldo_papel ? ` <a href="${img(r.foto_respaldo_papel)}" target="_blank" class="noprint">📎</a>` : ''}</td></tr>`).join('') || '<tr><td colspan="17">Sin registros en el período</td></tr>'}
      <tr><th colspan="7">Totales</th><th colspan="2">${tot.km.toLocaleString('es-CL')} km</th><th colspan="3"></th><th>${tot.l.toFixed(1)}</th><th>${money(tot.v)}</th><th colspan="3">${tot.l ? (tot.km / tot.l).toFixed(1) + ' km/l' : ''}</th></tr></table></div>`;
  };
  $('#ver').onclick = draw; $('#pr').onclick = async () => { await draw(); setTimeout(() => window.print(), 300); };
  $('#xl').onclick = async () => {
    const r = await A('/api/admin/bitacora.xlsx?' + q(), null, true);
    const blob = await r.blob(), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `bitacora_${$('#mes').value}.xlsx`; a.click();
  };
  draw();
}

// ---------- Maestros ----------
async function maestros() {
  const m = await A('/api/admin/maestros');
  const dest = (await A('/api/admin/destinos')).items;
  const adm = S.persona.rol === 'ADMIN';
  const porRev = dest.filter((d) => d.estado === 'POR_REVISAR' && d.activo);
  main.innerHTML = `
  ${porRev.length ? `<h3>Destinos nuevos por revisar</h3><div class="scroll"><table>${porRev.map((d) => `<tr><td>${esc(d.nombre)}</td><td><button class="ok" data-ok="${d.id}">Aprobar</button> <select data-mg="${d.id}"><option value="">Fusionar con…</option>${dest.filter((x) => x.estado === 'APROBADO' && x.activo).map((x) => `<option value="${x.id}">${esc(x.nombre)}</option>`).join('')}</select></td></tr>`).join('')}</table></div>` : ''}
  <h3>Vehículos y códigos QR</h3><div class="bar">${adm ? '<button id="nvh">➕ Nuevo vehículo</button>' : ''}<button class="sec" id="qr">🖨 Imprimir todos los QR</button></div>
  <div class="scroll"><table><tr><th>Patente</th><th>Vehículo</th><th>Área</th><th>KM</th><th>Código QR</th><th>Estado</th></tr>
  ${m.vehiculos.map((v) => `<tr><td><b>${esc(v.patente)}</b></td><td>${esc(v.marca)} ${esc(v.modelo)} ${v.anio || ''}</td><td>${esc(v.area)}</td><td>${(v.km_actual || 0).toLocaleString('es-CL')}</td><td><code>${esc(v.codigo_qr)}</code></td>
  <td>${adm ? `<select data-man="${v.id}"><option value="">Operativo</option><option value="MANTENCION" ${v.estado_manual === 'MANTENCION' ? 'selected' : ''}>En mantención</option></select>` : ''}</td></tr>`).join('')}</table></div>
  <h3>Contactos por área (a quién llamar)</h3><div class="scroll"><table><tr><th>Área</th><th>Tipo</th><th>Nombre</th><th>Teléfono</th><th>Horario</th><th>Orden</th><th></th></tr>
  ${m.contactos.map((c) => `<tr><td>${esc((m.areas.find((a) => a.id === c.id_area) || {}).nombre)}</td><td>${esc(c.tipo)}</td><td>${esc(c.nombre)}</td><td>${esc(c.telefono)}</td><td>${esc(c.horario)}</td><td>${c.orden}</td>
  <td>${adm ? `<button class="sec" data-ec="${c.id}">Editar</button>` : ''}</td></tr>`).join('')}</table></div>${adm ? '<p><button id="nc">➕ Nuevo contacto</button></p>' : ''}
  <h3>Personas</h3><div class="scroll"><table><tr><th>Nombre</th><th>Rol</th><th>Correo</th><th>Teléfono</th><th>Área</th><th>Lic. vence</th><th></th></tr>
  ${m.personas.map((p) => `<tr style="${p.activo ? '' : 'opacity:.5'}"><td>${esc(p.nombre_completo)}</td><td>${p.rol}</td><td>${esc(p.email)}</td><td>${esc(p.telefono)}</td><td>${esc((m.areas.find((a) => a.id === p.id_area) || {}).nombre)}</td><td>${p.licencia_vencimiento || ''}</td>
  <td>${adm ? `<button class="sec" data-ep="${p.id}">Editar</button>` : ''}</td></tr>`).join('')}</table></div>${adm ? '<p><button id="np">➕ Nueva persona</button></p>' : ''}`;

  main.querySelectorAll('[data-ok]').forEach((b) => (b.onclick = async () => { await A('/api/admin/destinos', { id: b.dataset.ok, estado: 'APROBADO' }); maestros(); }));
  main.querySelectorAll('[data-mg]').forEach((s) => (s.onchange = async () => { if (s.value) { await A('/api/admin/destinos', { id: s.dataset.mg, merge_en: s.value }); maestros(); } }));
  main.querySelectorAll('[data-man]').forEach((s) => (s.onchange = async () => { await A('/api/admin/vehiculos', { id: s.dataset.man, estado_manual: s.value || null }); toast('Actualizado'); }));
  $('#qr').onclick = async () => {
    const w = window.open('', '_blank');
    let html = '<html><head><title>QR vehículos</title><style>body{font-family:sans-serif}div.l{display:inline-block;width:6.5cm;margin:.3cm;padding:.3cm;border:1px dashed #888;text-align:center;page-break-inside:avoid}svg{width:5.4cm;height:5.4cm}h2{margin:2px}</style></head><body>';
    for (const v of m.vehiculos.filter((x) => x.activo)) {
      const svg = await (await A(`/api/admin/vehiculos/${v.id}/qr.svg`, null, true)).text();
      html += `<div class="l"><h2>${esc(v.patente)}</h2>${svg}<div>${esc(v.marca)} ${esc(v.modelo)}</div></div>`;
    }
    w.document.write(html + '</body></html>'); w.document.close(); setTimeout(() => w.print(), 400);
  };
  if (!adm) return;
  const areaOpts = (sel) => m.areas.map((a) => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('');
  $('#nvh').onclick = () => modal(`<h3>Nuevo vehículo</h3><div class="fg"><label>Patente<input id="p"></label><label>Área<select id="a">${areaOpts()}</select></label><label>Marca<input id="m"></label><label>Modelo<input id="mo"></label><label>Año<input id="an" type="number"></label><label>KM actual<input id="k" type="number"></label>
    <label class="full">Programa<select id="pg"><option value="">—</option>${m.programas.map((p) => `<option value="${p.id}">${esc(p.nombre)}</option>`).join('')}</select></label></div><p><button id="g">Guardar</button> <button class="sec" data-close>Cancelar</button></p>`, (d) => {
    d.querySelector('#g').onclick = async () => { await A('/api/admin/vehiculos', { patente: d.querySelector('#p').value, id_area: d.querySelector('#a').value, marca: d.querySelector('#m').value, modelo: d.querySelector('#mo').value, anio: d.querySelector('#an').value, km_actual: d.querySelector('#k').value, id_programa: d.querySelector('#pg').value }); d.close(); maestros(); };
  });
  const contactoModal = (c) => modal(`<h3>${c ? 'Editar' : 'Nuevo'} contacto</h3><div class="fg"><label>Área<select id="a" ${c ? 'disabled' : ''}>${areaOpts(c && c.id_area)}</select></label>
    <label>Tipo<select id="t">${['SUPERVISOR', 'ENCARGADO_FLOTA', 'EMERGENCIA', 'TALLER'].map((t) => `<option ${c && c.tipo === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <label>Persona<select id="p"><option value="">—</option>${m.personas.filter((p) => p.rol !== 'CONDUCTOR').map((p) => `<option value="${p.id}" ${c && c.id_persona === p.id ? 'selected' : ''}>${esc(p.nombre_completo)}</option>`).join('')}</select></label>
    <label>Teléfono<input id="te" value="${esc(c ? c.telefono : '')}" placeholder="+569…"></label><label>Horario<input id="h" value="${esc(c ? c.horario : '')}"></label><label>Orden<input id="o" type="number" value="${c ? c.orden : 1}"></label></div>
    <p><button id="g">Guardar</button> <button class="sec" data-close>Cancelar</button></p>`, (d) => {
    d.querySelector('#g').onclick = async () => { await A('/api/admin/contactos', { ...(c ? { id: c.id } : { id_area: d.querySelector('#a').value }), tipo: d.querySelector('#t').value, id_persona: d.querySelector('#p').value || null, telefono: d.querySelector('#te').value, horario: d.querySelector('#h').value, orden: d.querySelector('#o').value }); d.close(); maestros(); };
  });
  $('#nc').onclick = () => contactoModal(null);
  main.querySelectorAll('[data-ec]').forEach((b) => (b.onclick = () => contactoModal(m.contactos.find((x) => x.id === b.dataset.ec))));
  const personaModal = (p) => modal(`<h3>${p ? 'Editar' : 'Nueva'} persona</h3><div class="fg"><label class="full">Nombre completo<input id="n" value="${esc(p ? p.nombre_completo : '')}"></label>
    <label>Correo (usuario)<input id="e" value="${esc(p ? p.email : '')}"></label><label>Teléfono<input id="te" value="${esc(p ? p.telefono : '')}"></label>
    <label>Rol<select id="r">${['CONDUCTOR', 'SUPERVISOR', 'ADMIN'].map((r) => `<option ${p && p.rol === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label><label>Área<select id="a">${areaOpts(p && p.id_area)}</select></label>
    <label>RUT<input id="ru" value="${esc(p ? p.rut : '')}"></label><label>Vencimiento licencia<input id="li" type="date" value="${p ? p.licencia_vencimiento || '' : ''}"></label>
    <label>${p ? 'Nuevo PIN (opcional)' : 'PIN (4-8 dígitos)'}<input id="pi" type="password" inputmode="numeric"></label>${p ? `<label>Activo<select id="ac"><option value="1" ${p.activo ? 'selected' : ''}>Sí</option><option value="0" ${p.activo ? '' : 'selected'}>No</option></select></label>` : ''}</div>
    <p><button id="g">Guardar</button> <button class="sec" data-close>Cancelar</button></p>`, (d) => {
    d.querySelector('#g').onclick = async () => {
      const body = { nombre_completo: d.querySelector('#n').value, email: d.querySelector('#e').value, telefono: d.querySelector('#te').value, rol: d.querySelector('#r').value, id_area: d.querySelector('#a').value, rut: d.querySelector('#ru').value, licencia_vencimiento: d.querySelector('#li').value, pin: d.querySelector('#pi').value || undefined };
      if (p) { body.id = p.id; body.activo = d.querySelector('#ac').value === '1'; }
      await A('/api/admin/personas', body); d.close(); maestros();
    };
  });
  $('#np').onclick = () => personaModal(null);
  main.querySelectorAll('[data-ep]').forEach((b) => (b.onclick = () => personaModal(m.personas.find((x) => x.id === b.dataset.ep))));
}

render();

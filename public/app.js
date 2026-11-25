'use strict';
/* App del conductor — offline-first. Todo se guarda primero en IndexedDB y se sincroniza cuando hay señal. */

// ---------- utilidades ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const pad = (n) => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localDT = (d = new Date()) => `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }) : '—');
const fmtDT = (iso) => (iso ? new Date(iso).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
function toast(msg, ms = 3200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
}

// ---------- IndexedDB ----------
const DB = {
  db: null,
  open() {
    return new Promise((ok, fail) => {
      const r = indexedDB.open('flota', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('meta');
        d.createObjectStore('viajes', { keyPath: 'id' });
        d.createObjectStore('cargas', { keyPath: 'id' });
      };
      r.onsuccess = () => { DB.db = r.result; ok(); };
      r.onerror = () => fail(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((ok, fail) => {
      const t = DB.db.transaction(store, mode);
      const res = fn(t.objectStore(store));
      t.oncomplete = () => ok(res && res.result !== undefined ? res.result : undefined);
      t.onerror = () => fail(t.error);
    });
  },
  get: (s, k) => DB.tx(s, 'readonly', (o) => o.get(k)),
  all: (s) => DB.tx(s, 'readonly', (o) => o.getAll()),
  put: (s, v, k) => DB.tx(s, 'readwrite', (o) => o.put(v, k)),
  del: (s, k) => DB.tx(s, 'readwrite', (o) => o.delete(k)),
};

// ---------- estado ----------
let session = null; // {token, persona}
let boot = null;    // catálogos descargados
const blank = { viajes: [], cargas: [] };

async function loadState() {
  session = (await DB.get('meta', 'session')) || null;
  boot = (await DB.get('meta', 'boot')) || null;
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    method: opts.body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || `Error ${r.status}`); e.status = r.status; throw e; }
  return data;
}

// ---------- sincronización ----------
let syncing = false;
async function pendientes() {
  const [v, c] = await Promise.all([DB.all('viajes'), DB.all('cargas')]);
  return { viajes: v.filter((x) => x._dirty), cargas: c.filter((x) => x._dirty) };
}
async function sync(showMsg = false) {
  if (syncing || !session || !navigator.onLine) return updateNet();
  syncing = true;
  try {
    const p = await pendientes();
    if (p.viajes.length || p.cargas.length) {
      const res = await api('/api/sync', { body: { viajes: p.viajes, cargas: p.cargas } });
      for (const [store, list] of [['viajes', p.viajes], ['cargas', p.cargas]]) {
        for (const sent of list) {
          if (!res.aceptados[store].includes(sent.id)) continue;
          const cur = await DB.get(store, sent.id);
          if (cur && cur._rev === sent._rev) { cur._dirty = false; await DB.put(store, cur); }
        }
      }
      if (res.errores.length) console.warn('Errores de sync', res.errores);
    }
    boot = await api('/api/bootstrap');
    await DB.put('meta', boot, 'boot');
    if (showMsg) toast('✅ Sincronizado');
  } catch (e) {
    if (e.status === 401) { session = null; await DB.del('meta', 'session'); route('login'); toast('Sesión vencida: ingrese de nuevo (sus datos pendientes se conservan)'); }
    else if (showMsg) toast('No se pudo sincronizar: ' + e.message);
  } finally { syncing = false; updateNet(); }
}
async function updateNet() {
  const el = $('#net');
  const p = await pendientes().catch(() => blank);
  const n = p.viajes.length + p.cargas.length;
  el.className = 'pill ' + (navigator.onLine ? 'on' : 'off');
  el.textContent = (navigator.onLine ? '🟢 En línea' : '🟠 Sin señal') + (n ? ` · ${n} pend.` : '');
}
window.addEventListener('online', () => sync());
window.addEventListener('offline', updateNet);
setInterval(() => sync(), 30000);

// ---------- datos derivados ----------
const veh = (id) => boot.vehiculos.find((v) => v.id === id);
const vehByQR = (code) => boot.vehiculos.find((v) => v.codigo_qr === code.trim());
const dest = (id) => (boot.destinos.find((d) => d.id === id) || {}).nombre;
async function allViajes() {
  const local = await DB.all('viajes');
  const map = new Map();
  for (const v of [...boot.viajes_abiertos, ...boot.mis_viajes]) map.set(v.id, v);
  for (const v of local) map.set(v.id, v); // lo local manda
  return [...map.values()];
}
async function openTrip(idVehiculo) {
  return (await allViajes()).filter((v) => v.id_vehiculo === idVehiculo && v.estado_viaje === 'ABIERTO')
    .sort((a, b) => b.hora_salida.localeCompare(a.hora_salida))[0] || null;
}
async function kmActual(idVehiculo) {
  let km = veh(idVehiculo).km_actual || 0;
  for (const v of await allViajes()) {
    if (v.id_vehiculo !== idVehiculo || v.estado_viaje === 'ANULADO') continue;
    km = Math.max(km, v.km_final || 0, v.km_inicial || 0);
  }
  return km;
}
async function saveRec(store, rec) {
  const prev = await DB.get(store, rec.id);
  rec._dirty = true;
  rec._rev = ((prev && prev._rev) || 0) + 1;
  await DB.put(store, rec);
  updateNet();
  sync();
}

// ---------- firma y foto ----------
function sigPad(canvas) {
  const ctx = canvas.getContext('2d');
  const size = () => { const r = canvas.getBoundingClientRect(); canvas.width = r.width * 2; canvas.height = r.height * 2; ctx.scale(2, 2); ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.strokeStyle = '#000'; };
  size();
  let draw = false, dirty = false;
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', (e) => { draw = true; canvas.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pos(e)); });
  canvas.addEventListener('pointermove', (e) => { if (!draw) return; ctx.lineTo(...pos(e)); ctx.stroke(); dirty = true; });
  const end = () => { draw = false; };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  return {
    clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; },
    isEmpty: () => !dirty,
    data: () => canvas.toDataURL('image/png'),
  };
}
function resizeImage(file, max = 1280, q = 0.72) {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      ok(c.toDataURL('image/jpeg', q));
    };
    img.onerror = () => fail(new Error('No se pudo leer la foto'));
    img.src = URL.createObjectURL(file);
  });
}

// ---------- cámara / QR ----------
let stream = null;
function stopCam() { if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } }
async function startScan(video, onCode) {
  stopCam();
  stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  video.srcObject = stream; await video.play();
  const det = 'BarcodeDetector' in window ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
  const cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
  let alive = true;
  const loop = async () => {
    if (!alive || !stream) return;
    try {
      if (video.readyState >= 2) {
        let code = null;
        if (det) { const r = await det.detect(video); if (r[0]) code = r[0].rawValue; }
        else {
          const w = 480, h = Math.round((video.videoHeight / video.videoWidth) * w) || 360;
          cv.width = w; cv.height = h; cx.drawImage(video, 0, 0, w, h);
          const r = jsQR(cx.getImageData(0, 0, w, h).data, w, h); if (r) code = r.data;
        }
        if (code && (await onCode(code)) === true) { alive = false; return; }
      }
    } catch (e) { /* frame inválido */ }
    setTimeout(loop, 250);
  };
  loop();
  return () => { alive = false; stopCam(); };
}

// ---------- ruteo ----------
const view = $('#view');
let cleanup = null;
function route(name, arg) {
  if (cleanup) { cleanup(); cleanup = null; }
  stopCam();
  window.scrollTo(0, 0);
  ({ login, home, scan, salida, llegada, combustible, viajes, llamar, otroViaje, pin })[name](arg);
}
const title = (t) => { $('#title').textContent = t; };
const back = (to = 'home') => `<button class="sec" data-go="${to}" style="margin-top:12px">← Volver</button>`;
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-go]');
  if (g) route(g.dataset.go, g.dataset.arg);
});

// ---------- pantallas ----------
function login() {
  title('Flota');
  view.innerHTML = `<div class="card"><h2>Ingresar</h2>
    <label>Correo</label><input id="em" type="email" autocomplete="username" inputmode="email">
    <label>PIN</label><input id="pn" type="password" inputmode="numeric" autocomplete="current-password">
    <div id="er" class="err"></div>
    <button id="ok" style="margin-top:14px">Entrar</button>
    <p class="muted">La primera vez necesita internet para descargar vehículos y destinos.</p></div>`;
  $('#ok').onclick = async () => {
    try {
      const r = await api('/api/login', { body: { email: $('#em').value.trim(), pin: $('#pn').value } });
      session = r; await DB.put('meta', session, 'session');
      boot = await api('/api/bootstrap'); await DB.put('meta', boot, 'boot');
      route('home'); sync();
    } catch (e) { $('#er').textContent = navigator.onLine ? e.message : 'Sin internet: no se puede ingresar la primera vez'; }
  };
}

async function home() {
  title(boot.persona.nombre_completo.split(' ')[0] + ' · Flota');
  const mine = (await allViajes()).filter((v) => v.estado_viaje === 'ABIERTO' && v.id_conductor === session.persona.id);
  const p = await pendientes();
  const old = [...p.viajes, ...p.cargas].some((x) => Date.now() - new Date(x.creado_en).getTime() > 86400000);
  view.innerHTML = `
    ${old ? '<div class="alert warn">⚠ Tiene registros sin enviar hace más de 24 h. Conéctese a internet.</div>' : ''}
    ${mine.map((t) => `<div class="card" style="border-color:var(--bad)"><b>🔴 En ruta: ${esc(veh(t.id_vehiculo).patente)}</b>
      <div class="muted">Salió ${fmtDT(t.hora_salida)} → ${esc(dest(t.id_destino) || t.destino_texto_nuevo || '')}</div>
      <button class="red" data-go="llegada" data-arg="${t.id}" style="margin-top:10px">Registrar llegada</button></div>`).join('')}
    <button class="big" data-go="scan" data-arg="salida">📷 Escanear vehículo<br><small>salida / llegada</small></button>
    <div class="grid" style="margin-top:10px">
      <button class="big sec" data-go="scan" data-arg="combustible">⛽ Combustible</button>
      <button class="big sec" data-go="llamar">📞 Llamar supervisor</button>
      <button class="big sec" data-go="viajes">📖 Mis viajes</button>
      <button class="big sec" id="syncb">🔄 Sincronizar</button>
    </div>
    <p class="muted" style="text-align:center;margin-top:18px">
      <a href="#" data-go="pin">Cambiar PIN</a> · <a href="#" id="out">Salir</a></p>`;
  $('#syncb').onclick = () => sync(true);
  $('#out').onclick = async (e) => {
    e.preventDefault();
    const q = await pendientes();
    if ((q.viajes.length || q.cargas.length) && !confirm('Hay registros sin enviar. Si sale, se conservan en este teléfono pero debe ingresar de nuevo. ¿Salir?')) return;
    session = null; await DB.del('meta', 'session'); route('login');
  };
}

// Escáner (mode: 'salida' | 'combustible') — también permite elegir manualmente
async function scan(mode) {
  title('Escanear vehículo');
  view.innerHTML = `<div class="card"><video id="v" playsinline muted></video>
    <p class="muted" id="msg">Apunte al código QR pegado en el vehículo…</p></div>
    <div class="card"><label>¿Sin cámara o QR dañado? Elija el vehículo:</label>
    <select id="man"><option value="">— seleccionar patente —</option>
    ${boot.vehiculos.filter((v) => session.persona.rol !== 'CONDUCTOR' || v.id_area === session.persona.id_area || true)
      .map((v) => `<option value="${v.id}">${esc(v.patente)} · ${esc(v.marca)} ${esc(v.modelo)}</option>`).join('')}</select>
    <button id="go" style="margin-top:10px" class="sec">Continuar sin QR</button></div>${back()}`;
  const go = async (v, sinQR) => { route(mode === 'combustible' ? 'combustible' : 'salida', { id: v.id, sinQR }); return true; };
  $('#go').onclick = () => { const v = veh($('#man').value); if (v) go(v, true); else toast('Elija un vehículo'); };
  try {
    const stop = await startScan($('#v'), async (code) => {
      const v = vehByQR(code);
      if (!v) { $('#msg').textContent = 'Código no reconocido: ' + code.slice(0, 30); return false; }
      if (navigator.vibrate) navigator.vibrate(80);
      return go(v, false);
    });
    cleanup = stop;
  } catch (e) { $('#msg').textContent = 'No se pudo abrir la cámara (' + e.name + '). Use la lista de abajo.'; }
}

function docAlerts(v) {
  const hoy = localDate();
  return v.documentos.map((d) => {
    const dias = Math.round((new Date(d.fecha_vencimiento + 'T00:00') - new Date(hoy + 'T00:00')) / 86400000);
    const nombre = d.tipo.replace(/_/g, ' ').toLowerCase();
    if (dias < 0) return { bad: true, txt: `${nombre} VENCIDA hace ${-dias} día(s)` };
    if (dias <= 30) return { bad: false, txt: `${nombre} vence en ${dias} día(s)` };
    return null;
  }).filter(Boolean);
}

async function salida(arg) {
  const v = veh(arg.id);
  title('Salida · ' + v.patente);
  const abierto = await openTrip(v.id);
  const alertas = docAlerts(v);
  const bloqueado = boot.config.bloquear_salida_doc_vencido && alertas.some((a) => a.bad);
  const km = await kmActual(v.id);
  const area = boot.areas.find((a) => a.id === v.id_area), prog = boot.programas.find((p) => p.id === v.id_programa);
  const yo = session.persona.id;
  const conductores = boot.personas.filter((p) => p.id_area === v.id_area || p.id === yo);
  if (abierto) {
    const quien = boot.personas.find((p) => p.id === abierto.id_conductor);
    const mio = abierto.id_conductor === yo;
    view.innerHTML = `<div class="card"><h2>${esc(v.patente)} · ${mio ? 'su viaje está abierto' : 'en uso'}</h2>
      <div class="alert warn">Este vehículo tiene un viaje abierto desde ${fmtDT(abierto.hora_salida)}${quien ? ' (' + esc(quien.nombre_completo) + ')' : ''}.</div>
      <button class="red" data-go="llegada" data-arg="${abierto.id}">Registrar su llegada / cerrar viaje</button></div>${back()}`;
    return;
  }
  const dopts = boot.destinos.map((d) => `<option value="${d.id}">${esc(d.nombre)}</option>`).join('');
  view.innerHTML = `<div class="card">
    <h2>${esc(v.patente)} <span class="muted">${esc(v.marca)} ${esc(v.modelo)}</span></h2>
    <span class="chip">${esc(area ? area.nombre : '')}</span><span class="chip">${esc(prog ? prog.nombre : '')}</span>
    ${alertas.map((a) => `<div class="alert ${a.bad ? 'bad' : 'warn'}">${a.bad ? '⛔' : '⚠'} ${esc(a.txt)}</div>`).join('')}
    ${bloqueado ? '<div class="alert bad">Salida bloqueada por documentos vencidos. Llame a su supervisor.</div>' : ''}
    <label>Conductor</label><select id="cond">${conductores.map((p) => `<option value="${p.id}" ${p.id === yo ? 'selected' : ''}>${esc(p.nombre_completo)}</option>`).join('')}</select>
    <label>Rol</label><select id="rol"><option>Titular</option><option>Reemplazo</option><option>Apoyo</option></select>
    <label>KM inicial</label><input id="km" type="number" inputmode="numeric" value="${arg.km ?? km}">
    <label>Hora de salida</label><input id="hs" type="datetime-local" value="${localDT()}">
    <label>Origen</label><input id="or" value="${esc(arg.origen || (area ? area.nombre : ''))}">
    <label>Destino</label><select id="de">${dopts}<option value="__otro">➕ Otro destino…</option></select>
    <input id="dn" placeholder="Escriba el destino" style="display:none;margin-top:8px">
    <label>N° de pasajeros (obligatorio)</label><input id="pa" type="number" inputmode="numeric" min="0" placeholder="0 si va solo">
    <label>Firma del conductor</label><canvas class="sig" id="sg"></canvas>
    <button class="sec" id="cl" style="margin-top:6px;padding:8px">Borrar firma</button>
    <div id="er" class="err"></div>
    <button id="ok" style="margin-top:12px" ${bloqueado ? 'disabled' : ''}>Guardar salida</button></div>${back()}`;
  const sg = sigPad($('#sg'));
  $('#cl').onclick = () => sg.clear();
  $('#de').onchange = () => { $('#dn').style.display = $('#de').value === '__otro' ? 'block' : 'none'; };
  $('#ok').onclick = async () => {
    const err = (m) => { $('#er').textContent = m; };
    const kmI = parseInt($('#km').value, 10), pas = $('#pa').value;
    if (isNaN(kmI)) return err('Ingrese el KM inicial');
    if (pas === '' || parseInt(pas, 10) < 0) return err('Ingrese el N° de pasajeros');
    if (sg.isEmpty()) return err('Falta la firma');
    const otro = $('#de').value === '__otro';
    if (otro && !$('#dn').value.trim()) return err('Escriba el destino');
    if (kmI < km && !confirm(`El KM (${kmI}) es menor al último registrado (${km}). ¿Confirmar?`)) return;
    const rec = {
      id: uuid(), id_vehiculo: v.id, id_conductor: $('#cond').value, fecha: $('#hs').value.slice(0, 10), rol_conductor: $('#rol').value,
      origen: $('#or').value.trim(), id_destino: otro ? null : $('#de').value, destino_texto_nuevo: otro ? $('#dn').value.trim() : '',
      km_inicial: kmI, hora_salida: new Date($('#hs').value).toISOString(), pasajeros: parseInt(pas, 10), firma_salida: sg.data(),
      estado_viaje: 'ABIERTO', observaciones: arg.sinQR ? 'Vehículo seleccionado manualmente (sin QR)' : '', origen_registro: 'APP',
      creado_offline: !navigator.onLine, creado_en: new Date().toISOString(), sin_qr: !!arg.sinQR,
    };
    await saveRec('viajes', rec);
    toast(navigator.onLine ? '✅ Salida registrada' : '✅ Guardada en el teléfono; se enviará sola cuando haya señal', 4500);
    route('home');
  };
}

async function llegada(id) {
  const t = (await allViajes()).find((x) => x.id === id);
  const v = veh(t.id_vehiculo);
  title('Llegada · ' + v.patente);
  const otroConductor = t.id_conductor !== session.persona.id;
  view.innerHTML = `<div class="card"><h2>${esc(v.patente)} — llegada</h2>
    <div class="muted">Salida ${fmtDT(t.hora_salida)} · KM ${t.km_inicial} · ${esc(dest(t.id_destino) || t.destino_texto_nuevo || '')} · ${t.pasajeros} pas.</div>
    ${otroConductor ? '<div class="alert warn">Está cerrando un viaje de otro conductor. Quedará anotado en observaciones.</div>' : ''}
    <label>KM final</label><input id="kf" type="number" inputmode="numeric" min="${t.km_inicial}" placeholder="Mayor o igual a ${t.km_inicial}">
    <label>Hora de llegada</label><input id="hl" type="datetime-local" value="${localDT()}">
    <label>Observaciones (opcional)</label><textarea id="ob" rows="2"></textarea>
    <label class="row" style="color:var(--ink)"><input id="cb" type="checkbox" style="width:auto"> Cargué combustible en este viaje</label>
    <label>Firma del conductor</label><canvas class="sig" id="sg"></canvas>
    <button class="sec" id="cl" style="margin-top:6px;padding:8px">Borrar firma</button>
    <div id="er" class="err"></div>
    <button id="ok" class="green" style="margin-top:12px">Guardar llegada</button></div>${back()}`;
  const sg = sigPad($('#sg'));
  $('#cl').onclick = () => sg.clear();
  $('#ok').onclick = async () => {
    const err = (m) => { $('#er').textContent = m; };
    const kf = parseInt($('#kf').value, 10);
    if (isNaN(kf)) return err('Ingrese el KM final');
    if (kf < t.km_inicial) return err('El KM final no puede ser menor al inicial');
    if (new Date($('#hl').value) < new Date(t.hora_salida)) return err('La hora de llegada es anterior a la salida');
    if (sg.isEmpty()) return err('Falta la firma');
    if (kf - t.km_inicial > boot.config.km_max_viaje && !confirm(`Recorrido de ${kf - t.km_inicial} km. ¿Es correcto?`)) return;
    const rec = {
      ...(await DB.get('viajes', t.id) || t), km_final: kf, hora_llegada: new Date($('#hl').value).toISOString(), firma_llegada: sg.data(),
      estado_viaje: 'CERRADO',
      observaciones: [t.observaciones, $('#ob').value.trim(), otroConductor ? `Cerrado por ${session.persona.nombre_completo}` : ''].filter(Boolean).join(' · '),
    };
    await saveRec('viajes', rec);
    toast(navigator.onLine ? '✅ Llegada registrada' : '✅ Guardada en el teléfono', 3500);
    if ($('#cb').checked) route('combustible', { id: v.id, viaje: t.id });
    else route('otroViaje', { id: v.id, km: kf, origen: dest(t.id_destino) || t.destino_texto_nuevo });
  };
}

function otroViaje(a) {
  title('Listo');
  view.innerHTML = `<div class="card"><h2>✅ Viaje cerrado</h2><p>¿Continúa con otro viaje con este vehículo?</p>
    <button id="si">Sí, registrar nueva salida</button>
    <button class="sec" data-go="home" style="margin-top:10px">No, terminar</button></div>`;
  $('#si').onclick = () => route('salida', { id: a.id, km: a.km, origen: a.origen });
}

async function combustible(arg) {
  const v = veh(arg.id);
  title('Combustible · ' + v.patente);
  const km = await kmActual(v.id);
  view.innerHTML = `<div class="card"><h2>⛽ ${esc(v.patente)}</h2>
    <label>Litros</label><input id="li" type="number" inputmode="decimal" step="0.01">
    <label>Monto ($)</label><input id="mo" type="number" inputmode="numeric">
    <label>N° de boleta</label><input id="bo" inputmode="numeric">
    <label>Foto de la boleta (obligatoria)</label>
    <input id="ph" type="file" accept="image/*" capture="environment">
    <img id="pv" class="photo-prev" hidden>
    <label>¿Con cuánto estanque queda el vehículo?</label>
    <select id="ni"><option value="">— seleccionar —</option><option>1/4</option><option>1/2</option><option>3/4</option><option>Lleno</option></select>
    <div id="wn" class="alert warn" hidden>⚠ Debe mantenerse con mínimo 3/4 de estanque. Se avisará al supervisor.</div>
    <label>KM al cargar</label><input id="kc" type="number" inputmode="numeric" value="${km}">
    <div id="er" class="err"></div>
    <button id="ok" style="margin-top:12px">Guardar carga</button>
    <p class="muted">Recuerde entregar la boleta física firmada en la oficina.</p></div>${back()}`;
  let foto = null;
  $('#ph').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { foto = await resizeImage(f); $('#pv').src = foto; $('#pv').hidden = false; } catch (er) { toast(er.message); }
  };
  $('#ni').onchange = () => { $('#wn').hidden = ['3/4', 'Lleno', ''].includes($('#ni').value); };
  $('#ok').onclick = async () => {
    const err = (m) => { $('#er').textContent = m; };
    const li = parseFloat($('#li').value), mo = parseInt($('#mo').value, 10);
    if (!(li > 0 && li < 400)) return err('Revise los litros');
    if (!(mo > 0)) return err('Ingrese el monto');
    if (!$('#bo').value.trim()) return err('Ingrese el N° de boleta');
    if (!foto) return err('La foto de la boleta es obligatoria');
    if (!$('#ni').value) return err('Indique el nivel de estanque');
    const abierto = arg.viaje || ((await openTrip(v.id)) || {}).id || null;
    const rec = {
      id: uuid(), id_vehiculo: v.id, id_conductor: session.persona.id, id_viaje: abierto, fecha_hora: new Date().toISOString(),
      litros: li, monto: mo, numero_boleta: $('#bo').value.trim(), foto_boleta: foto, nivel_estanque_llegada: $('#ni').value,
      km_al_cargar: parseInt($('#kc').value, 10) || null, creado_offline: !navigator.onLine, creado_en: new Date().toISOString(),
    };
    await saveRec('cargas', rec);
    toast('✅ Carga guardada. Entregue la boleta física en la oficina.', 4500);
    route('home');
  };
}

async function viajes() {
  title('Mis viajes');
  const list = (await allViajes()).filter((v) => v.id_conductor === session.persona.id && v.estado_viaje !== 'ANULADO')
    .sort((a, b) => b.hora_salida.localeCompare(a.hora_salida)).slice(0, 40);
  const local = Object.fromEntries((await DB.all('viajes')).map((x) => [x.id, x]));
  view.innerHTML = `<div class="card"><h2>Últimos 7 días</h2>${list.length ? list.map((v) => `
    <div class="list-item"><div><b>${esc(veh(v.id_vehiculo).patente)}</b> · ${fmtDT(v.hora_salida)}<div class="muted">${esc(dest(v.id_destino) || v.destino_texto_nuevo || '')} · ${v.km_inicial}→${v.km_final ?? '…'} km</div></div>
    <div>${v.estado_viaje === 'ABIERTO' ? '🔴' : '✔'} ${local[v.id] && local[v.id]._dirty ? '⏳' : ''}</div></div>`).join('') : '<p class="muted">Sin viajes recientes.</p>'}
    <p class="muted">⏳ = guardado en el teléfono, pendiente de enviar.</p></div>${back()}`;
}

function llamar() {
  title('Llamar al supervisor');
  const mine = session.persona.id_area;
  const areaSel = boot.areas.map((a) => `<option value="${a.id}" ${a.id === mine ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('');
  view.innerHTML = `<div class="card"><h2>📞 Contactos</h2><label>Área</label><select id="ar">${areaSel}</select><div id="ls"></div></div>${back()}`;
  const draw = () => {
    const cs = boot.contactos[$('#ar').value] || [];
    $('#ls').innerHTML = cs.length ? cs.map((c) => `<a class="call" href="tel:${esc(c.telefono)}">📞 ${esc(c.nombre || c.tipo)} <small>(${esc(c.tipo.replace('_', ' ').toLowerCase())} · ${esc(c.horario || '')})<br>${esc(c.telefono)}</small></a>`).join('') : '<p class="muted">Sin contactos para esta área.</p>';
  };
  $('#ar').onchange = draw; draw();
}

function pin() {
  title('Cambiar PIN');
  view.innerHTML = `<div class="card"><h2>Cambiar PIN</h2><label>PIN actual</label><input id="a" type="password" inputmode="numeric">
    <label>PIN nuevo (4 a 8 dígitos)</label><input id="b" type="password" inputmode="numeric"><div id="er" class="err"></div>
    <button id="ok" style="margin-top:12px">Guardar</button></div>${back()}`;
  $('#ok').onclick = async () => {
    try { await api('/api/cambiar-pin', { body: { pin_actual: $('#a').value, pin_nuevo: $('#b').value } }); toast('PIN actualizado'); route('home'); }
    catch (e) { $('#er').textContent = navigator.onLine ? e.message : 'Necesita internet para cambiar el PIN'; }
  };
}

// ---------- arranque ----------
(async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  await DB.open();
  await loadState();
  updateNet();
  if (session && boot) { route('home'); sync(); } else route('login');
})();

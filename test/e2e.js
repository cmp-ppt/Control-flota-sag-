// Prueba en navegador real (Chromium): login, salida OFFLINE, sincronización al volver la señal, llegada, combustible, panel.
const { chromium } = require('playwright');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flota-e2e-'));
const app = require('../server/index');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const ok = (c, m) => { if (!c) throw new Error('FALLO: ' + m); console.log('✔', m); };

(async () => {
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, serviceWorkers: 'allow' });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => { console.error('pageerror', e.message); process.exitCode = 1; });

  await page.goto(base + '/');
  await page.fill('#em', 'cond1@ejemplo.cl'); await page.fill('#pn', '1234'); await page.click('#ok');
  await page.waitForSelector('text=Escanear vehículo');
  ok(true, 'login conductor y descarga de catálogos');
  await page.waitForTimeout(800); // service worker + caché

  // ---- SIN SEÑAL ----
  await ctx.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.click('text=Escanear vehículo');
  await page.waitForSelector('#man');
  await page.selectOption('#man', { index: 1 });
  await page.click('#go');
  await page.waitForSelector('text=Guardar salida');
  await page.fill('#pa', '3');
  // firma
  await page.locator('#sg').scrollIntoViewIfNeeded(); const box = await page.locator('#sg').boundingBox();
  await page.mouse.move(box.x + 20, box.y + 40); await page.mouse.down(); await page.mouse.move(box.x + 120, box.y + 90, { steps: 8 }); await page.mouse.up();
  await page.click('#ok');
  await page.waitForSelector('text=Registrar llegada');
  ok(true, 'salida registrada SIN internet (queda "En ruta")');
  ok((await page.textContent('#net')).includes('1 pend'), 'indicador muestra 1 registro pendiente');

  // el panel aún no lo ve
  const adminTok = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@ejemplo.cl', pin: '1234' }) })).json()).token;
  const estado = async () => (await (await fetch(base + '/api/admin/estado', { headers: { Authorization: 'Bearer ' + adminTok } })).json()).items.find((i) => i.patente === 'ABCD12').estado;
  ok((await estado()) === 'DISPONIBLE', 'servidor aún no sabe de la salida (sin conexión)');

  // llegada también sin señal
  await page.click('text=Registrar llegada');
  await page.fill('#kf', '45300');
  await page.locator('#sg').scrollIntoViewIfNeeded(); const b2 = await page.locator('#sg').boundingBox();
  await page.mouse.move(b2.x + 20, b2.y + 40); await page.mouse.down(); await page.mouse.move(b2.x + 100, b2.y + 80, { steps: 6 }); await page.mouse.up();
  await page.click('#ok');
  await page.waitForSelector('text=Viaje cerrado');
  await page.click('text=No, terminar');
  ok((await page.textContent('#net')).includes('1 pend'), 'llegada guardada sin internet (mismo viaje, 1 pendiente)');

  // ---- VUELVE LA SEÑAL ----
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => !document.querySelector('#net').textContent.includes('pend'), null, { timeout: 15000 });
  ok(true, 'sincronización automática al volver la señal');
  ok((await estado()) === 'DISPONIBLE', 'servidor recibió el viaje ya cerrado');
  const viajes = await (await fetch(base + '/api/admin/viajes', { headers: { Authorization: 'Bearer ' + adminTok } })).json();
  ok(viajes.items.length === 1 && viajes.items[0].estado_viaje === 'CERRADO' && viajes.items[0].pasajeros === 3 && viajes.items[0].creado_offline === true, 'viaje en servidor: cerrado, 3 pasajeros, marcado como creado offline');

  // ---- combustible con foto ----
  await page.click('text=Combustible');
  await page.waitForSelector('#man');
  await page.selectOption('#man', { index: 1 }); await page.click('#go');
  await page.waitForSelector('#li');
  await page.fill('#li', '35.5'); await page.fill('#mo', '48000'); await page.fill('#bo', '9876');
  await page.click('#ok');
  ok((await page.textContent('#er')).includes('foto'), 'exige la foto de la boleta');
  await page.setInputFiles('#ph', { name: 'b.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForSelector('#pv:not([hidden])');
  await page.selectOption('#ni', '1/2');
  ok(await page.isVisible('#wn'), 'avisa que el estanque debe estar sobre 3/4');
  await page.click('#ok');
  await page.waitForSelector('text=Escanear vehículo');
  await page.waitForFunction(() => !document.querySelector('#net').textContent.includes('pend'), null, { timeout: 15000 });
  const cs = await (await fetch(base + '/api/admin/cargas', { headers: { Authorization: 'Bearer ' + adminTok } })).json();
  ok(cs.items.length === 1 && cs.items[0].foto_boleta.startsWith('/uploads/'), 'carga con foto sincronizada');

  // ---- botón llamar ----
  await page.click('text=Llamar supervisor');
  ok((await page.locator('a.call').first().getAttribute('href')) === 'tel:+56911111111', 'botón llamar muestra al supervisor del área');

  // ---- panel admin ----
  const ap = await ctx.newPage();
  await ap.goto(base + '/admin/');
  await ap.fill('#em', 'admin@ejemplo.cl'); await ap.fill('#pn', '1234'); await ap.click('#ok');
  await ap.waitForSelector('.cards .card');
  ok((await ap.locator('.cards .card').count()) === 6, 'semáforo muestra los 6 vehículos');
  await ap.screenshot({ path: process.env.SHOT || '/tmp/e2e/semaforo.png', fullPage: true });
  for (const t of ['alertas', 'venc', 'boletas', 'tarjetas', 'papel', 'bitacora', 'maestros']) {
    await ap.click(`[data-t="${t}"]`); await ap.waitForTimeout(500);
  }
  await ap.click('[data-t="bitacora"]'); await ap.waitForSelector('#out table');
  ok((await ap.textContent('#out')).includes('9876'), 'bitácora muestra viaje + litros + N° boleta');
  await ap.screenshot({ path: '/tmp/e2e/bitacora.png', fullPage: true });
  await ap.click('[data-t="alertas"]'); await ap.waitForSelector('table');
  await ap.screenshot({ path: '/tmp/e2e/alertas.png', fullPage: true });
  await page.screenshot({ path: '/tmp/e2e/movil.png' });

  console.log('\n✅ E2E completo');
  await browser.close(); srv.close(); process.exit(process.exitCode || 0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });

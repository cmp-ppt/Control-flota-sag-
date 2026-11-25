// Prueba de la demo estática (docs/) servida bajo /Control-flota-sag-/ como GitHub Pages. Sin servidor Node.
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..', 'docs'), PREFIX = '/Control-flota-sag-/';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (!p.startsWith(PREFIX)) { res.writeHead(404); return res.end('nf'); }
  p = p.slice(PREFIX.length); if (!p || p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
const ok = (c, m) => { if (!c) throw new Error('FALLO: ' + m); console.log('✔', m); };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const sign = async (page) => { await page.locator('#sg').scrollIntoViewIfNeeded(); const b = await page.locator('#sg').boundingBox(); await page.mouse.move(b.x + 20, b.y + 40); await page.mouse.down(); await page.mouse.move(b.x + 110, b.y + 80, { steps: 6 }); await page.mouse.up(); };

srv.listen(0, async () => {
  const base = `http://127.0.0.1:${srv.address().port}${PREFIX}`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => { console.error('pageerror', e.message); process.exitCode = 1; });
  page.on('requestfailed', (r) => console.error('requestfailed', r.url()));
  page.on('response', (r) => { if (r.status() >= 400) console.error('HTTP', r.status(), r.url()); });
  try {
    await page.goto(base);
    await page.fill('#em', 'cond1@ejemplo.cl'); await page.fill('#pn', 'cualquiera'); await page.click('#ok');
    await page.waitForSelector('text=Escanear vehículo');
    ok(true, 'demo: login conductor (servidor dentro del navegador)');
    await page.click('text=Escanear vehículo'); await page.waitForSelector('#man');
    await page.selectOption('#man', { index: 1 }); await page.click('#go');
    await page.waitForSelector('text=Guardar salida'); await page.fill('#pa', '2'); await sign(page); await page.click('#ok');
    await page.waitForSelector('text=Registrar llegada');
    await page.click('text=Registrar llegada'); await page.fill('#kf', '45300'); await sign(page); await page.click('#ok');
    await page.waitForSelector('text=Viaje cerrado'); await page.click('text=No, terminar');
    await page.waitForFunction(() => !document.querySelector('#net').textContent.includes('pend'), null, { timeout: 15000 });
    ok(true, 'salida + llegada registradas y sincronizadas');
    await page.click('text=Combustible'); await page.waitForSelector('#man'); await page.selectOption('#man', { index: 1 }); await page.click('#go');
    await page.waitForSelector('#li'); await page.fill('#li', '30'); await page.fill('#mo', '40000'); await page.fill('#bo', '5555');
    await page.setInputFiles('#ph', { name: 'b.png', mimeType: 'image/png', buffer: PNG }); await page.waitForSelector('#pv:not([hidden])');
    await page.selectOption('#ni', '3/4'); await page.click('#ok'); await page.waitForSelector('text=Escanear vehículo');
    ok(true, 'combustible con foto guardado');

    const ap = await ctx.newPage();
    ap.on('pageerror', (e) => { console.error('admin pageerror', e.message); process.exitCode = 1; });
    await ap.goto(base + 'admin/');
    await ap.fill('#em', 'admin@ejemplo.cl'); await ap.fill('#pn', 'x'); await ap.click('#ok');
    await ap.waitForSelector('.cards .card');
    ok((await ap.locator('.cards .card').count()) === 6, 'panel: semáforo con 6 vehículos (comparte datos con la app)');
    await ap.click('[data-t="boletas"]'); await ap.waitForSelector('text=5555');
    ok(true, 'panel ve la boleta enviada desde la app');
    await ap.click('[data-t="bitacora"]'); await ap.waitForSelector('#out table');
    ok((await ap.textContent('#out')).includes('5555'), 'bitácora con el viaje y la boleta');
    const [dl] = await Promise.all([ap.waitForEvent('download'), ap.click('#xl')]);
    const f = await dl.path(); ok(fs.readFileSync(f).slice(0, 2).toString() === 'PK', 'descarga de Excel (.xlsx) funciona en la demo');
    const svg = await ap.evaluate(async () => (await (await fetch('/api/admin/vehiculos/V001/qr.svg', { headers: { Authorization: 'Bearer ' + JSON.parse(localStorage.admin_session).token } })).text()));
    ok(svg.includes('<svg'), 'QR del vehículo se genera en el navegador');
    await ap.click('[data-t="alertas"]'); await ap.waitForSelector('text=VENCIDO');
    ok((await ap.textContent('#main')).includes('VENCIDO'), 'alertas de vencimiento visibles');
    await ap.screenshot({ path: '/tmp/e2e/demo-admin.png' });
    console.log('\n✅ Demo estática OK'); 
  } catch (e) { console.error('❌', e.message); process.exitCode = 1; }
  await browser.close(); srv.close();
});

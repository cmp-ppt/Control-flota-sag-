// Genera la DEMO estática (GitHub Pages) en docs/: la misma app, pero con el servidor ejecutándose
// dentro del navegador (los datos viven en IndexedDB del dispositivo). No es para uso real.
// Uso: npm run build:demo
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const write = (rel, content) => {
  const f = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
};

// ---------- 1) demo.js: servidor real (logic + seed + index) corriendo en el navegador ----------
const mod = (name, file) => `def(${JSON.stringify(name)}, function (module, exports, require) {\n${read('server', file)}\n});`;
const runtime = read('scripts', 'demo-runtime.js');
const demoJs = runtime
  .replace('/*__MODULES__*/', [mod('./logic', 'logic.js'), mod('./seed.real', 'seed.js'), mod('./index', 'index.js')].join('\n'));
write('demo/demo.js', demoJs);

// ---------- 2) librerías de navegador ----------
fs.copyFileSync(path.join(ROOT, 'node_modules/exceljs/dist/exceljs.min.js'), path.join(OUT, 'demo/exceljs.min.js'));
fs.copyFileSync(path.join(ROOT, 'node_modules/qrcode-generator/dist/qrcode.js'), path.join(OUT, 'demo/qrcode.js'));

// ---------- 3) app del conductor y panel, con rutas relativas (Pages vive en /<repo>/) ----------
const rel = (s) => s.replace(/(href|src)="\//g, '$1="');
let idx = rel(read('public', 'index.html'));
idx = idx.replace('<script src="vendor/jsQR.js">', '<script src="demo/demo.js"></script>\n<script src="vendor/jsQR.js">');
write('index.html', idx);

let adm = read('public', 'admin', 'index.html')
  .replace(/(href|src)="\/admin\//g, '$1="')
  .replace(/(href|src)="\/icon\.svg"/g, '$1="../icon.svg"');
adm = adm.replace('<script src="admin.js">', '<script src="../demo/qrcode.js"></script>\n<script src="../demo/exceljs.min.js"></script>\n<script src="../demo/demo.js"></script>\n<script src="admin.js">');
write('admin/index.html', adm);
write('admin/admin.js', read('public', 'admin', 'admin.js'));
write('admin/admin.css', read('public', 'admin', 'admin.css'));

write('app.js', read('public', 'app.js').replace("register('/sw.js')", "register('sw.js')"));
write('app.css', read('public', 'app.css'));
write('icon.svg', read('public', 'icon.svg'));
fs.mkdirSync(path.join(OUT, 'vendor'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'public/vendor/jsQR.js'), path.join(OUT, 'vendor/jsQR.js'));
write('manifest.webmanifest', read('public', 'manifest.webmanifest').replace('"start_url": "/"', '"start_url": "./"').replace('"scope": "/"', '"scope": "./"').replace('"/icon.svg"', '"icon.svg"'));
write('sw.js', read('public', 'sw.js')
  .replace(/const VERSION = '[^']+'/, "const VERSION = 'flota-demo-v1'")
  .replace(/const SHELL = \[[^\]]*\];/, "const SHELL = ['./', 'index.html', 'app.js', 'app.css', 'manifest.webmanifest', 'icon.svg', 'vendor/jsQR.js', 'demo/demo.js'];")
  .replace("caches.match('/index.html')", "caches.match('index.html')"));
write('.nojekyll', '');
console.log('Demo generada en docs/ (' + fs.readdirSync(OUT).length + ' entradas)');

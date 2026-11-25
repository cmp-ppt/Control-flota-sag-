// Almacenamiento simple en archivo JSON (prototipo / flotas pequeñas).
// Para producción con varios administradores conviene migrar a PostgreSQL/SQLite; la API no cambia.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const UPLOADS = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

let db = null;

function load() {
  if (db) return db;
  if (!fs.existsSync(DB_FILE)) {
    db = require('./seed').build();
    save();
  } else {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  }
  return db;
}

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE); // escritura atómica
}

function reset(newDb) {
  db = newDb;
  save();
}

// Guarda imágenes en base64 (data URL) como archivos y devuelve la URL.
function saveImage(dataUrl, name) {
  if (typeof dataUrl !== 'string') return dataUrl;
  const m = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/.exec(dataUrl);
  if (!m) return dataUrl;
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const file = `${safe}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS, file), Buffer.from(m[2], 'base64'));
  return `/uploads/${file}`;
}

module.exports = { load, save, reset, saveImage, DATA_DIR, UPLOADS };

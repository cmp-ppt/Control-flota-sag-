# Control de Flota

App móvil (PWA, **offline-first**) para conductores + panel web para supervisores y administradores.
Reemplaza las bitácoras en papel, muestra en tiempo real qué vehículo está disponible, en uso o atrasado,
controla combustible y boletas, y alerta vencimientos de documentos.

- Diseño completo (base de datos, flujos, alertas, herramientas): [`docs/propuesta-sistema-control-flota.md`](docs/propuesta-sistema-control-flota.md)
- Alternativa low-code: [`plantilla-appsheet/`](plantilla-appsheet/)

## Probar en 1 minuto

```bash
npm install
npm start            # http://localhost:3000
```

| Qué | Dónde |
|---|---|
| App del conductor (instalable en el celular) | `http://localhost:3000/` |
| Panel de supervisores / administrador | `http://localhost:3000/admin/` |

Usuarios de ejemplo (PIN **1234**, cámbielos): `cond1@ejemplo.cl` (conductor), `sup.norte@ejemplo.cl` (supervisor), `admin@ejemplo.cl` (administrador).
Los datos de ejemplo son ficticios; se guardan en `data/db.json`. `npm run seed` los reinicia.

## Qué incluye

**App del conductor** — escaneo de QR (o selección manual si falla la cámara), salida y llegada con firma en pantalla,
varios viajes por día, combustible con foto de boleta obligatoria y regla de 3/4 de estanque, botón "Llamar al supervisor"
(contactos por área, también sin internet). Todo se guarda primero en el teléfono (IndexedDB) y se sincroniza solo al volver la señal.

**Panel** — semáforo en tiempo real (🟢🔴🟡) con botón de llamar al supervisor y registro de llamadas, alertas (vehículo atrasado,
estanque bajo, boleta pendiente, documentos por vencer/vencidos, licencias), vencimientos de revisión técnica y permiso de
circulación, validación cruzada de boletas, tarjetas de combustible, transcripción de bitácora de emergencia (papel + foto),
bitácora mensual en **Excel y PDF** con las 16 columnas de la bitácora actual, QR imprimibles por vehículo, y mantenedores.

## Demo en GitHub Pages (sin servidor)

`docs/` contiene una **demo estática**: la misma app, con el servidor ejecutándose dentro del navegador y los datos guardados
en el propio dispositivo (no se comparten entre personas; cualquier PIN sirve). Sirve para mostrarla, no para uso real.

1. En GitHub: **Settings → Pages → Build and deployment → Deploy from a branch** → rama `claude/fleet-management-system-hmwxeq` (o `main` tras fusionarla), carpeta **`/docs`**.
2. Queda en `https://<usuario>.github.io/Control-flota-sag-/` (app del conductor) y `.../admin/` (panel).
3. Si cambia el código: `npm run build:demo` regenera `docs/` (no lo edite a mano).

Límites de la demo: el QR se genera pero las fotos/firmas del Excel no se incrustan; no hay sincronización entre dispositivos.

## Pruebas

```bash
npm test                                   # API
NODE_PATH=$(npm root -g) node test/demo-e2e.js  # demo estática bajo /Control-flota-sag-/
NODE_PATH=$(npm root -g) node test/e2e.js  # navegador real (Chromium + Playwright): incluye salida/llegada SIN internet
```

## Puesta en producción (pendiente / recomendaciones)

1. **HTTPS es obligatorio** para cámara (QR/fotos) y para instalar la PWA en el celular. Use un dominio con certificado (Caddy, Nginx + Let's Encrypt, o un PaaS como Render/Fly.io/Railway con volumen persistente para `data/`).
2. Cambie los PIN de ejemplo y cargue sus áreas, vehículos, conductores y contactos desde **Maestros**.
3. Zona horaria: variable `TZ` (por defecto `America/Santiago`); `PORT` y `DATA_DIR` también son configurables.
4. Respaldos: copie `data/` (base `db.json` + fotos en `uploads/`) periódicamente.
5. El almacenamiento es un archivo JSON, adecuado para 35 vehículos. Si crece, migrar a PostgreSQL/SQLite sin cambiar la API.
6. Notificaciones por correo/WhatsApp: hoy las alertas se ven en el panel; el envío automático es el siguiente paso.

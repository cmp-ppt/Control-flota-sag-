# Despliegue con HTTPS

La app necesita HTTPS para usar la cámara (QR y fotos) e instalarse en el celular. Ambas opciones dan HTTPS automático
y necesitan un **disco persistente** (guarda `db.json` y las fotos). Sin disco, los datos se pierden en cada despliegue.

## Opción A — Render (más simple, ~USD 7/mes + disco)
1. Cree cuenta en render.com y conéctela a GitHub.
2. **New > Blueprint** → elija este repositorio y la rama. Render lee `render.yaml`.
3. Al terminar queda una URL `https://control-flota.onrender.com`. Ábrala en el celular → menú → "Instalar app / Agregar a inicio".

## Opción B — Fly.io (región Santiago `scl`)
```bash
fly auth login
# edite el nombre en fly.toml (app = "control-flota-su-nombre")
fly launch --no-deploy --copy-config
fly volumes create datos --size 2 --region scl
fly deploy
```
URL resultante: `https://<nombre>.fly.dev`.

## Dominio propio (opcional)
Render: Settings > Custom Domains. Fly: `fly certs add flota.sudominio.cl`. Apunte el DNS como indique la plataforma.

## Después de publicar
1. Ingrese a `/admin/` con `admin@ejemplo.cl` / `1234` y **cambie los PIN** (Maestros > Personas > Editar).
2. Cargue áreas/vehículos/conductores/contactos reales; elimine o desactive los de ejemplo. Para partir sin datos de ejemplo, borre `/data/db.json` y reinicie.
3. Imprima los QR (Maestros > Imprimir todos los QR) y péguelos en los vehículos.
4. Respaldo: copie el volumen `/data` periódicamente (Render: snapshots del disco; Fly: `fly volumes snapshots`).

Variables: `PORT` (8080), `DATA_DIR` (/data), `TZ` (America/Santiago).

# IMAP Sync Worker (VPS)

Worker Node para sincronizar correos entrantes por IMAP y guardarlos en Supabase cuando Edge Functions no puede abrir conexión TCP al IMAP del proveedor.

## 1) Requisitos

- Node.js 20+
- Acceso al servidor VPS (Linux recomendado)
- Variables de Supabase con rol de servicio

## 2) Instalación local

```bash
cd workers/imap-sync-worker
npm install
cp .env.example .env
```

## 3) Variables de entorno

Edita `.env`:

```env
SUPABASE_URL=https://<tu-proyecto>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
SYNC_CRON=*/2 * * * *
FETCH_LIMIT=50
ACCOUNT_EMAIL=
ACCOUNT_ID=
DRY_RUN=false
```

- `SYNC_CRON`: frecuencia de sync (formato cron).
- `FETCH_LIMIT`: cantidad máxima de correos por ciclo y por cuenta.
- `ACCOUNT_EMAIL` o `ACCOUNT_ID`: opcional para fijar una sola cuenta.
- `DRY_RUN=true`: prueba sin insertar datos.

## 4) Ejecutar

Una sola ejecución:

```bash
npm run once
```

Modo daemon con cron interno:

```bash
npm run start
```

## 5) PM2 (recomendado en VPS)

```bash
npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Logs:

```bash
pm2 logs crmpro-imap-sync
```

## 6) Deploy en Render

### Opción recomendada: Background Worker (siempre activo)

1. Sube este repositorio a GitHub/GitLab.
2. En Render: **New +** → **Background Worker**.
3. Conecta el repo y configura:
	- **Root Directory**: `workers/imap-sync-worker`
	- **Build Command**: `npm install`
	- **Start Command**: `npm run start`
4. En **Environment Variables** agrega:
	- `SUPABASE_URL`
	- `SUPABASE_SERVICE_ROLE_KEY`
	- `SYNC_CRON` (ej: `*/2 * * * *`)
	- `FETCH_LIMIT` (ej: `50`)
	- `DRY_RUN=false`
	- `ACCOUNT_EMAIL` (opcional)
	- `ACCOUNT_ID` (opcional)
5. Deploy y revisa logs en Render.

### Opción rápida: Blueprint con `render.yaml`

Este repo ya incluye [render.yaml](../../render.yaml). Para usarlo:

1. En Render: **New +** → **Blueprint**.
2. Selecciona el repo.
3. Render detectará automáticamente:
	- `crmpro-imap-sync-worker` (worker continuo)
	- `crmpro-imap-sync-cron` (job por lote)
4. Completa secretos pendientes:
	- `SUPABASE_URL`
	- `SUPABASE_SERVICE_ROLE_KEY`
5. Si no usarás uno de los dos servicios, puedes deshabilitarlo o eliminarlo del `render.yaml`.

### Opción alternativa: Render Cron Job

Si prefieres ejecución por lotes:

1. Crea **New +** → **Cron Job**.
2. Usa:
	- **Root Directory**: `workers/imap-sync-worker`
	- **Build Command**: `npm install`
	- **Start Command**: `npm run once`
3. Define cron en Render (ej: cada 2 minutos).
4. Usa las mismas variables de entorno del worker.

### Verificación en Render

- Busca en logs: `Accounts to process:` y `Cycle complete`.
- Si usas `DRY_RUN=true`, no insertará correos (solo prueba conexión y flujo).

## 7) systemd (alternativa)

Crea `/etc/systemd/system/crmpro-imap-sync.service`:

```ini
[Unit]
Description=CRMPro IMAP Sync Worker
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/crmpro/workers/imap-sync-worker
ExecStart=/usr/bin/node src/worker.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=/opt/crmpro/workers/imap-sync-worker/.env

[Install]
WantedBy=multi-user.target
```

Activa:

```bash
sudo systemctl daemon-reload
sudo systemctl enable crmpro-imap-sync
sudo systemctl start crmpro-imap-sync
sudo systemctl status crmpro-imap-sync
```

## 8) Seguridad

- No subas `.env` al repositorio.
- Usa una clave `SERVICE_ROLE` solo en servidor seguro.
- Restringe acceso SSH al VPS.

# Despliegue en aPanel

Guía para desplegar WhatsApp SaaS API en un servidor con **aPanel**.

## Requisitos

- aPanel instalado
- Docker y Docker Compose instalados en el servidor
- Acceso SSH a tu servidor

## Paso 1: Clonar el repositorio

```bash
# En tu servidor, en un directorio accesible (ej: /home/user/apps)
cd /home/user/apps  # o donde prefieras
git clone https://github.com/aeromatico/whats-api.js.git
cd whats-api.js/server
```

## Paso 2: Configurar variables de entorno

```bash
cp .env.example .env.production
nano .env.production
```

**Edita estos valores críticos:**

```env
NODE_ENV=production
DATABASE_URL=postgresql://wasp:CAMBIAR_ESTO_FUERTE@localhost:5432/whatsapp_saas
REDIS_URL=redis://localhost:6379
JWT_SECRET=GENERAR_UNA_CLAVE_SUPER_LARGA_Y_FUERTE_32_CHARS_MINIMO
```

## Paso 3: Usar puertos específicos en aPanel

Edita `docker-compose.yml` para especificar puertos que no conflictúen:

```yaml
services:
  api:
    ports:
      - "3001:3000"  # El container usa 3000, el host expone 3001
```

O modifica en el archivo:

```bash
sed -i "s/'3000:3000'/'3001:3000'/g" docker-compose.yml
```

**Puertos sugeridos:**
- API: `3001` (será 8001 con reverse proxy de aPanel)
- PostgreSQL: `5432` (interno, no exponer)
- Redis: `6379` (interno, no exponer)

## Paso 4: Hacer el script ejecutable

```bash
chmod +x scripts/deploy.sh
```

## Paso 5: Ejecutar despliegue

```bash
./scripts/deploy.sh
```

El script:
- ✅ Verifica Docker y Docker Compose
- ✅ Construye las imágenes
- ✅ Arranca PostgreSQL y Redis
- ✅ Ejecuta migraciones
- ✅ Crea el primer tenant + API key
- ✅ Arranca API y Worker
- ✅ Verifica salud

**Salida esperada:**
```
✅ Deployment complete!

📍 API URL:      http://localhost:3001
📘 Swagger Docs: http://localhost:3001/docs

🔑 API Key:      wasp_xxxxxxxxxxxx...

Next steps:
  1. Configure reverse proxy en aPanel
  2. Prueba: curl -H 'X-API-Key: wasp_xxx' http://localhost:3001/v1/account
```

## Paso 6: Configurar Reverse Proxy en aPanel

En aPanel, crea un nuevo sitio con reverse proxy:

### Opción A: Si aPanel usa Nginx

1. Ve a **Sitios** → **Agregar Sitio**
2. Dominio: `api.tudominio.com` (o el que uses)
3. En la configuración de Nginx, agrega:

```nginx
location / {
    proxy_pass http://localhost:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}
```

4. SSL: Habilitar Let's Encrypt
5. Guardar

### Opción B: Nginx manual

```bash
sudo nano /etc/nginx/sites-available/whatsapp-api

# Contenido:
upstream whatsapp_api {
    server localhost:3001;
}

server {
    listen 80;
    listen [::]:80;
    server_name api.tudominio.com;

    location / {
        proxy_pass http://whatsapp_api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}

# Habilitar
sudo ln -s /etc/nginx/sites-available/whatsapp-api /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# SSL con Certbot
sudo certbot --nginx -d api.tudominio.com
```

## Paso 7: Probar la API

```bash
# Obtén tu API key del paso 5
API_KEY="wasp_xxxxxxxxxxxx"

# Prueba básica
curl -H "X-API-Key: $API_KEY" https://api.tudominio.com/v1/account

# Respuesta esperada:
# {
#   "id": "uuid...",
#   "name": "Default Tenant",
#   "email": "admin@example.com",
#   "plan": "pro",
#   "maxInstances": 10,
#   "instancesUsed": 0
# }
```

## Paso 8: Ver logs

```bash
# Logs de toda la stack
docker-compose logs -f

# Solo API
docker-compose logs -f api

# Solo Worker
docker-compose logs -f worker

# Solo PostgreSQL
docker-compose logs -f postgres
```

## Paso 9: Monitoreo continuo

```bash
# Ver estado de contenedores
docker-compose ps

# Ver uso de recursos
docker stats

# Health check
curl https://api.tudominio.com/health
```

## Servicios en segundo plano (Systemd)

Para que se reinicie automáticamente si el servidor se reinicia:

```bash
sudo nano /etc/systemd/system/whatsapp-api.service
```

```ini
[Unit]
Description=WhatsApp SaaS API
After=docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=/home/user/apps/whats-api.js/server
ExecStart=/usr/bin/docker-compose up
ExecStop=/usr/bin/docker-compose down
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable whatsapp-api.service
sudo systemctl start whatsapp-api.service
sudo systemctl status whatsapp-api.service
```

## Troubleshooting

### Puerto ya en uso
```bash
# Ver qué ocupa el puerto
lsof -i :3001

# Cambiar en docker-compose.yml
sed -i 's/:3001:/:3002:/g' docker-compose.yml
docker-compose restart api
```

### PostgreSQL no inicia
```bash
# Ver logs
docker-compose logs postgres

# Limpiar volumen (⚠️ borra datos)
docker-compose down -v
docker-compose up postgres
```

### Worker sin conectar WhatsApp
- Verifica en Swagger UI: http://api.tudominio.com/docs
- POST `/v1/instances` para crear instancia
- GET `/v1/instances/:id/qr` para obtener código QR
- Escanea con WhatsApp

### SSL no funciona
```bash
# Renovar certificados
sudo certbot renew --dry-run
sudo certbot renew
```

## Respaldo y restore

```bash
# Backup de BD y sesiones
docker-compose exec postgres pg_dump -U wasp whatsapp_saas > backup.sql
docker-compose exec -T postgres tar czf - /var/lib/postgresql/data > postgres_data.tar.gz
cp -r .wwebjs_sessions sessions_backup

# Restore
docker-compose exec postgres psql -U wasp whatsapp_saas < backup.sql
```

## Documentación API

- **Swagger UI**: https://api.tudominio.com/docs
- **README**: ./README.md
- **Endpoints**: Consulta Swagger para lista completa

¿Preguntas? Revisa los logs:

```bash
docker-compose logs -f | grep -i error
```

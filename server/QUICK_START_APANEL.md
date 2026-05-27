# Quick Start — aPanel

**Despliegue en 5 minutos.**

## 1️⃣ Clonar

```bash
cd /home/user/apps  # o donde prefieras
git clone https://github.com/aeromatico/whats-api.js.git
cd whats-api.js/server
```

## 2️⃣ Configurar

```bash
cp .env.apanel.example .env.production

# Editar valores importantes:
nano .env.production
```

**Valores críticos a cambiar:**
```
POSTGRES_PASSWORD=TU_PASSWORD_FUERTE
DATABASE_URL=...con_el_mismo_password...
JWT_SECRET=GENERAR_CON: openssl rand -base64 32
```

## 3️⃣ Desplegar

```bash
# Puerto aleatorio (ej: 3001)
bash scripts/deploy-apanel.sh 3001
```

**Espera a que termine...**

Al final verás:
```
✅ ¡Despliegue completado!

🔑 API Key: wasp_xxxxxxxxxxxxx

🧪 Prueba: curl -H 'X-API-Key: wasp_xxx' http://localhost:3001/v1/account

📘 Swagger UI: http://localhost:3001/docs
```

## 4️⃣ Configurar en aPanel

En tu panel aPanel:

1. **Sitios** → **Agregar Sitio**
2. Dominio: `api.tudominio.com`
3. **Ir a Nginx/Apache config**
4. **Cambiar a Reverse Proxy:**

```
upstream api {
    server 127.0.0.1:3001;
}

server {
    listen 80;
    server_name api.tudominio.com;
    
    location / {
        proxy_pass http://api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

5. **SSL** → Let's Encrypt → Generar

## 5️⃣ Probar

```bash
curl -H "X-API-Key: wasp_xxx" https://api.tudominio.com/v1/account
```

## ✅ Done!

- **API**: https://api.tudominio.com
- **Docs**: https://api.tudominio.com/docs
- **Crear instancia**: POST `/v1/instances` con tu API key

---

## Troubleshooting

```bash
# Ver logs
docker-compose logs -f api

# Reiniciar
docker-compose restart

# Ver estado
docker-compose ps
```

📚 **Documentación completa**: Ver `DEPLOY_APANEL.md`

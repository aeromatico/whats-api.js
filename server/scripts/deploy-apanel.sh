#!/bin/bash
# Despliegue rápido para aPanel
# Uso: bash scripts/deploy-apanel.sh [puerto]
# Ejemplo: bash scripts/deploy-apanel.sh 3001

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${1:-3001}"

echo -e "${GREEN}🚀 WhatsApp SaaS API para aPanel${NC}"
echo "════════════════════════════════════"
echo -e "Directorio: $PROJECT_DIR"
echo -e "Puerto: $PORT"
echo ""

# Verificar que existe .env.production
if [ ! -f "$PROJECT_DIR/.env.production" ]; then
  echo -e "${YELLOW}⚠ Creando .env.production desde .env.apanel.example${NC}"
  cp "$PROJECT_DIR/.env.apanel.example" "$PROJECT_DIR/.env.production"
  echo -e "${RED}✗ EDITA .env.production ANTES DE CONTINUAR${NC}"
  echo ""
  echo "  nano $PROJECT_DIR/.env.production"
  echo ""
  echo "Luego ejecuta de nuevo:"
  echo "  bash scripts/deploy-apanel.sh $PORT"
  exit 1
fi

# Actualizar puerto en docker-compose
echo -e "${GREEN}✓ Configurando puerto $PORT${NC}"
sed -i.bak "s/API_HOST_PORT.*/API_HOST_PORT=$PORT/" docker-compose.yml

# Construir imágenes
echo ""
echo -e "${YELLOW}📦 Construyendo imágenes Docker...${NC}"
docker-compose build --no-cache api worker 2>&1 | grep -E "(Step|Successfully|error)" || true

# Iniciar servicios de BD
echo ""
echo -e "${YELLOW}🔧 Iniciando PostgreSQL y Redis...${NC}"
docker-compose up -d postgres redis

# Esperar a BD
echo -e "${YELLOW}⏳ Esperando PostgreSQL...${NC}"
for i in {1..30}; do
  if docker-compose exec -T postgres pg_isready -U wasp -d whatsapp_saas >/dev/null 2>&1; then
    echo -e "${GREEN}✓ PostgreSQL listo${NC}"
    break
  fi
  sleep 1
done

echo -e "${YELLOW}⏳ Esperando Redis...${NC}"
for i in {1..30}; do
  if docker-compose exec -T redis redis-cli ping >/dev/null 2>&1; then
    echo -e "${GREEN}✓ Redis listo${NC}"
    break
  fi
  sleep 1
done

# Migraciones
echo ""
echo -e "${YELLOW}📋 Ejecutando migraciones...${NC}"
docker-compose run --rm migrate 2>&1 | tail -10

# Seed
echo ""
echo -e "${YELLOW}👤 Creando tenant inicial...${NC}"
SEED_OUTPUT=$(docker-compose run --rm api node scripts/seed.js 2>&1)
echo "$SEED_OUTPUT"

# Extraer API key
API_KEY=$(echo "$SEED_OUTPUT" | grep -oP 'wasp_[a-z0-9]{48}' | head -1)

# Iniciar servicios
echo ""
echo -e "${YELLOW}🎯 Iniciando API y Worker...${NC}"
docker-compose up -d api worker

# Esperar API
echo -e "${YELLOW}⏳ Esperando API...${NC}"
for i in {1..60}; do
  if curl -s http://localhost:$PORT/health >/dev/null 2>&1; then
    echo -e "${GREEN}✓ API lista${NC}"
    break
  fi
  sleep 1
done

# Resumen
echo ""
echo -e "${GREEN}✅ ¡Despliegue completado!${NC}"
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo -e "${GREEN}🔑 API Key:${NC}"
echo "   $API_KEY"
echo ""
echo -e "${GREEN}🧪 Prueba (localhost):${NC}"
echo "   curl -H 'X-API-Key: $API_KEY' http://localhost:$PORT/v1/account"
echo ""
echo -e "${GREEN}📘 Swagger UI:${NC}"
echo "   http://localhost:$PORT/docs"
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo -e "${YELLOW}Próximos pasos:${NC}"
echo "  1. Configura reverse proxy en aPanel"
echo "  2. Apunta tu dominio a la API"
echo "  3. Habilita HTTPS/SSL"
echo "  4. Guarda tu API key en un lugar seguro"
echo ""
echo "📚 Ver: DEPLOY_APANEL.md para instrucciones completas"
echo ""

# Mostrar logs últimos
echo -e "${YELLOW}Últimos logs:${NC}"
docker-compose logs --tail=10 api

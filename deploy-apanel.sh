#!/bin/bash
# Despliegue rápido para aPanel
# Uso desde la raíz del repo: bash deploy-apanel.sh [puerto]
# Ejemplo: bash deploy-apanel.sh 3001

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/server"
PORT="${1:-3001}"

echo -e "${GREEN}🚀 WhatsApp SaaS API para aPanel${NC}"
echo "════════════════════════════════════"
echo -e "Directorio del proyecto: $PROJECT_DIR"
echo -e "Puerto: $PORT"
echo ""

# Verificar que existe el directorio server/
if [ ! -d "$PROJECT_DIR" ]; then
  echo -e "${RED}✗ No se encontró el directorio 'server/'. Asegúrate de ejecutar este script desde la raíz del repositorio.${NC}"
  exit 1
fi

cd "$PROJECT_DIR"

# Verificar que existe .env.production
if [ ! -f ".env.production" ]; then
  echo -e "${YELLOW}⚠ Creando .env.production desde .env.apanel.example...${NC}"
  cp ".env.apanel.example" ".env.production"
  echo ""
  echo -e "${RED}✗ EDITA .env.production ANTES DE CONTINUAR:${NC}"
  echo ""
  echo "  nano $PROJECT_DIR/.env.production"
  echo ""
  echo "Valores mínimos a cambiar:"
  echo "  POSTGRES_PASSWORD=  → openssl rand -base64 16"
  echo "  JWT_SECRET=         → openssl rand -base64 32"
  echo ""
  echo "Luego ejecuta de nuevo:"
  echo "  bash deploy-apanel.sh $PORT"
  exit 1
fi

# Verificar Docker
if ! command -v docker &> /dev/null; then
  echo -e "${RED}✗ Docker no encontrado. Instala Docker primero.${NC}"
  echo "  curl -fsSL https://get.docker.com | sh"
  exit 1
fi

if ! command -v docker-compose &> /dev/null; then
  echo -e "${RED}✗ Docker Compose no encontrado.${NC}"
  echo "  apt-get install docker-compose-plugin"
  exit 1
fi

echo -e "${GREEN}✓ Docker y Docker Compose encontrados${NC}"

# Actualizar puerto en docker-compose
echo -e "${GREEN}✓ Configurando puerto $PORT...${NC}"
sed -i.bak "s/API_HOST_PORT:-[0-9]*/API_HOST_PORT:-$PORT/g" docker-compose.yml
export API_HOST_PORT=$PORT

# Cargar variables de entorno
export $(grep -v '^#' .env.production | xargs)

# Construir imágenes
echo ""
echo -e "${YELLOW}📦 Construyendo imágenes Docker...${NC}"
docker-compose build 2>&1 | grep -E "(Step|Successfully built|error|Error)" || true
echo -e "${GREEN}✓ Imágenes construidas${NC}"

# Iniciar servicios de BD
echo ""
echo -e "${YELLOW}🔧 Iniciando PostgreSQL y Redis...${NC}"
docker-compose up -d postgres redis

# Esperar PostgreSQL
echo -e "${YELLOW}⏳ Esperando PostgreSQL...${NC}"
for i in {1..30}; do
  if docker-compose exec -T postgres pg_isready -U wasp -d whatsapp_saas >/dev/null 2>&1; then
    echo -e "${GREEN}✓ PostgreSQL listo${NC}"
    break
  fi
  sleep 1
  if [ $i -eq 30 ]; then
    echo -e "${RED}✗ PostgreSQL no respondió en 30s. Ver logs:${NC}"
    docker-compose logs postgres | tail -20
    exit 1
  fi
done

# Esperar Redis
echo -e "${YELLOW}⏳ Esperando Redis...${NC}"
for i in {1..15}; do
  if docker-compose exec -T redis redis-cli ping >/dev/null 2>&1; then
    echo -e "${GREEN}✓ Redis listo${NC}"
    break
  fi
  sleep 1
done

# Migraciones
echo ""
echo -e "${YELLOW}📋 Ejecutando migraciones de base de datos...${NC}"
docker-compose run --rm migrate 2>&1
echo -e "${GREEN}✓ Migraciones aplicadas${NC}"

# Seed — crear primer tenant + API key
echo ""
echo -e "${YELLOW}👤 Creando tenant inicial y API key...${NC}"
SEED_OUTPUT=$(docker-compose run --rm api node scripts/seed.js 2>&1)
echo "$SEED_OUTPUT"

API_KEY=$(echo "$SEED_OUTPUT" | grep -oP 'wasp_[a-z0-9]+' | head -1)

# Iniciar API y Worker
echo ""
echo -e "${YELLOW}🎯 Iniciando API y Worker...${NC}"
docker-compose up -d api worker

# Esperar API
echo -e "${YELLOW}⏳ Esperando API (hasta 60s)...${NC}"
for i in {1..60}; do
  if curl -s http://localhost:$PORT/health >/dev/null 2>&1; then
    echo -e "${GREEN}✓ API respondiendo en :$PORT${NC}"
    break
  fi
  sleep 1
  if [ $i -eq 60 ]; then
    echo -e "${RED}✗ API no respondió. Ver logs:${NC}"
    docker-compose logs api | tail -30
    exit 1
  fi
done

# Health check
HEALTH=$(curl -s http://localhost:$PORT/health)
echo -e "${GREEN}✓ Health: $HEALTH${NC}"

# Resumen final
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✅ ¡Despliegue completado exitosamente!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}🔑 Tu API Key (guárdala, no se muestra de nuevo):${NC}"
echo -e "   ${GREEN}$API_KEY${NC}"
echo ""
echo -e "${YELLOW}🧪 Prueba rápida:${NC}"
echo "   curl -H 'X-API-Key: $API_KEY' http://localhost:$PORT/v1/account"
echo ""
echo -e "${YELLOW}📘 Swagger UI (local):${NC}"
echo "   http://localhost:$PORT/docs"
echo ""
echo -e "${YELLOW}📡 Estado de contenedores:${NC}"
docker-compose ps
echo ""
echo -e "${YELLOW}📖 Siguiente paso — Reverse Proxy en aPanel:${NC}"
echo "   Ver: QUICK_START_APANEL.md o DEPLOY_APANEL.md"
echo ""

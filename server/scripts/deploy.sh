#!/bin/bash
# WhatsApp SaaS API Deployment Script
# Run this on your server: bash scripts/deploy.sh

set -e  # Exit on error

echo "🚀 WhatsApp SaaS API Deployment"
echo "================================"

# ── Colors ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ── Configuration ──────────────────────────────────────────────────────────
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_ENV="${DEPLOY_ENV:-.env.production}"
PORT="${API_PORT:=3000}"
DOMAIN="${DOMAIN:=localhost}"

echo -e "${YELLOW}Project directory:${NC} $PROJECT_DIR"
echo -e "${YELLOW}Environment file:${NC} $DEPLOY_ENV"
echo ""

# ── Check prerequisites ────────────────────────────────────────────────────
echo "✓ Checking prerequisites..."

if ! command -v docker &> /dev/null; then
  echo -e "${RED}✗ Docker not found. Install Docker first.${NC}"
  exit 1
fi

if ! command -v docker-compose &> /dev/null; then
  echo -e "${RED}✗ Docker Compose not found. Install Docker Compose first.${NC}"
  exit 1
fi

echo -e "${GREEN}✓ Docker and Docker Compose installed${NC}"

# ── Check environment file ─────────────────────────────────────────────────
if [ ! -f "$PROJECT_DIR/$DEPLOY_ENV" ]; then
  echo -e "${YELLOW}⚠ $DEPLOY_ENV not found. Creating from .env.example...${NC}"
  cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/$DEPLOY_ENV"
  echo -e "${YELLOW}⚠ Edit $DEPLOY_ENV with your secrets and run again:${NC}"
  echo ""
  echo "  nano $PROJECT_DIR/$DEPLOY_ENV"
  echo ""
  exit 1
fi

echo -e "${GREEN}✓ Environment file exists${NC}"

# ── Build images ───────────────────────────────────────────────────────────
echo ""
echo "📦 Building Docker images..."
cd "$PROJECT_DIR"

if ! docker-compose build 2>&1 | tail -5; then
  echo -e "${RED}✗ Docker build failed${NC}"
  exit 1
fi

echo -e "${GREEN}✓ Images built${NC}"

# ── Pull and start services ────────────────────────────────────────────────
echo ""
echo "🔧 Starting services..."
docker-compose up -d postgres redis

echo "⏳ Waiting for PostgreSQL..."
for i in {1..30}; do
  if docker-compose exec -T postgres pg_isready -U wasp -d whatsapp_saas >/dev/null 2>&1; then
    echo -e "${GREEN}✓ PostgreSQL ready${NC}"
    break
  fi
  sleep 1
  if [ $i -eq 30 ]; then
    echo -e "${RED}✗ PostgreSQL timeout${NC}"
    exit 1
  fi
done

echo "⏳ Waiting for Redis..."
for i in {1..30}; do
  if docker-compose exec -T redis redis-cli ping >/dev/null 2>&1; then
    echo -e "${GREEN}✓ Redis ready${NC}"
    break
  fi
  sleep 1
  if [ $i -eq 30 ]; then
    echo -e "${RED}✗ Redis timeout${NC}"
    exit 1
  fi
done

# ── Run migrations ─────────────────────────────────────────────────────────
echo ""
echo "📋 Running database migrations..."
if ! docker-compose run --rm migrate 2>&1 | grep -E "(All migrations|apply)"; then
  echo -e "${RED}✗ Migrations failed${NC}"
  exit 1
fi

echo -e "${GREEN}✓ Migrations complete${NC}"

# ── Start API and Worker ───────────────────────────────────────────────────
echo ""
echo "🎯 Starting API and Worker services..."
docker-compose up -d api worker

echo "⏳ Waiting for API to be ready..."
for i in {1..60}; do
  if curl -s http://localhost:$PORT/health >/dev/null 2>&1; then
    echo -e "${GREEN}✓ API is ready${NC}"
    break
  fi
  sleep 1
  if [ $i -eq 60 ]; then
    echo -e "${RED}✗ API startup timeout${NC}"
    exit 1
  fi
done

# ── Seed initial tenant ────────────────────────────────────────────────────
echo ""
echo "👤 Creating initial tenant and API key..."
docker-compose run --rm api node scripts/seed.js 2>&1 | tee /tmp/seed.log

# Extract API key from seed output
API_KEY=$(grep -oP '(?<=wasp_)[a-z0-9]{48}' /tmp/seed.log | head -1)
if [ -z "$API_KEY" ]; then
  API_KEY=$(grep 'wasp_' /tmp/seed.log | grep -oP 'wasp_[a-z0-9]*' | head -1)
fi

# ── Health check ───────────────────────────────────────────────────────────
echo ""
echo "🏥 Health check..."
HEALTH=$(curl -s http://localhost:$PORT/health | grep -o '"status":"ok"')
if [ -z "$HEALTH" ]; then
  echo -e "${YELLOW}⚠ Health check failed (API might still be starting)${NC}"
else
  echo -e "${GREEN}✓ Health check passed${NC}"
fi

# ── Summary ────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}✅ Deployment complete!${NC}"
echo ""
echo "═════════════════════════════════════════════════════════════════════════"
echo ""
echo "📍 API URL:      http://$DOMAIN:$PORT"
echo "📘 Swagger Docs: http://$DOMAIN:$PORT/docs"
echo ""
echo "🔑 API Key:      wasp_$API_KEY"
echo ""
echo "═════════════════════════════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. Update your .env file with production settings"
echo "  2. Configure your domain/SSL in a reverse proxy (nginx/caddy)"
echo "  3. Test with: curl -H 'X-API-Key: wasp_$API_KEY' http://$DOMAIN:$PORT/v1/account"
echo "  4. Create webhooks and instances via the API"
echo ""
echo "📚 See README.md for full documentation"
echo ""

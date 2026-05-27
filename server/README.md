# WhatsApp SaaS API

A production-ready, multi-tenant WhatsApp REST API built on [whatsapp-web.js](https://github.com/wwebjs/whatsapp-web.js).

## Features

- 🔑 **Multi-tenant** — API keys per customer, configurable instance limits per plan
- 📱 **WhatsApp Instances** — Connect multiple WhatsApp numbers per tenant
- 📨 **Full messaging** — Text, images, video, audio, documents, locations
- 📤 **Bulk send** — Async queue with configurable delay between messages
- 🔔 **Webhooks** — Real-time events with HMAC-SHA256 signing and automatic retry
- 📘 **OpenAPI docs** — Swagger UI at `/docs`
- 🚦 **Rate limiting** — Per-tenant sliding window limits by plan
- 🐳 **Docker Compose** — One command to run everything

## Quick Start

### 1. Clone & configure

```bash
git clone https://github.com/aeromatico/whats-api.js
cd whats-api.js/server
cp .env.example .env
# Edit .env — set a strong JWT_SECRET and POSTGRES_PASSWORD
```

### 2. Start all services

```bash
docker-compose up -d
```

This starts: PostgreSQL, Redis, API server, and the WhatsApp worker.

### 3. Run migrations

```bash
docker-compose run --rm migrate
```

### 4. Create your first tenant and API key

```bash
docker-compose run --rm api node scripts/seed.js
```

**Save the API key** — it's only shown once.

### 5. Open the docs

```
http://localhost:3000/docs
```

---

## Connect a WhatsApp Number

### Step 1 — Create an instance

```bash
curl -X POST http://localhost:3000/v1/instances \
  -H "X-API-Key: wasp_<your_key>" \
  -H "Content-Type: application/json" \
  -d '{"name": "My WhatsApp Number"}'
```

Response:
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "My WhatsApp Number",
  "status": "disconnected"
}
```

### Step 2 — Connect (start QR flow)

```bash
curl -X POST http://localhost:3000/v1/instances/<id>/connect \
  -H "X-API-Key: wasp_<your_key>"
```

### Step 3 — Get QR code

```bash
curl http://localhost:3000/v1/instances/<id>/qr \
  -H "X-API-Key: wasp_<your_key>"
```

Returns a base64 QR string. Render it as an image and scan with your phone.

### Step 4 — Check status

```bash
curl http://localhost:3000/v1/instances/<id>/status \
  -H "X-API-Key: wasp_<your_key>"
```

When `status` is `connected`, you're ready to send messages.

---

## Send a Message

```bash
curl -X POST http://localhost:3000/v1/instances/<id>/messages \
  -H "X-API-Key: wasp_<your_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "5491155556666",
    "type": "text",
    "text": "Hello from WhatsApp SaaS API! 🚀"
  }'
```

### Send an image

```bash
curl -X POST http://localhost:3000/v1/instances/<id>/messages \
  -H "X-API-Key: wasp_<your_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "5491155556666",
    "type": "image",
    "mediaUrl": "https://example.com/image.jpg",
    "caption": "Check this out!"
  }'
```

### Bulk send

```bash
curl -X POST http://localhost:3000/v1/instances/<id>/messages/bulk \
  -H "X-API-Key: wasp_<your_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "delayMs": 500,
    "messages": [
      {"to": "5491155556661", "type": "text", "text": "Hello user 1"},
      {"to": "5491155556662", "type": "text", "text": "Hello user 2"},
      {"to": "5491155556663", "type": "text", "text": "Hello user 3"}
    ]
  }'
```

---

## Configure Webhooks

```bash
curl -X POST http://localhost:3000/v1/webhooks \
  -H "X-API-Key: wasp_<your_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-app.com/webhooks/whatsapp",
    "secret": "your-signing-secret",
    "events": ["message", "message_ack", "call"]
  }'
```

### Verify webhook signature (Node.js)

```js
import { createHmac } from 'crypto';

function verifyWebhook(rawBody, signature, secret) {
  const expected = createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  return signature === `sha256=${expected}`;
}

// In your Express/Fastify handler:
app.post('/webhooks/whatsapp', (req, res) => {
  const sig = req.headers['x-webhook-signature'];
  if (!verifyWebhook(req.rawBody, sig, 'your-signing-secret')) {
    return res.status(401).send('Invalid signature');
  }
  const { event, instanceId, data } = req.body;
  console.log(`Event: ${event}`, data);
  res.send({ ok: true });
});
```

### Webhook events

| Event | Description |
|-------|-------------|
| `message` | New message received |
| `message_create` | Message sent (outgoing) |
| `message_ack` | Delivery/read confirmation |
| `message_revoked` | Message deleted |
| `call` | Incoming call |
| `group_join` | User joined a group |
| `group_leave` | User left a group |
| `group_admin_changed` | Admin promoted/demoted |
| `disconnected` | Instance disconnected |
| `qr` | New QR code available |
| `authenticated` | Session authenticated |

---

## API Reference

Full interactive documentation available at **`http://localhost:3000/docs`**

### Base URL
```
http://localhost:3000/v1
```

### Authentication
```
X-API-Key: wasp_<your_key>
```

### Endpoints Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/account` | Account info |
| `GET` | `/account/api-keys` | List API keys |
| `POST` | `/account/api-keys` | Create API key |
| `DELETE` | `/account/api-keys/:id` | Revoke API key |
| `GET` | `/instances` | List instances |
| `POST` | `/instances` | Create instance |
| `GET` | `/instances/:id` | Get instance |
| `DELETE` | `/instances/:id` | Delete instance |
| `GET` | `/instances/:id/status` | Live status |
| `POST` | `/instances/:id/connect` | Start connection |
| `GET` | `/instances/:id/qr` | Get QR code |
| `POST` | `/instances/:id/logout` | Logout |
| `POST` | `/instances/:id/messages` | Send message |
| `POST` | `/instances/:id/messages/bulk` | Bulk send |
| `GET` | `/instances/:id/chats` | List chats |
| `GET` | `/instances/:id/chats/:chatId/messages` | Chat history |
| `POST` | `/instances/:id/chats/:chatId/read` | Mark as read |
| `GET` | `/instances/:id/contacts` | List contacts |
| `POST` | `/instances/:id/contacts/check` | Verify numbers |
| `GET` | `/instances/:id/groups` | List groups |
| `POST` | `/instances/:id/groups` | Create group |
| `POST` | `/instances/:id/groups/:groupId/participants` | Add participants |
| `DELETE` | `/instances/:id/groups/:groupId/participants/:phone` | Remove participant |
| `POST` | `/instances/:id/groups/:groupId/leave` | Leave group |
| `GET` | `/webhooks` | List webhooks |
| `POST` | `/webhooks` | Create webhook |
| `PUT` | `/webhooks/:id` | Update webhook |
| `DELETE` | `/webhooks/:id` | Delete webhook |
| `POST` | `/webhooks/:id/test` | Test webhook |
| `GET` | `/webhooks/:id/deliveries` | Delivery history |
| `GET` | `/health` | API health |
| `GET` | `/health/instances` | Instance status overview |

---

## Rate Limits

| Plan | Requests/min | Messages/min |
|------|-------------|--------------|
| Free | 60 | 30 |
| Starter | 300 | 150 |
| Pro | 1,000 | 500 |
| Enterprise | 5,000 | 2,500 |

Rate limit headers are returned with every response:
- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset`

---

## Plans & Instance Limits

Configure `max_instances` per tenant in the database:

```sql
UPDATE tenants SET plan='pro', max_instances=10 WHERE email='customer@example.com';
```

---

## Development

```bash
# Start dependencies
docker-compose up postgres redis -d

# Run migrations
node scripts/migrate.js

# Seed first tenant
node scripts/seed.js

# Start API (with file watching)
npm run dev:api

# Start Worker (in another terminal)
npm run dev:worker
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Docker Compose                       │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │  Fastify │  │  Worker  │  │  Redis   │  │  PG    │ │
│  │  API     │◄─│(Puppeteer│  │(Queue +  │  │(Data + │ │
│  │  :3000   │  │instances)│  │Rate Lmt) │  │Session)│ │
│  └────┬─────┘  └────┬─────┘  └──────────┘  └────────┘ │
│       │              │                                  │
│       └──── BullMQ ──┘                                  │
└─────────────────────────────────────────────────────────┘
         ↓ webhooks
   Customer Apps
```

**API ↔ Worker communication:**
- Commands (connect/logout/destroy): Redis pub/sub → `instance:command`
- RPC calls (getChats, sendMessage, etc.): Redis pub/sub → `instance:rpc` with response in `rpc:response:<callId>`
- Event notifications: WhatsApp events → BullMQ `webhooks` queue → HTTP delivery

---

## ⚠️ Disclaimer

This project uses [whatsapp-web.js](https://github.com/wwebjs/whatsapp-web.js) which is not affiliated with WhatsApp Inc. Use responsibly and in accordance with WhatsApp's Terms of Service. Excessive messaging or spam may result in account bans.

import { authenticate } from '../../hooks/authenticate.js';
import { rateLimiter } from '../../hooks/rateLimiter.js';

export default async function contactRoutes(fastify) {
  const preHandler = [authenticate, rateLimiter()];

  async function assertConnected(tenantId, instanceId, reply) {
    const { rows } = await fastify.db.query(
      'SELECT id FROM instances WHERE id = $1 AND tenant_id = $2',
      [instanceId, tenantId],
    );
    if (!rows.length) { reply.code(404).send({ error: 'Instance not found' }); return false; }
    const status = await fastify.redis.get(`instance:${instanceId}:status`);
    if (status !== 'connected') {
      reply.code(503).send({ error: 'Instance not connected', status: status || 'unknown' });
      return false;
    }
    return true;
  }

  // ── GET /v1/instances/:id/contacts ─────────────────────────────────────────
  fastify.get('/instances/:id/contacts', {
    preHandler,
    schema: {
      tags: ['Contacts'],
      summary: 'List contacts',
      description: 'Returns all WhatsApp contacts saved on the connected number.',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', default: 100, maximum: 500 },
          search: { type: 'string', description: 'Filter by name or phone' },
        },
      },
    },
  }, async (request, reply) => {
    const { id: instanceId } = request.params;
    if (!await assertConnected(request.tenant.id, instanceId, reply)) return;
    return rpcCall(fastify.redis, instanceId, 'getContacts', {
      limit: request.query.limit,
      search: request.query.search,
    });
  });

  // ── GET /v1/instances/:id/contacts/:contactId ──────────────────────────────
  fastify.get('/instances/:id/contacts/:contactId', {
    preHandler,
    schema: {
      tags: ['Contacts'],
      summary: 'Get contact',
      description: 'Returns detailed info for a specific contact, including profile picture URL.',
      params: {
        type: 'object',
        required: ['id', 'contactId'],
        properties: { id: { type: 'string', format: 'uuid' }, contactId: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { id: instanceId, contactId } = request.params;
    if (!await assertConnected(request.tenant.id, instanceId, reply)) return;
    const result = await rpcCall(fastify.redis, instanceId, 'getContact', { contactId });
    if (!result) return reply.code(404).send({ error: 'Contact not found' });
    return result;
  });

  // ── POST /v1/instances/:id/contacts/check ─────────────────────────────────
  fastify.post('/instances/:id/contacts/check', {
    preHandler,
    schema: {
      tags: ['Contacts'],
      summary: 'Check if number is on WhatsApp',
      description: 'Verifies whether one or more phone numbers are registered on WhatsApp.',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['phones'],
        properties: {
          phones: {
            type: 'array',
            maxItems: 20,
            items: { type: 'string', description: 'Phone with country code (e.g. 5491155556666)' },
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  phone: { type: 'string' },
                  isOnWhatsApp: { type: 'boolean' },
                  jid: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { id: instanceId } = request.params;
    if (!await assertConnected(request.tenant.id, instanceId, reply)) return;
    const result = await rpcCall(fastify.redis, instanceId, 'checkPhones', { phones: request.body.phones });
    return { data: result };
  });
}

async function rpcCall(redis, instanceId, method, params, timeoutMs = 12_000) {
  const callId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const responseKey = `rpc:response:${callId}`;
  await redis.publish('instance:rpc', JSON.stringify({ callId, instanceId, method, params }));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = await redis.get(responseKey);
    if (raw) {
      await redis.del(responseKey);
      const { result, error } = JSON.parse(raw);
      if (error) throw new Error(error);
      return result;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`RPC timeout: ${method} on ${instanceId}`);
}

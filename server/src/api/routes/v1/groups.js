import { authenticate } from '../../hooks/authenticate.js';
import { rateLimiter } from '../../hooks/rateLimiter.js';

export default async function groupRoutes(fastify) {
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

  // ── GET /v1/instances/:id/groups ──────────────────────────────────────────
  fastify.get('/instances/:id/groups', {
    preHandler,
    schema: {
      tags: ['Groups'],
      summary: 'List groups',
      description: 'Returns all WhatsApp groups the instance belongs to.',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const { id: instanceId } = request.params;
    if (!await assertConnected(request.tenant.id, instanceId, reply)) return;
    const groups = await rpcCall(fastify.redis, instanceId, 'getGroups', {});
    return { data: groups, total: groups.length };
  });

  // ── POST /v1/instances/:id/groups ─────────────────────────────────────────
  fastify.post('/instances/:id/groups', {
    preHandler,
    schema: {
      tags: ['Groups'],
      summary: 'Create group',
      description: 'Creates a new WhatsApp group with the specified participants.',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['name', 'participants'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100, description: 'Group subject/title' },
          participants: {
            type: 'array',
            minItems: 1,
            maxItems: 1024,
            items: { type: 'string', description: 'Phone number with country code' },
          },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            groupId: { type: 'string' },
            name: { type: 'string' },
            inviteCode: { type: 'string', nullable: true },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { id: instanceId } = request.params;
    if (!await assertConnected(request.tenant.id, instanceId, reply)) return;
    const result = await rpcCall(fastify.redis, instanceId, 'createGroup', {
      name: request.body.name,
      participants: request.body.participants,
    });
    return reply.code(201).send(result);
  });

  // ── GET /v1/instances/:id/groups/:groupId ─────────────────────────────────
  fastify.get('/instances/:id/groups/:groupId', {
    preHandler,
    schema: {
      tags: ['Groups'],
      summary: 'Get group',
      description: 'Returns group info including participants, admins, and invite link.',
      params: {
        type: 'object',
        required: ['id', 'groupId'],
        properties: { id: { type: 'string', format: 'uuid' }, groupId: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { id: instanceId, groupId } = request.params;
    if (!await assertConnected(request.tenant.id, instanceId, reply)) return;
    const result = await rpcCall(fastify.redis, instanceId, 'getGroup', { groupId });
    if (!result) return reply.code(404).send({ error: 'Group not found' });
    return result;
  });

  // ── POST /v1/instances/:id/groups/:groupId/participants ───────────────────
  fastify.post('/instances/:id/groups/:groupId/participants', {
    preHandler,
    schema: {
      tags: ['Groups'],
      summary: 'Add participants',
      description: 'Adds one or more participants to a group. Requires admin rights.',
      params: {
        type: 'object',
        required: ['id', 'groupId'],
        properties: { id: { type: 'string', format: 'uuid' }, groupId: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['participants'],
        properties: {
          participants: { type: 'array', items: { type: 'string' }, description: 'Phone numbers to add' },
        },
      },
    },
  }, async (request, reply) => {
    const { id: instanceId, groupId } = request.params;
    if (!await assertConnected(request.tenant.id, instanceId, reply)) return;
    const result = await rpcCall(fastify.redis, instanceId, 'addGroupParticipants', {
      groupId, participants: request.body.participants,
    });
    return result;
  });

  // ── DELETE /v1/instances/:id/groups/:groupId/participants/:phone ──────────
  fastify.delete('/instances/:id/groups/:groupId/participants/:phone', {
    preHandler,
    schema: {
      tags: ['Groups'],
      summary: 'Remove participant',
      description: 'Removes a participant from a group. Requires admin rights.',
      params: {
        type: 'object',
        required: ['id', 'groupId', 'phone'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          groupId: { type: 'string' },
          phone: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { id: instanceId, groupId, phone } = request.params;
    if (!await assertConnected(request.tenant.id, instanceId, reply)) return;
    const result = await rpcCall(fastify.redis, instanceId, 'removeGroupParticipant', { groupId, phone });
    return result;
  });

  // ── POST /v1/instances/:id/groups/:groupId/leave ──────────────────────────
  fastify.post('/instances/:id/groups/:groupId/leave', {
    preHandler,
    schema: {
      tags: ['Groups'],
      summary: 'Leave group',
      description: 'Makes the WhatsApp instance leave the specified group.',
      params: {
        type: 'object',
        required: ['id', 'groupId'],
        properties: { id: { type: 'string', format: 'uuid' }, groupId: { type: 'string' } },
      },
      response: {
        200: { type: 'object', properties: { message: { type: 'string' } } },
      },
    },
  }, async (request, reply) => {
    const { id: instanceId, groupId } = request.params;
    if (!await assertConnected(request.tenant.id, instanceId, reply)) return;
    await rpcCall(fastify.redis, instanceId, 'leaveGroup', { groupId });
    return { message: 'Left group successfully' };
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

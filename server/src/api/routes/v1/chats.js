import { authenticate } from '../../hooks/authenticate.js';
import { rateLimiter } from '../../hooks/rateLimiter.js';

export default async function chatRoutes(fastify) {
  const preHandler = [authenticate, rateLimiter()];

  async function assertInstance(tenantId, instanceId, reply) {
    const { rows } = await fastify.db.query(
      'SELECT id FROM instances WHERE id = $1 AND tenant_id = $2',
      [instanceId, tenantId],
    );
    if (!rows.length) { reply.code(404).send({ error: 'Instance not found' }); return false; }
    return true;
  }

  async function requireConnected(instanceId, reply) {
    const status = await fastify.redis.get(`instance:${instanceId}:status`);
    if (status !== 'connected') {
      reply.code(503).send({ error: 'Instance not connected', status: status || 'unknown' });
      return false;
    }
    return true;
  }

  // ── GET /v1/instances/:id/chats ───────────────────────────────────────────
  fastify.get('/instances/:id/chats', {
    preHandler,
    schema: {
      tags: ['Chats'],
      summary: 'List chats',
      description: 'Returns all chats (private + groups) for the instance. Requires instance to be connected.',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', default: 50, minimum: 1, maximum: 200 },
          archived: { type: 'boolean', default: false },
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
                  id: { type: 'string' },
                  name: { type: 'string' },
                  isGroup: { type: 'boolean' },
                  isReadOnly: { type: 'boolean' },
                  unreadCount: { type: 'integer' },
                  timestamp: { type: 'number' },
                  archived: { type: 'boolean' },
                  pinned: { type: 'boolean' },
                  lastMessage: { type: 'object', nullable: true },
                },
              },
            },
            total: { type: 'integer' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { id: instanceId } = request.params;
    if (!await assertInstance(request.tenant.id, instanceId, reply)) return;
    if (!await requireConnected(instanceId, reply)) return;

    // Dispatch to worker via Redis RPC
    const result = await rpcCall(fastify.redis, instanceId, 'getChats', {
      limit: request.query.limit,
      archived: request.query.archived,
    });

    return { data: result, total: result.length };
  });

  // ── GET /v1/instances/:id/chats/:chatId ───────────────────────────────────
  fastify.get('/instances/:id/chats/:chatId', {
    preHandler,
    schema: {
      tags: ['Chats'],
      summary: 'Get chat',
      description: 'Returns a specific chat by ID.',
      params: {
        type: 'object',
        required: ['id', 'chatId'],
        properties: { id: { type: 'string', format: 'uuid' }, chatId: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { id: instanceId, chatId } = request.params;
    if (!await assertInstance(request.tenant.id, instanceId, reply)) return;
    if (!await requireConnected(instanceId, reply)) return;

    const result = await rpcCall(fastify.redis, instanceId, 'getChat', { chatId });
    if (!result) return reply.code(404).send({ error: 'Chat not found' });
    return result;
  });

  // ── GET /v1/instances/:id/chats/:chatId/messages ──────────────────────────
  fastify.get('/instances/:id/chats/:chatId/messages', {
    preHandler,
    schema: {
      tags: ['Chats'],
      summary: 'Get chat messages',
      description: 'Fetches message history for a chat.',
      params: {
        type: 'object',
        required: ['id', 'chatId'],
        properties: { id: { type: 'string', format: 'uuid' }, chatId: { type: 'string' } },
      },
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', default: 50, minimum: 1, maximum: 100 },
          fromMessageId: { type: 'string', description: 'Cursor — load messages before this ID' },
        },
      },
    },
  }, async (request, reply) => {
    const { id: instanceId, chatId } = request.params;
    if (!await assertInstance(request.tenant.id, instanceId, reply)) return;
    if (!await requireConnected(instanceId, reply)) return;

    const result = await rpcCall(fastify.redis, instanceId, 'getChatMessages', {
      chatId,
      limit: request.query.limit,
      fromMessageId: request.query.fromMessageId,
    });

    return { data: result, total: result.length };
  });

  // ── POST /v1/instances/:id/chats/:chatId/read ─────────────────────────────
  fastify.post('/instances/:id/chats/:chatId/read', {
    preHandler,
    schema: {
      tags: ['Chats'],
      summary: 'Mark chat as read',
      description: 'Sends read receipts for all unread messages in a chat.',
      params: {
        type: 'object',
        required: ['id', 'chatId'],
        properties: { id: { type: 'string', format: 'uuid' }, chatId: { type: 'string' } },
      },
      response: {
        200: { type: 'object', properties: { message: { type: 'string' } } },
      },
    },
  }, async (request, reply) => {
    const { id: instanceId, chatId } = request.params;
    if (!await assertInstance(request.tenant.id, instanceId, reply)) return;
    if (!await requireConnected(instanceId, reply)) return;

    await rpcCall(fastify.redis, instanceId, 'markChatRead', { chatId });
    return { message: 'Chat marked as read' };
  });
}

/**
 * Simple Redis pub/sub RPC — sends a command to the worker and waits for a response.
 */
async function rpcCall(redis, instanceId, method, params, timeoutMs = 12_000) {
  const callId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const responseKey = `rpc:response:${callId}`;

  await redis.publish('instance:rpc', JSON.stringify({ callId, instanceId, method, params }));

  // Wait for response (worker writes to responseKey)
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
  throw new Error(`RPC timeout: ${method} on instance ${instanceId}`);
}

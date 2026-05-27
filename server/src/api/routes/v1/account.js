import { createHash, randomBytes } from 'crypto';
import { authenticate } from '../../hooks/authenticate.js';
import { rateLimiter } from '../../hooks/rateLimiter.js';

export default async function accountRoutes(fastify) {
  const preHandler = [authenticate, rateLimiter()];

  // ── GET /v1/account ──────────────────────────────────────────────────────
  fastify.get('/account', {
    preHandler,
    schema: {
      tags: ['Account'],
      summary: 'Get account info',
      description: 'Returns current tenant details, plan, and usage.',
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            email: { type: 'string' },
            plan: { type: 'string' },
            maxInstances: { type: 'integer' },
            instancesUsed: { type: 'integer' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { id, name, email, plan, maxInstances } = request.tenant;
    const { rows } = await fastify.db.query(
      'SELECT COUNT(*)::int AS used FROM instances WHERE tenant_id = $1',
      [id],
    );
    return { id, name, email, plan, maxInstances, instancesUsed: rows[0].used };
  });

  // ── GET /v1/account/api-keys ─────────────────────────────────────────────
  fastify.get('/account/api-keys', {
    preHandler,
    schema: {
      tags: ['Account'],
      summary: 'List API keys',
      description: 'Returns all API keys for the current tenant (keys are masked).',
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
                  keyPrefix: { type: 'string', description: 'First 12 chars of the key' },
                  lastUsedAt: { type: 'string', nullable: true },
                  expiresAt: { type: 'string', nullable: true },
                  createdAt: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { rows } = await fastify.db.query(
      `SELECT id, name, key_prefix AS "keyPrefix",
              last_used_at AS "lastUsedAt", expires_at AS "expiresAt",
              created_at AS "createdAt"
       FROM   api_keys
       WHERE  tenant_id = $1
       ORDER  BY created_at DESC`,
      [request.tenant.id],
    );
    return { data: rows };
  });

  // ── POST /v1/account/api-keys ─────────────────────────────────────────────
  fastify.post('/account/api-keys', {
    preHandler,
    schema: {
      tags: ['Account'],
      summary: 'Create API key',
      description: 'Creates a new API key. The full key is shown **only once** in the response.',
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Friendly name for this key' },
          expiresAt: { type: 'string', format: 'date-time', description: 'Optional expiry date' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            key: { type: 'string', description: 'Full API key — save it now, will not be shown again' },
            keyPrefix: { type: 'string' },
            expiresAt: { type: 'string', nullable: true },
            createdAt: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { name, expiresAt } = request.body || {};
    const rawKey = `wasp_${randomBytes(24).toString('hex')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.slice(0, 12);

    const { rows: [row] } = await fastify.db.query(
      `INSERT INTO api_keys (tenant_id, name, key_hash, key_prefix, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, key_prefix AS "keyPrefix", expires_at AS "expiresAt", created_at AS "createdAt"`,
      [request.tenant.id, name || null, keyHash, keyPrefix, expiresAt || null],
    );

    return reply.code(201).send({ ...row, key: rawKey });
  });

  // ── DELETE /v1/account/api-keys/:id ──────────────────────────────────────
  fastify.delete('/account/api-keys/:id', {
    preHandler,
    schema: {
      tags: ['Account'],
      summary: 'Revoke API key',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      response: {
        200: { type: 'object', properties: { message: { type: 'string' } } },
        404: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  }, async (request, reply) => {
    const { rowCount } = await fastify.db.query(
      'DELETE FROM api_keys WHERE id = $1 AND tenant_id = $2',
      [request.params.id, request.tenant.id],
    );
    if (!rowCount) return reply.code(404).send({ error: 'API key not found' });
    return { message: 'API key revoked successfully' };
  });
}

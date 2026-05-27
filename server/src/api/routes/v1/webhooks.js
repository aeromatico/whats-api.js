import { authenticate } from '../../hooks/authenticate.js';
import { rateLimiter } from '../../hooks/rateLimiter.js';

const VALID_EVENTS = [
  'message', 'message_create', 'message_ack', 'message_revoked',
  'call', 'group_join', 'group_leave', 'group_update', 'group_admin_changed',
  'disconnected', 'qr', 'authenticated', 'contact_changed',
];

const webhookSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    instanceId: { type: 'string', nullable: true, description: 'Null = all instances' },
    url: { type: 'string', format: 'uri' },
    events: { type: 'array', items: { type: 'string' } },
    isActive: { type: 'boolean' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
};

export default async function webhookRoutes(fastify) {
  const preHandler = [authenticate, rateLimiter()];

  // ── GET /v1/webhooks ──────────────────────────────────────────────────────
  fastify.get('/webhooks', {
    preHandler,
    schema: {
      tags: ['Webhooks'],
      summary: 'List webhooks',
      description: 'Returns all webhook configurations for the current tenant.',
      response: {
        200: { type: 'object', properties: { data: { type: 'array', items: webhookSchema }, total: { type: 'integer' } } },
      },
    },
  }, async (request, reply) => {
    const { rows } = await fastify.db.query(
      `SELECT id, instance_id AS "instanceId", url, secret IS NOT NULL AS "hasSigning",
              events, is_active AS "isActive", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM   webhooks WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [request.tenant.id],
    );
    return { data: rows, total: rows.length };
  });

  // ── POST /v1/webhooks ─────────────────────────────────────────────────────
  fastify.post('/webhooks', {
    preHandler,
    schema: {
      tags: ['Webhooks'],
      summary: 'Create webhook',
      description: `
Creates a new webhook endpoint.

**Webhook signature**: If you provide a \`secret\`, each delivery will include a \`X-Webhook-Signature\` header
containing \`sha256=<hmac>\`. Verify it on your server:
\`\`\`js
const sig = createHmac('sha256', secret).update(rawBody).digest('hex');
assert(sig === req.headers['x-webhook-signature'].replace('sha256=', ''));
\`\`\`

**Available events**: ${VALID_EVENTS.join(', ')}
      `.trim(),
      body: {
        type: 'object',
        required: ['url', 'events'],
        properties: {
          url: { type: 'string', format: 'uri', description: 'Your HTTPS endpoint to receive events' },
          instanceId: { type: 'string', format: 'uuid', description: 'Limit to a specific instance (omit for all)' },
          secret: { type: 'string', minLength: 8, description: 'Signing secret for HMAC-SHA256 verification' },
          events: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', enum: VALID_EVENTS },
            description: 'Events to subscribe to',
          },
        },
      },
      response: { 201: webhookSchema },
    },
  }, async (request, reply) => {
    const { url, instanceId, secret, events } = request.body;

    // Validate instanceId belongs to tenant
    if (instanceId) {
      const { rows } = await fastify.db.query(
        'SELECT id FROM instances WHERE id = $1 AND tenant_id = $2',
        [instanceId, request.tenant.id],
      );
      if (!rows.length) return reply.code(404).send({ error: 'Instance not found' });
    }

    const { rows: [wh] } = await fastify.db.query(
      `INSERT INTO webhooks (tenant_id, instance_id, url, secret, events)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, instance_id AS "instanceId", url, events,
                 is_active AS "isActive", created_at AS "createdAt", updated_at AS "updatedAt"`,
      [request.tenant.id, instanceId || null, url, secret || null, events],
    );

    return reply.code(201).send(wh);
  });

  // ── PUT /v1/webhooks/:id ──────────────────────────────────────────────────
  fastify.put('/webhooks/:id', {
    preHandler,
    schema: {
      tags: ['Webhooks'],
      summary: 'Update webhook',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        properties: {
          url: { type: 'string', format: 'uri' },
          events: { type: 'array', items: { type: 'string', enum: VALID_EVENTS } },
          secret: { type: 'string' },
          isActive: { type: 'boolean' },
        },
      },
      response: { 200: webhookSchema },
    },
  }, async (request, reply) => {
    const { url, events, secret, isActive } = request.body;
    const { rows: [wh] } = await fastify.db.query(
      `UPDATE webhooks
       SET url       = COALESCE($3, url),
           events    = COALESCE($4, events),
           secret    = COALESCE($5, secret),
           is_active = COALESCE($6, is_active),
           updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, instance_id AS "instanceId", url, events,
                 is_active AS "isActive", created_at AS "createdAt", updated_at AS "updatedAt"`,
      [request.params.id, request.tenant.id, url, events, secret, isActive],
    );
    if (!wh) return reply.code(404).send({ error: 'Webhook not found' });
    return wh;
  });

  // ── DELETE /v1/webhooks/:id ───────────────────────────────────────────────
  fastify.delete('/webhooks/:id', {
    preHandler,
    schema: {
      tags: ['Webhooks'],
      summary: 'Delete webhook',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      response: { 200: { type: 'object', properties: { message: { type: 'string' } } } },
    },
  }, async (request, reply) => {
    const { rowCount } = await fastify.db.query(
      'DELETE FROM webhooks WHERE id = $1 AND tenant_id = $2',
      [request.params.id, request.tenant.id],
    );
    if (!rowCount) return reply.code(404).send({ error: 'Webhook not found' });
    return { message: 'Webhook deleted' };
  });

  // ── POST /v1/webhooks/:id/test ────────────────────────────────────────────
  fastify.post('/webhooks/:id/test', {
    preHandler,
    schema: {
      tags: ['Webhooks'],
      summary: 'Test webhook',
      description: 'Sends a test event to the webhook URL and returns the response.',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            httpStatus: { type: 'integer' },
            durationMs: { type: 'number' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { rows: [wh] } = await fastify.db.query(
      'SELECT id, url, secret FROM webhooks WHERE id = $1 AND tenant_id = $2',
      [request.params.id, request.tenant.id],
    );
    if (!wh) return reply.code(404).send({ error: 'Webhook not found' });

    const payload = {
      event: 'test',
      timestamp: new Date().toISOString(),
      data: { message: 'This is a test event from WhatsApp SaaS API' },
    };

    const { deliverWebhook } = await import('../../../worker/processors/webhook.js');
    const result = await deliverWebhook(wh.url, wh.secret, 'test', payload);

    return {
      success: result.success,
      httpStatus: result.httpStatus,
      durationMs: result.durationMs,
    };
  });

  // ── GET /v1/webhooks/:id/deliveries ───────────────────────────────────────
  fastify.get('/webhooks/:id/deliveries', {
    preHandler,
    schema: {
      tags: ['Webhooks'],
      summary: 'Delivery history',
      description: 'Returns the delivery history for a webhook, including failed attempts.',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', default: 50, maximum: 200 },
          status: { type: 'string', enum: ['pending', 'success', 'failed'] },
        },
      },
    },
  }, async (request, reply) => {
    const { rows: [wh] } = await fastify.db.query(
      'SELECT id FROM webhooks WHERE id = $1 AND tenant_id = $2',
      [request.params.id, request.tenant.id],
    );
    if (!wh) return reply.code(404).send({ error: 'Webhook not found' });

    const statusFilter = request.query.status ? 'AND status = $3' : '';
    const params = [wh.id, request.query.limit];
    if (request.query.status) params.push(request.query.status);

    const { rows } = await fastify.db.query(
      `SELECT id, event_type AS "eventType", status, http_status AS "httpStatus",
              attempts, created_at AS "createdAt", next_retry_at AS "nextRetryAt"
       FROM   webhook_deliveries
       WHERE  webhook_id = $1 ${statusFilter}
       ORDER  BY created_at DESC LIMIT $2`,
      params,
    );

    return { data: rows, total: rows.length };
  });
}

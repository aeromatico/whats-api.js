import { authenticate } from '../../hooks/authenticate.js';
import { rateLimiter } from '../../hooks/rateLimiter.js';

const instanceSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    status: { type: 'string', enum: ['disconnected', 'initializing', 'qr_pending', 'connected', 'error'] },
    phoneNumber: { type: 'string', nullable: true },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
};

export default async function instanceRoutes(fastify) {
  const preHandler = [authenticate, rateLimiter()];

  // Helper — ensure instance belongs to tenant
  async function getOwnedInstance(tenantId, instanceId) {
    const { rows } = await fastify.db.query(
      `SELECT id, tenant_id AS "tenantId", name, status, phone_number AS "phoneNumber",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM   instances WHERE id = $1 AND tenant_id = $2`,
      [instanceId, tenantId],
    );
    return rows[0] || null;
  }

  // ── GET /v1/instances ────────────────────────────────────────────────────
  fastify.get('/instances', {
    preHandler,
    schema: {
      tags: ['Instances'],
      summary: 'List instances',
      description: 'Returns all WhatsApp instances for the current tenant.',
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'array', items: instanceSchema },
            total: { type: 'integer' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { rows } = await fastify.db.query(
      `SELECT id, name, status, phone_number AS "phoneNumber",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM   instances WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [request.tenant.id],
    );
    return { data: rows, total: rows.length };
  });

  // ── POST /v1/instances ───────────────────────────────────────────────────
  fastify.post('/instances', {
    preHandler,
    schema: {
      tags: ['Instances'],
      summary: 'Create instance',
      description: 'Creates a new WhatsApp instance. After creation, call `/connect` to get the QR code.',
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100, description: 'Friendly name' },
        },
      },
      response: {
        201: instanceSchema,
        400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        409: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
      },
    },
  }, async (request, reply) => {
    const { id: tenantId, maxInstances } = request.tenant;

    // Enforce plan limit
    const { rows: [{ count }] } = await fastify.db.query(
      'SELECT COUNT(*)::int AS count FROM instances WHERE tenant_id = $1',
      [tenantId],
    );
    if (count >= maxInstances) {
      return reply.code(409).send({
        error: 'Conflict',
        message: `Instance limit reached (${maxInstances} for your plan). Upgrade to add more.`,
      });
    }

    const { rows: [instance] } = await fastify.db.query(
      `INSERT INTO instances (tenant_id, name, status)
       VALUES ($1, $2, 'disconnected')
       RETURNING id, name, status, phone_number AS "phoneNumber",
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [tenantId, request.body.name],
    );

    return reply.code(201).send(instance);
  });

  // ── GET /v1/instances/:id ─────────────────────────────────────────────────
  fastify.get('/instances/:id', {
    preHandler,
    schema: {
      tags: ['Instances'],
      summary: 'Get instance',
      description: 'Returns details and current status of a specific instance.',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      response: { 200: instanceSchema, 404: { type: 'object', properties: { error: { type: 'string' } } } },
    },
  }, async (request, reply) => {
    const instance = await getOwnedInstance(request.tenant.id, request.params.id);
    if (!instance) return reply.code(404).send({ error: 'Instance not found' });

    // Augment with live status from InstanceManager (if worker is running)
    const liveStatus = await fastify.redis.get(`instance:${instance.id}:status`);
    if (liveStatus) instance.status = liveStatus;

    return instance;
  });

  // ── DELETE /v1/instances/:id ──────────────────────────────────────────────
  fastify.delete('/instances/:id', {
    preHandler,
    schema: {
      tags: ['Instances'],
      summary: 'Delete instance',
      description: 'Deletes an instance, disconnects it, and removes the session.',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      response: {
        200: { type: 'object', properties: { message: { type: 'string' } } },
        404: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  }, async (request, reply) => {
    const instance = await getOwnedInstance(request.tenant.id, request.params.id);
    if (!instance) return reply.code(404).send({ error: 'Instance not found' });

    // Signal worker to destroy instance
    await fastify.redis.publish('instance:command', JSON.stringify({
      command: 'destroy',
      instanceId: instance.id,
    }));

    await fastify.db.query('DELETE FROM instances WHERE id = $1', [instance.id]);

    return { message: 'Instance deleted successfully' };
  });

  // ── GET /v1/instances/:id/status ─────────────────────────────────────────
  fastify.get('/instances/:id/status', {
    preHandler,
    schema: {
      tags: ['Instances'],
      summary: 'Get live status',
      description: 'Returns the real-time connection status of the instance.',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      response: {
        200: {
          type: 'object',
          properties: {
            instanceId: { type: 'string' },
            status: { type: 'string' },
            phoneNumber: { type: 'string', nullable: true },
          },
        },
      },
    },
  }, async (request, reply) => {
    const instance = await getOwnedInstance(request.tenant.id, request.params.id);
    if (!instance) return reply.code(404).send({ error: 'Instance not found' });

    const liveStatus = await fastify.redis.get(`instance:${instance.id}:status`) || instance.status;
    const phoneNumber = await fastify.redis.get(`instance:${instance.id}:phone`) || instance.phoneNumber;

    return { instanceId: instance.id, status: liveStatus, phoneNumber };
  });

  // ── POST /v1/instances/:id/connect ───────────────────────────────────────
  fastify.post('/instances/:id/connect', {
    preHandler,
    schema: {
      tags: ['Instances'],
      summary: 'Connect instance',
      description: 'Starts the WhatsApp connection process. Poll `/qr` for the QR code to scan.',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      response: {
        202: { type: 'object', properties: { message: { type: 'string' }, qrUrl: { type: 'string' } } },
      },
    },
  }, async (request, reply) => {
    const instance = await getOwnedInstance(request.tenant.id, request.params.id);
    if (!instance) return reply.code(404).send({ error: 'Instance not found' });

    await fastify.redis.publish('instance:command', JSON.stringify({
      command: 'connect',
      instanceId: instance.id,
    }));

    return reply.code(202).send({
      message: 'Connection initiated. Scan the QR code.',
      qrUrl: `/v1/instances/${instance.id}/qr`,
    });
  });

  // ── GET /v1/instances/:id/qr ─────────────────────────────────────────────
  fastify.get('/instances/:id/qr', {
    preHandler,
    schema: {
      tags: ['Instances'],
      summary: 'Get QR code',
      description: 'Returns the current QR code as a base64-encoded PNG. Returns 404 if no QR is available (already connected or not yet initialized).',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      response: {
        200: {
          type: 'object',
          properties: {
            qr: { type: 'string', description: 'Base64-encoded QR code PNG' },
            expiresIn: { type: 'number', description: 'Seconds until QR expires' },
          },
        },
        404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
      },
    },
  }, async (request, reply) => {
    const instance = await getOwnedInstance(request.tenant.id, request.params.id);
    if (!instance) return reply.code(404).send({ error: 'Instance not found' });

    const qr = await fastify.redis.get(`instance:${instance.id}:qr`);
    if (!qr) {
      return reply.code(404).send({
        error: 'QR not available',
        message: 'No QR code available. Call /connect first, or instance may already be connected.',
      });
    }

    const ttl = await fastify.redis.ttl(`instance:${instance.id}:qr`);
    return { qr, expiresIn: ttl };
  });

  // ── POST /v1/instances/:id/logout ────────────────────────────────────────
  fastify.post('/instances/:id/logout', {
    preHandler,
    schema: {
      tags: ['Instances'],
      summary: 'Logout instance',
      description: 'Logs out the WhatsApp session and clears session data.',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      response: {
        200: { type: 'object', properties: { message: { type: 'string' } } },
      },
    },
  }, async (request, reply) => {
    const instance = await getOwnedInstance(request.tenant.id, request.params.id);
    if (!instance) return reply.code(404).send({ error: 'Instance not found' });

    await fastify.redis.publish('instance:command', JSON.stringify({
      command: 'logout',
      instanceId: instance.id,
    }));

    return { message: 'Logout initiated' };
  });
}

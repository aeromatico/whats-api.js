import { createHash } from 'crypto';

/**
 * Fastify preHandler hook — validates X-API-Key and sets request.tenant.
 * Sets request.tenant = { id, plan, max_instances, ... }
 */
export async function authenticate(request, reply) {
  const rawKey = request.headers['x-api-key'];

  if (!rawKey) {
    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'Missing X-API-Key header',
    });
  }

  const keyHash = createHash('sha256').update(rawKey).digest('hex');

  const { rows } = await request.server.db.query(
    `SELECT ak.id AS key_id, ak.tenant_id, ak.expires_at,
            t.id, t.name, t.email, t.plan, t.max_instances, t.is_active
     FROM   api_keys ak
     JOIN   tenants t ON t.id = ak.tenant_id
     WHERE  ak.key_hash = $1`,
    [keyHash],
  );

  if (!rows.length) {
    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'Invalid API key',
    });
  }

  const row = rows[0];

  if (!row.is_active) {
    return reply.code(403).send({
      error: 'Forbidden',
      message: 'Tenant account is disabled',
    });
  }

  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'API key has expired',
    });
  }

  // Update last_used_at asynchronously — don't block the request
  request.server.db
    .query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [row.key_id])
    .catch(() => {});

  request.tenant = {
    id: row.tenant_id,
    name: row.name,
    email: row.email,
    plan: row.plan,
    maxInstances: row.max_instances,
    keyId: row.key_id,
  };
}

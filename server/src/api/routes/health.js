/**
 * Health check routes — no authentication required.
 */
export default async function healthRoutes(fastify) {
  fastify.get(
    '/health',
    {
      schema: {
        tags: ['Health'],
        summary: 'API health check',
        description: 'Returns the health status of the API, database, and Redis.',
        security: [],
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['ok', 'degraded', 'error'] },
              version: { type: 'string' },
              uptime: { type: 'number' },
              services: {
                type: 'object',
                properties: {
                  api: { type: 'string' },
                  database: { type: 'string' },
                  redis: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const services = { api: 'ok', database: 'unknown', redis: 'unknown' };
      let overallStatus = 'ok';

      // Check PostgreSQL
      try {
        await fastify.db.query('SELECT 1');
        services.database = 'ok';
      } catch {
        services.database = 'error';
        overallStatus = 'degraded';
      }

      // Check Redis
      try {
        await fastify.redis.ping();
        services.redis = 'ok';
      } catch {
        services.redis = 'error';
        overallStatus = 'degraded';
      }

      return reply.code(overallStatus === 'ok' ? 200 : 503).send({
        status: overallStatus,
        version: '1.0.0',
        uptime: process.uptime(),
        services,
      });
    },
  );

  fastify.get(
    '/health/instances',
    {
      schema: {
        tags: ['Health'],
        summary: 'Instance status overview',
        description: 'Returns status counts for all WhatsApp instances in the system.',
        security: [],
        response: {
          200: {
            type: 'object',
            properties: {
              total: { type: 'integer' },
              connected: { type: 'integer' },
              disconnected: { type: 'integer' },
              qr_pending: { type: 'integer' },
              error: { type: 'integer' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { rows } = await fastify.db.query(`
        SELECT status, COUNT(*)::int AS count
        FROM   instances
        GROUP  BY status
      `);

      const counts = { total: 0, connected: 0, disconnected: 0, qr_pending: 0, error: 0 };
      for (const row of rows) {
        counts[row.status] = row.count;
        counts.total += row.count;
      }

      return reply.send(counts);
    },
  );
}

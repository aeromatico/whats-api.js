import { config } from '../../config/index.js';

const PLAN_LIMITS = {
  free: config.rateLimit.free,
  starter: config.rateLimit.starter,
  pro: config.rateLimit.pro,
  enterprise: config.rateLimit.enterprise,
};

/**
 * Returns a Fastify preHandler that enforces per-tenant rate limits using Redis.
 * Uses a sliding window counter (1-minute window).
 *
 * @param {object} [opts]
 * @param {number} [opts.multiplier=1] — override limit (e.g. 0.1 for tighter message route)
 */
export function rateLimiter({ multiplier = 1 } = {}) {
  return async function rateLimitHandler(request, reply) {
    const tenant = request.tenant;
    if (!tenant) return; // Public routes skip this

    const planLimit = PLAN_LIMITS[tenant.plan] ?? PLAN_LIMITS.free;
    const limit = Math.floor(planLimit * multiplier);
    const window = 60; // seconds
    const key = `rl:${tenant.id}:${Math.floor(Date.now() / 1000 / window)}`;

    const redis = request.server.redis;
    const current = await redis.incr(key);
    if (current === 1) await redis.expire(key, window * 2);

    reply.header('X-RateLimit-Limit', limit);
    reply.header('X-RateLimit-Remaining', Math.max(0, limit - current));
    reply.header('X-RateLimit-Reset', (Math.floor(Date.now() / 1000 / window) + 1) * window);

    if (current > limit) {
      return reply.code(429).send({
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Limit: ${limit} req/min for plan "${tenant.plan}".`,
        retryAfter: window,
      });
    }
  };
}

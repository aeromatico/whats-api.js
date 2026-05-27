import fp from 'fastify-plugin';
import Redis from 'ioredis';
import { config } from '../../config/index.js';

async function redisPlugin(fastify) {
  const redis = new Redis(config.redis.url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });

  redis.on('error', (err) => fastify.log.error({ err }, 'Redis error'));
  redis.on('connect', () => fastify.log.info('Redis connected'));

  fastify.decorate('redis', redis);

  fastify.addHook('onClose', async () => {
    await redis.quit();
    fastify.log.info('Redis connection closed');
  });
}

export default fp(redisPlugin, { name: 'redis' });

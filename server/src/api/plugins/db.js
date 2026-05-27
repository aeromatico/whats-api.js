import fp from 'fastify-plugin';
import { pool, query, transaction } from '../../db/index.js';

async function dbPlugin(fastify) {
  fastify.decorate('db', { pool, query, transaction });

  fastify.addHook('onClose', async () => {
    await pool.end();
    fastify.log.info('PostgreSQL pool closed');
  });
}

export default fp(dbPlugin, { name: 'db' });

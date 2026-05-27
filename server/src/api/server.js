import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { config } from '../config/index.js';

// Plugins
import dbPlugin from './plugins/db.js';
import redisPlugin from './plugins/redis.js';
import swaggerPlugin from './plugins/swagger.js';

// Routes
import healthRoutes from './routes/health.js';
import instanceRoutes from './routes/v1/instances.js';
import messageRoutes from './routes/v1/messages.js';
import chatRoutes from './routes/v1/chats.js';
import contactRoutes from './routes/v1/contacts.js';
import groupRoutes from './routes/v1/groups.js';
import webhookRoutes from './routes/v1/webhooks.js';
import accountRoutes from './routes/v1/account.js';

const fastify = Fastify({
  logger: {
    level: config.isDev ? 'debug' : 'info',
    transport: config.isDev
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
      : undefined,
  },
  ajv: {
    customOptions: {
      removeAdditional: true,
      coerceTypes: true,
      allErrors: false,
    },
  },
});

async function build() {
  // ── Security ──────────────────────────────────────────────────────────────
  await fastify.register(cors, {
    origin: config.isDev ? true : process.env.ALLOWED_ORIGINS?.split(',') || false,
    credentials: true,
  });

  await fastify.register(helmet, {
    contentSecurityPolicy: false, // Swagger UI needs inline scripts
  });

  // ── Core plugins ──────────────────────────────────────────────────────────
  await fastify.register(dbPlugin);
  await fastify.register(redisPlugin);
  await fastify.register(swaggerPlugin);

  // ── Global error handler ──────────────────────────────────────────────────
  fastify.setErrorHandler(async (error, request, reply) => {
    fastify.log.error({ err: error, url: request.url }, error.message);

    // Fastify validation errors
    if (error.validation) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: error.message,
        details: error.validation,
      });
    }

    const statusCode = error.statusCode || 500;
    return reply.code(statusCode).send({
      error: statusCode === 500 ? 'Internal Server Error' : error.name || 'Error',
      message: config.isDev ? error.message : 'An unexpected error occurred',
    });
  });

  fastify.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: 'Not Found',
      message: `Route ${request.method} ${request.url} not found`,
    });
  });

  // ── Routes ────────────────────────────────────────────────────────────────
  // Public
  await fastify.register(healthRoutes);

  // v1 API (all authenticated)
  await fastify.register(async (app) => {
    await app.register(instanceRoutes);
    await app.register(messageRoutes);
    await app.register(chatRoutes);
    await app.register(contactRoutes);
    await app.register(groupRoutes);
    await app.register(webhookRoutes);
    await app.register(accountRoutes);
  }, { prefix: '/v1' });

  return fastify;
}

// Start server
const app = await build();

try {
  await app.listen({ port: config.api.port, host: config.api.host });
  app.log.info(`📘 API Docs: http://localhost:${config.api.port}/docs`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Graceful shutdown
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    app.log.info(`Received ${signal}, shutting down...`);
    await app.close();
    process.exit(0);
  });
}

export { build };

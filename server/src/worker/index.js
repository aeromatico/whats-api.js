/**
 * Worker entry point.
 * - Starts the InstanceManager (manages Puppeteer WhatsApp instances)
 * - Starts BullMQ workers for message sending and webhook delivery
 */
import 'dotenv/config';
import { Worker } from 'bullmq';
import { InstanceManager } from './InstanceManager.js';
import { processMessage } from './processors/sendMessage.js';
import { processWebhook } from './processors/webhook.js';
import { config } from '../config/index.js';

const connection = { url: config.redis.url };

// ── Start InstanceManager ─────────────────────────────────────────────────
const manager = new InstanceManager();
await manager.start();

console.log('[Worker] InstanceManager started');

// ── Message Worker ────────────────────────────────────────────────────────
const messageWorker = new Worker(
  'messages',
  (job) => processMessage(job, manager),
  {
    connection,
    concurrency: 5,
  },
);

messageWorker.on('completed', (job) =>
  console.log(`[Worker] Message job ${job.id} completed`),
);
messageWorker.on('failed', (job, err) =>
  console.error(`[Worker] Message job ${job?.id} failed:`, err.message),
);

// ── Webhook Worker ────────────────────────────────────────────────────────
const webhookWorker = new Worker(
  'webhooks',
  processWebhook,
  {
    connection,
    concurrency: 10,
    settings: {
      backoffStrategy: (attemptsMade, type, err, job) => {
        const delays = config.webhook.retryDelays;
        return delays[attemptsMade - 1] ?? delays[delays.length - 1];
      },
    },
  },
);

webhookWorker.on('completed', (job) =>
  console.log(`[Worker] Webhook job ${job.id} delivered`),
);
webhookWorker.on('failed', (job, err) =>
  console.warn(`[Worker] Webhook job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message),
);

console.log('[Worker] All workers started. Waiting for jobs...');

// ── Graceful shutdown ─────────────────────────────────────────────────────
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    console.log(`[Worker] Received ${signal}, shutting down...`);
    await messageWorker.close();
    await webhookWorker.close();
    await manager.stop();
    process.exit(0);
  });
}

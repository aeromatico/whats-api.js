import { Queue } from 'bullmq';
import { config } from '../config/index.js';

const connection = { url: config.redis.url };

export const webhookQueue = new Queue('webhooks', {
  connection,
  defaultJobOptions: {
    attempts: config.webhook.maxAttempts,
    backoff: { type: 'custom' },  // custom delays handled in processor
    removeOnComplete: { count: 2000, age: 7 * 86400 },
    removeOnFail: { count: 1000, age: 30 * 86400 },
  },
});

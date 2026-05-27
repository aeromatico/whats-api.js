import { Queue, QueueEvents } from 'bullmq';
import { config } from '../config/index.js';

const connection = { url: config.redis.url };

export const messageQueue = new Queue('messages', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 1000, age: 86400 },
    removeOnFail: { count: 500 },
  },
});

// QueueEvents is used by jobs to call waitUntilFinished()
messageQueue.events = new QueueEvents('messages', { connection });

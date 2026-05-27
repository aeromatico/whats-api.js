import { createHmac } from 'crypto';
import { config } from '../../config/index.js';
import { pool } from '../../db/index.js';

/**
 * Delivers a webhook payload to a URL.
 * Returns { success, httpStatus, durationMs }.
 */
export async function deliverWebhook(url, secret, eventType, payload) {
  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'WhatsApp-SaaS-API/1.0',
    'X-Webhook-Event': eventType,
    'X-Webhook-Timestamp': payload.timestamp || new Date().toISOString(),
  };

  if (secret) {
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    headers['X-Webhook-Signature'] = `sha256=${sig}`;
  }

  const start = Date.now();
  try {
    const { default: fetch } = await import('node-fetch');
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      timeout: config.webhook.timeoutMs,
    });
    const durationMs = Date.now() - start;
    return { success: res.ok, httpStatus: res.status, durationMs };
  } catch (err) {
    return { success: false, httpStatus: null, durationMs: Date.now() - start, error: err.message };
  }
}

/**
 * BullMQ processor for webhook delivery jobs.
 * @param {import('bullmq').Job} job
 */
export async function processWebhook(job) {
  const { webhookId, webhookUrl, webhookSecret, eventType, instanceId, payload } = job.data;

  // Log delivery attempt
  let deliveryId;
  try {
    const { rows: [d] } = await pool.query(
      `INSERT INTO webhook_deliveries (webhook_id, instance_id, event_type, payload, status, attempts)
       VALUES ($1, $2, $3, $4, 'pending', 1)
       RETURNING id`,
      [webhookId, instanceId, eventType, JSON.stringify(payload)],
    );
    deliveryId = d.id;
  } catch {}

  const result = await deliverWebhook(webhookUrl, webhookSecret, eventType, payload);

  // Update delivery record
  if (deliveryId) {
    const status = result.success ? 'success' : 'failed';
    const retryDelays = config.webhook.retryDelays;
    const attempt = job.attemptsMade;
    const nextRetry = !result.success && attempt < retryDelays.length
      ? new Date(Date.now() + retryDelays[attempt]).toISOString()
      : null;

    await pool
      .query(
        `UPDATE webhook_deliveries
         SET status=$1, http_status=$2, attempts=$3, next_retry_at=$4
         WHERE id=$5`,
        [status, result.httpStatus, attempt + 1, nextRetry, deliveryId],
      )
      .catch(() => {});
  }

  if (!result.success) {
    // BullMQ will retry based on job options
    const attempt = job.attemptsMade + 1;
    const delays = config.webhook.retryDelays;
    throw Object.assign(
      new Error(`Webhook delivery failed (HTTP ${result.httpStatus || 'timeout'})`),
      { delay: delays[attempt - 1] || delays[delays.length - 1] },
    );
  }

  return result;
}

/**
 * InstanceManager — singleton that manages all active WhatsApp instances.
 * - Loads all persisted instances from DB on startup
 * - Listens to Redis pub/sub for commands from the API
 * - Listens to Redis pub/sub for RPC calls from the API
 * - Dispatches webhook events to the webhook queue
 */
import Redis from 'ioredis';
import { pool } from '../db/index.js';
import { WhatsAppInstance } from './WhatsAppInstance.js';
import { webhookQueue } from '../queues/webhookQueue.js';
import { config } from '../config/index.js';

export class InstanceManager {
  /** @type {Map<string, WhatsAppInstance>} */
  instances = new Map();

  /** @type {Redis} */
  redis;
  /** @type {Redis} subscriber for pub/sub */
  subscriber;
  /** @type {Redis} publisher for RPC responses */
  publisher;

  async start() {
    this.redis = new Redis(config.redis.url);
    this.subscriber = new Redis(config.redis.url);
    this.publisher = new Redis(config.redis.url);

    this.redis.on('error', err => console.error('[InstanceManager] Redis error:', err));

    // Subscribe to command and RPC channels
    await this.subscriber.subscribe('instance:command', 'instance:rpc');
    this.subscriber.on('message', (channel, message) => {
      const data = JSON.parse(message);
      if (channel === 'instance:command') this._handleCommand(data);
      if (channel === 'instance:rpc') this._handleRpc(data);
    });

    // Load all connected/qr_pending instances from DB
    await this._loadInstances();

    console.log(`[InstanceManager] Started. Loaded ${this.instances.size} instance(s).`);
  }

  async stop() {
    for (const [id, inst] of this.instances) {
      console.log(`[InstanceManager] Destroying instance ${id}...`);
      await inst.destroy().catch(() => {});
    }
    await this.subscriber.quit();
    await this.publisher.quit();
    await this.redis.quit();
    await pool.end();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  async _loadInstances() {
    const { rows } = await pool.query(
      `SELECT id FROM instances WHERE status IN ('connected', 'qr_pending', 'authenticated')`,
    );

    for (const row of rows) {
      await this._spawnInstance(row.id);
    }
  }

  async _spawnInstance(instanceId) {
    if (this.instances.has(instanceId)) return;

    const instance = new WhatsAppInstance({
      id: instanceId,
      redis: this.redis,
      onEvent: this._onInstanceEvent.bind(this),
    });

    this.instances.set(instanceId, instance);
    await instance.connect();
  }

  async _destroyInstance(instanceId) {
    const instance = this.instances.get(instanceId);
    if (!instance) return;
    await instance.destroy();
    this.instances.delete(instanceId);
  }

  async _handleCommand({ command, instanceId }) {
    console.log(`[InstanceManager] Command: ${command} → ${instanceId}`);
    try {
      switch (command) {
        case 'connect':
          await this._spawnInstance(instanceId);
          break;
        case 'logout': {
          const inst = this.instances.get(instanceId);
          if (inst) await inst.logout();
          this.instances.delete(instanceId);
          // Update DB status
          await pool.query(
            `UPDATE instances SET status='disconnected', updated_at=NOW() WHERE id=$1`,
            [instanceId],
          );
          break;
        }
        case 'destroy':
          await this._destroyInstance(instanceId);
          break;
      }
    } catch (err) {
      console.error(`[InstanceManager] Command error (${command}):`, err.message);
    }
  }

  async _handleRpc({ callId, instanceId, method, params }) {
    const responseKey = `rpc:response:${callId}`;
    try {
      const instance = this.instances.get(instanceId);
      if (!instance) throw new Error(`Instance ${instanceId} not loaded in worker`);
      const result = await instance.handleRpc(method, params);
      await this.publisher.setex(responseKey, 30, JSON.stringify({ result }));
    } catch (err) {
      await this.publisher.setex(responseKey, 30, JSON.stringify({ error: err.message }));
    }
  }

  async _onInstanceEvent(instanceId, eventType, data) {
    // Update DB status for persistent events
    const statusMap = {
      authenticated: 'connected',
      disconnected: 'disconnected',
      auth_failure: 'error',
      qr: 'qr_pending',
    };

    const newStatus = statusMap[eventType];
    if (newStatus) {
      const extra = data.phone ? ', phone_number = $2' : '';
      const params = data.phone
        ? [newStatus, data.phone, instanceId]
        : [newStatus, instanceId];
      const idx = data.phone ? '$3' : '$2';
      await pool
        .query(
          `UPDATE instances SET status=$1${extra}, updated_at=NOW() WHERE id=${idx}`,
          params,
        )
        .catch(err => console.error('[InstanceManager] DB update error:', err.message));
    }

    // Dispatch to webhook queue
    try {
      // Fetch all active webhooks for this instance
      const { rows } = await pool.query(
        `SELECT wh.id, wh.url, wh.secret, wh.events
         FROM   webhooks wh
         WHERE  wh.is_active = true
           AND  $1 = ANY(wh.events)
           AND  (wh.instance_id = $2 OR wh.instance_id IS NULL)
           AND  wh.tenant_id = (SELECT tenant_id FROM instances WHERE id = $2)`,
        [eventType, instanceId],
      );

      for (const wh of rows) {
        await webhookQueue.add('deliver', {
          webhookId: wh.id,
          webhookUrl: wh.url,
          webhookSecret: wh.secret,
          eventType,
          instanceId,
          payload: { event: eventType, instanceId, timestamp: new Date().toISOString(), data },
        });
      }
    } catch (err) {
      console.error('[InstanceManager] Webhook dispatch error:', err.message);
    }
  }
}

import { authenticate } from '../../hooks/authenticate.js';
import { rateLimiter } from '../../hooks/rateLimiter.js';

export default async function messageRoutes(fastify) {
  const preHandler = [authenticate, rateLimiter({ multiplier: 0.5 })]; // tighter for sends

  // ── POST /v1/instances/:id/messages ──────────────────────────────────────
  fastify.post('/instances/:id/messages', {
    preHandler,
    schema: {
      tags: ['Messages'],
      summary: 'Send message',
      description: `
Send a message from a connected WhatsApp instance.

**Supported types:**
- \`text\` — plain text message
- \`image\` — image with optional caption (provide \`mediaUrl\` or \`mediaBase64\`)
- \`video\` — video file
- \`audio\` — audio file
- \`document\` — any file as document
- \`location\` — geographic coordinates
- \`contact\` — vCard contact

The instance must be in **connected** status.
      `.trim(),
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['to', 'type'],
        properties: {
          to: {
            type: 'string',
            description: 'Recipient phone number with country code (e.g. 5491155556666) or group ID',
            example: '5491155556666',
          },
          type: {
            type: 'string',
            enum: ['text', 'image', 'video', 'audio', 'document', 'location', 'contact'],
            description: 'Message type',
          },
          text: { type: 'string', description: 'Text content (required for type=text)' },
          caption: { type: 'string', description: 'Caption for media messages' },
          mediaUrl: { type: 'string', format: 'uri', description: 'URL of media to send' },
          mediaBase64: { type: 'string', description: 'Base64-encoded media content' },
          mimeType: { type: 'string', description: 'MIME type when using mediaBase64' },
          filename: { type: 'string', description: 'Filename for document messages' },
          latitude: { type: 'number', description: 'Latitude for location messages' },
          longitude: { type: 'number', description: 'Longitude for location messages' },
          locationName: { type: 'string', description: 'Location name/address' },
          replyToMessageId: { type: 'string', description: 'Message ID to reply to' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            messageId: { type: 'string', description: 'WhatsApp message ID' },
            to: { type: 'string' },
            type: { type: 'string' },
            timestamp: { type: 'number' },
            status: { type: 'string', enum: ['sent', 'queued'] },
          },
        },
        400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        404: { type: 'object', properties: { error: { type: 'string' } } },
        503: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
      },
    },
  }, async (request, reply) => {
    const { id: instanceId } = request.params;
    const { to, type, text, caption, mediaUrl, mediaBase64, mimeType, filename,
            latitude, longitude, locationName, replyToMessageId } = request.body;

    // Validate instance ownership
    const { rows } = await fastify.db.query(
      'SELECT id FROM instances WHERE id = $1 AND tenant_id = $2',
      [instanceId, request.tenant.id],
    );
    if (!rows.length) return reply.code(404).send({ error: 'Instance not found' });

    // Check live status
    const status = await fastify.redis.get(`instance:${instanceId}:status`);
    if (status !== 'connected') {
      return reply.code(503).send({
        error: 'Service Unavailable',
        message: `Instance is not connected (current status: ${status || 'unknown'}). Connect it first.`,
      });
    }

    // Validate by type
    if (type === 'text' && !text) {
      return reply.code(400).send({ error: 'Bad Request', message: '`text` is required for type=text' });
    }
    if (['image', 'video', 'audio', 'document'].includes(type) && !mediaUrl && !mediaBase64) {
      return reply.code(400).send({ error: 'Bad Request', message: '`mediaUrl` or `mediaBase64` is required for media messages' });
    }
    if (type === 'location' && (latitude == null || longitude == null)) {
      return reply.code(400).send({ error: 'Bad Request', message: '`latitude` and `longitude` are required for type=location' });
    }

    // Enqueue the message job
    const { messageQueue } = await import('../../../queues/messageQueue.js');
    const job = await messageQueue.add('send', {
      instanceId,
      to,
      type,
      text,
      caption,
      mediaUrl,
      mediaBase64,
      mimeType,
      filename,
      latitude,
      longitude,
      locationName,
      replyToMessageId,
    }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: 500,
    });

    // Wait for result (with timeout) for sync-style UX
    const result = await job.waitUntilFinished(messageQueue.events, 15_000).catch(() => null);

    if (result?.error) {
      return reply.code(400).send({ error: 'Send Failed', message: result.error });
    }

    return {
      messageId: result?.messageId || job.id,
      to,
      type,
      timestamp: Math.floor(Date.now() / 1000),
      status: result ? 'sent' : 'queued',
    };
  });

  // ── POST /v1/instances/:id/messages/bulk ─────────────────────────────────
  fastify.post('/instances/:id/messages/bulk', {
    preHandler,
    schema: {
      tags: ['Messages'],
      summary: 'Bulk send messages',
      description: 'Enqueues multiple messages for async delivery. Returns a job ID to track progress. Max 100 messages per call.',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['messages'],
        properties: {
          messages: {
            type: 'array',
            maxItems: 100,
            items: {
              type: 'object',
              required: ['to', 'type'],
              properties: {
                to: { type: 'string' },
                type: { type: 'string', enum: ['text', 'image', 'video', 'audio', 'document'] },
                text: { type: 'string' },
                mediaUrl: { type: 'string' },
                caption: { type: 'string' },
              },
            },
          },
          delayMs: {
            type: 'integer',
            minimum: 0,
            maximum: 10000,
            default: 500,
            description: 'Delay between messages in milliseconds (to avoid spam detection)',
          },
        },
      },
      response: {
        202: {
          type: 'object',
          properties: {
            jobId: { type: 'string' },
            total: { type: 'integer' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { id: instanceId } = request.params;
    const { messages, delayMs = 500 } = request.body;

    const { rows } = await fastify.db.query(
      'SELECT id FROM instances WHERE id = $1 AND tenant_id = $2',
      [instanceId, request.tenant.id],
    );
    if (!rows.length) return reply.code(404).send({ error: 'Instance not found' });

    const { messageQueue } = await import('../../../queues/messageQueue.js');
    const job = await messageQueue.add('bulk', {
      instanceId,
      messages,
      delayMs,
    }, { removeOnComplete: 500, removeOnFail: 200 });

    return reply.code(202).send({
      jobId: job.id,
      total: messages.length,
      message: `${messages.length} messages queued. They will be sent with a ${delayMs}ms delay between each.`,
    });
  });
}

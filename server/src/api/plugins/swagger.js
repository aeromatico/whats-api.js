import fp from 'fastify-plugin';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';

async function swaggerPlugin(fastify) {
  await fastify.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'WhatsApp SaaS API',
        description: `
## Multi-tenant WhatsApp REST API

Connect WhatsApp numbers, send and receive messages, manage groups, and receive real-time events via webhooks.

### Authentication
All endpoints (except \`/health\`) require an API key in the request header:
\`\`\`
X-API-Key: wasp_<your_key>
\`\`\`

### Rate Limiting
Rate limits vary by plan and are returned in response headers:
- \`X-RateLimit-Limit\` — requests allowed per minute
- \`X-RateLimit-Remaining\` — requests remaining
- \`X-RateLimit-Reset\` — Unix timestamp when the limit resets

### Webhook Events
Configure webhooks to receive real-time events. Each delivery is signed with \`X-Webhook-Signature\` (HMAC-SHA256).
        `.trim(),
        version: '1.0.0',
        contact: {
          name: 'API Support',
          email: 'support@example.com',
        },
        license: {
          name: 'Apache 2.0',
          url: 'https://www.apache.org/licenses/LICENSE-2.0',
        },
      },
      components: {
        securitySchemes: {
          ApiKey: {
            type: 'apiKey',
            in: 'header',
            name: 'X-API-Key',
          },
        },
      },
      security: [{ ApiKey: [] }],
      tags: [
        { name: 'Health', description: 'API health and status' },
        { name: 'Instances', description: 'WhatsApp number instances' },
        { name: 'Messages', description: 'Send and retrieve messages' },
        { name: 'Chats', description: 'Chat management' },
        { name: 'Contacts', description: 'Contact management' },
        { name: 'Groups', description: 'Group management' },
        { name: 'Webhooks', description: 'Webhook configuration and delivery history' },
        { name: 'Account', description: 'Account and API key management' },
      ],
    },
  });

  await fastify.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'tag',
      deepLinking: true,
      displayRequestDuration: true,
      defaultModelsExpandDepth: 3,
      filter: true,
    },
    staticCSP: true,
    transformStaticCSP: (header) => header,
  });
}

export default fp(swaggerPlugin, { name: 'swagger' });

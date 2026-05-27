import 'dotenv/config';

function required(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') === 'development',

  api: {
    port: parseInt(process.env.API_PORT || '3000', 10),
    host: process.env.API_HOST || '0.0.0.0',
  },

  db: {
    url: process.env.DATABASE_URL || 'postgresql://wasp:wasp_secret@localhost:5432/whatsapp_saas',
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  security: {
    jwtSecret: process.env.JWT_SECRET || 'dev_secret_change_in_production_32+',
  },

  rateLimit: {
    free: parseInt(process.env.RATE_LIMIT_FREE || '60', 10),
    starter: parseInt(process.env.RATE_LIMIT_STARTER || '300', 10),
    pro: parseInt(process.env.RATE_LIMIT_PRO || '1000', 10),
    enterprise: parseInt(process.env.RATE_LIMIT_ENTERPRISE || '5000', 10),
  },

  webhook: {
    timeoutMs: parseInt(process.env.WEBHOOK_TIMEOUT_MS || '10000', 10),
    maxAttempts: parseInt(process.env.WEBHOOK_MAX_ATTEMPTS || '5', 10),
    // Delays en ms: 1min, 5min, 30min, 2h, 24h
    retryDelays: [60_000, 300_000, 1_800_000, 7_200_000, 86_400_000],
  },

  sessions: {
    path: process.env.SESSION_PATH || './.wwebjs_sessions',
  },

  puppeteer: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  },
};

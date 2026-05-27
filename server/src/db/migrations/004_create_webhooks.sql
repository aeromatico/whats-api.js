-- Migration 004: webhooks + deliveries
CREATE TABLE IF NOT EXISTS webhooks (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  instance_id   UUID         REFERENCES instances(id) ON DELETE CASCADE,  -- NULL = todos
  url           VARCHAR(500) NOT NULL,
  secret        VARCHAR(255),                    -- HMAC-SHA256 signing secret
  events        TEXT[]       NOT NULL DEFAULT '{}',
  is_active     BOOLEAN      NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhooks_tenant   ON webhooks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_instance ON webhooks(instance_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id     UUID         NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  instance_id    UUID,
  event_type     VARCHAR(100) NOT NULL,
  payload        JSONB        NOT NULL,
  status         VARCHAR(50)  NOT NULL DEFAULT 'pending',  -- pending | success | failed
  http_status    INTEGER,
  response_body  TEXT,
  attempts       INTEGER      NOT NULL DEFAULT 0,
  next_retry_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deliveries_webhook ON webhook_deliveries(webhook_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_status  ON webhook_deliveries(status);

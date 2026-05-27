-- Migration 003: instances
CREATE TABLE IF NOT EXISTS instances (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  status        VARCHAR(50)  NOT NULL DEFAULT 'disconnected',
                             -- disconnected | initializing | qr_pending | connected | error
  phone_number  VARCHAR(50),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_instances_tenant ON instances(tenant_id);
CREATE INDEX IF NOT EXISTS idx_instances_status ON instances(status);

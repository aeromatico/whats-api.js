-- Migration 002: api_keys
CREATE TABLE IF NOT EXISTS api_keys (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          VARCHAR(255),
  key_hash      VARCHAR(64)  UNIQUE NOT NULL,   -- SHA-256 hex del key real
  key_prefix    VARCHAR(16)  NOT NULL,           -- "wasp_abc12345" para identificarlo
  last_used_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash   ON api_keys(key_hash);

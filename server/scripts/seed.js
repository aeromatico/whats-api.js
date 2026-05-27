/**
 * Seed script — creates the first tenant and an API key.
 * Usage: node scripts/seed.js
 * Prints the API key (only shown once — store it safely!).
 */
import { createHash, randomBytes } from 'crypto';
import pg from 'pg';
import 'dotenv/config';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function seed() {
  const client = await pool.connect();
  try {
    // 1. Create default tenant
    const { rows: [tenant] } = await client.query(`
      INSERT INTO tenants (name, email, plan, max_instances)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
      RETURNING id, name, email, plan
    `, ['Default Tenant', 'admin@example.com', 'pro', 10]);

    console.log('\n✓ Tenant:', tenant.name, `(${tenant.id})`);

    // 2. Generate API key
    const rawKey = `wasp_${randomBytes(24).toString('hex')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.slice(0, 12);

    await client.query(`
      INSERT INTO api_keys (tenant_id, name, key_hash, key_prefix)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (key_hash) DO NOTHING
    `, [tenant.id, 'Default Key', keyHash, keyPrefix]);

    console.log('\n✓ API Key created:');
    console.log('  ┌─────────────────────────────────────────────────────────┐');
    console.log(`  │  ${rawKey}  │`);
    console.log('  └─────────────────────────────────────────────────────────┘');
    console.log('\n  ⚠  Save this key — it will NOT be shown again.\n');
    console.log('  Add it to your requests as:');
    console.log('  X-API-Key: ' + rawKey);
    console.log('');
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(err => {
  console.error(err);
  process.exit(1);
});

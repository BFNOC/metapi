import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type ConfigModule = typeof import('../config.js');
type RetentionModule = typeof import('./proxyLogRetentionService.js');

describe('proxyLogRetentionService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let config: ConfigModule['config'];
  let cleanupExpiredProxyLogs: RetentionModule['cleanupExpiredProxyLogs'];
  let getProxyLogRetentionCutoffUtc: RetentionModule['getProxyLogRetentionCutoffUtc'];
  let dataDir = '';
  let originalRetentionDays = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-proxy-log-retention-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const configModule = await import('../config.js');
    const retentionModule = await import('./proxyLogRetentionService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    config = configModule.config;
    cleanupExpiredProxyLogs = retentionModule.cleanupExpiredProxyLogs;
    getProxyLogRetentionCutoffUtc = retentionModule.getProxyLogRetentionCutoffUtc;
    originalRetentionDays = config.proxyLogRetentionDays;
  });

  beforeEach(() => {
    db.delete(schema.proxyLogs).run();
    db.delete(schema.accounts).run();
    db.delete(schema.sites).run();
  });

  afterAll(() => {
    config.proxyLogRetentionDays = originalRetentionDays;
    delete process.env.DATA_DIR;
  });

  function seedAccount(platform = 'new-api') {
    const site = db.insert(schema.sites).values({
      name: `retention-site-${platform}`,
      url: `https://retention-${platform}.example.com`,
      platform,
      status: 'active',
    }).returning().get();

    return db.insert(schema.accounts).values({
      siteId: site.id,
      username: `retention-${platform}`,
      accessToken: `access-${platform}`,
      apiToken: `api-${platform}`,
      status: 'active',
    }).returning().get();
  }

  it('deletes proxy logs older than retention days', () => {
    config.proxyLogRetentionDays = 7;
    const account = seedAccount('new-api');

    db.insert(schema.proxyLogs).values([
      {
        accountId: account.id,
        modelRequested: 'gpt-4o-mini',
        status: 'success',
        createdAt: '2026-02-20 12:00:00',
      },
      {
        accountId: account.id,
        modelRequested: 'gpt-4o-mini',
        status: 'success',
        createdAt: '2026-03-01 12:00:00',
      },
    ]).run();

    const result = cleanupExpiredProxyLogs(Date.parse('2026-03-04T00:00:00Z'));
    expect(result.deleted).toBe(1);

    const rows = db.select().from(schema.proxyLogs).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.createdAt).toBe('2026-03-01 12:00:00');
  });

  it('skips cleanup when retention is disabled', () => {
    config.proxyLogRetentionDays = 0;
    const account = seedAccount('new-api');

    db.insert(schema.proxyLogs).values({
      accountId: account.id,
      modelRequested: 'gpt-4o-mini',
      status: 'success',
      createdAt: '2026-01-01 00:00:00',
    }).run();

    const cutoff = getProxyLogRetentionCutoffUtc(Date.parse('2026-03-04T00:00:00Z'));
    expect(cutoff).toBeNull();

    const result = cleanupExpiredProxyLogs(Date.parse('2026-03-04T00:00:00Z'));
    expect(result.deleted).toBe(0);

    const rows = db.select().from(schema.proxyLogs).all();
    expect(rows).toHaveLength(1);
  });
});

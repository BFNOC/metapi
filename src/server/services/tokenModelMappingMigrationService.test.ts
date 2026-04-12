import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type MigrationModule = typeof import('./tokenModelMappingMigrationService.js');

describe('tokenModelMappingMigrationService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let migrateAccountModelMappingsToTokens: MigrationModule['migrateAccountModelMappingsToTokens'];
  let tokenModelMappingMigrationTestUtils: MigrationModule['__tokenModelMappingMigrationTestUtils'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-model-mapping-migration-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    await dbModule.ensureSiteCompatibilityColumns();
    const migrationModule = await import('./tokenModelMappingMigrationService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    migrateAccountModelMappingsToTokens = migrationModule.migrateAccountModelMappingsToTokens;
    tokenModelMappingMigrationTestUtils = migrationModule.__tokenModelMappingMigrationTestUtils;
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    tokenModelMappingMigrationTestUtils.resetRunMigrationTransactionForTests();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    tokenModelMappingMigrationTestUtils.resetRunMigrationTransactionForTests();
    delete process.env.DATA_DIR;
  });

  it('copies account modelMapping into all token rows that do not yet have token-level mappings', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'token-migration-site',
      url: 'https://token-migration.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'token-migration-user',
      accessToken: 'access-token',
      status: 'active',
      extraConfig: JSON.stringify({
        modelMapping: {
          'glm-5': 'provider-glm-5',
        },
      }),
    }).returning().get();

    const tokens = await db.insert(schema.accountTokens).values([
      {
        accountId: account.id,
        name: 'token-a',
        token: 'sk-token-a',
        enabled: true,
        isDefault: true,
      },
      {
        accountId: account.id,
        name: 'token-b',
        token: 'sk-token-b',
        enabled: true,
        isDefault: false,
        modelMapping: JSON.stringify({ 'glm-5': 'already-customized' }),
      },
    ]).returning().all();

    const summary = await migrateAccountModelMappingsToTokens();

    expect(summary).toMatchObject({
      targetAccounts: 1,
      migratedAccounts: 1,
      failedAccounts: 0,
      migratedTokens: 1,
      skippedExistingTokens: 1,
    });

    const migratedToken = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, tokens[0]!.id)).get();
    const preservedToken = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, tokens[1]!.id)).get();

    expect(migratedToken?.modelMapping).toBe(JSON.stringify({ 'glm-5': 'provider-glm-5' }));
    expect(preservedToken?.modelMapping).toBe(JSON.stringify({ 'glm-5': 'already-customized' }));
  });

  it('is idempotent and does not rewrite token mappings on repeated runs', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'token-migration-idempotent-site',
      url: 'https://token-migration-idempotent.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'token-migration-idempotent-user',
      accessToken: 'access-token',
      status: 'active',
      extraConfig: JSON.stringify({
        modelMapping: {
          'glm-5': 'provider-glm-5',
        },
      }),
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'token-a',
      token: 'sk-token-a',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const first = await migrateAccountModelMappingsToTokens();
    const second = await migrateAccountModelMappingsToTokens();

    expect(first).toMatchObject({
      migratedAccounts: 1,
      migratedTokens: 1,
      skippedExistingTokens: 0,
    });
    expect(second).toMatchObject({
      migratedAccounts: 0,
      migratedTokens: 0,
      skippedAccounts: 1,
      skippedExistingTokens: 1,
    });

    const latest = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, token.id)).get();
    expect(latest?.modelMapping).toBe(JSON.stringify({ 'glm-5': 'provider-glm-5' }));
  });

  it('skips direct-account apikey connections so account-level mapping remains authoritative there', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'direct-apikey-site',
      url: 'https://direct-apikey.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'direct-apikey-user',
      accessToken: '',
      apiToken: 'sk-direct-apikey',
      status: 'active',
      extraConfig: JSON.stringify({
        credentialMode: 'apikey',
        modelMapping: {
          'glm-5': 'provider-glm-5',
        },
      }),
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'shadow-token',
      token: 'sk-direct-apikey',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const summary = await migrateAccountModelMappingsToTokens();

    expect(summary).toMatchObject({
      targetAccounts: 0,
      migratedAccounts: 0,
      failedAccounts: 0,
      skippedAccounts: 0,
      migratedTokens: 0,
      skippedExistingTokens: 0,
    });

    const latest = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, token.id)).get();
    expect(latest?.modelMapping ?? null).toBeNull();
  });

  it('continues migrating later accounts when one account migration fails', async () => {
    const firstSite = await db.insert(schema.sites).values({
      name: 'broken-account-site',
      url: 'https://broken-account.example.com',
      platform: 'new-api',
    }).returning().get();
    const secondSite = await db.insert(schema.sites).values({
      name: 'healthy-account-site',
      url: 'https://healthy-account.example.com',
      platform: 'new-api',
    }).returning().get();

    const brokenAccount = await db.insert(schema.accounts).values({
      siteId: firstSite.id,
      username: 'broken-user',
      accessToken: 'access-token',
      status: 'active',
      extraConfig: JSON.stringify({
        modelMapping: {
          'glm-5': 'provider-glm-5',
        },
      }),
    }).returning().get();
    const healthyAccount = await db.insert(schema.accounts).values({
      siteId: secondSite.id,
      username: 'healthy-user',
      accessToken: 'access-token',
      status: 'active',
      extraConfig: JSON.stringify({
        modelMapping: {
          'gpt-4o': 'provider-gpt-4o',
        },
      }),
    }).returning().get();

    await db.insert(schema.accountTokens).values([
      {
        accountId: brokenAccount.id,
        name: 'broken-token',
        token: 'sk-broken-token',
        enabled: true,
        isDefault: true,
      },
      {
        accountId: healthyAccount.id,
        name: 'healthy-token',
        token: 'sk-healthy-token',
        enabled: true,
        isDefault: true,
      },
    ]).run();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let transactionCall = 0;
    tokenModelMappingMigrationTestUtils.setRunMigrationTransactionForTests(async (callback: any) => {
      transactionCall += 1;
      if (transactionCall === 1) {
        throw new Error('forced validation failure');
      }
      return db.transaction(callback);
    });

    try {
      const summary = await migrateAccountModelMappingsToTokens();

      expect(summary).toMatchObject({
        targetAccounts: 2,
        migratedAccounts: 1,
        failedAccounts: 1,
        migratedTokens: 1,
      });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('forced validation failure'));

      const brokenToken = await db.select().from(schema.accountTokens)
        .where(eq(schema.accountTokens.accountId, brokenAccount.id))
        .get();
      const healthyToken = await db.select().from(schema.accountTokens)
        .where(eq(schema.accountTokens.accountId, healthyAccount.id))
        .get();

      expect(brokenToken?.modelMapping ?? null).toBeNull();
      expect(healthyToken?.modelMapping).toBe(JSON.stringify({
        'gpt-4o': 'provider-gpt-4o',
      }));
    } finally {
      tokenModelMappingMigrationTestUtils.resetRunMigrationTransactionForTests();
      warnSpy.mockRestore();
    }
  });

});

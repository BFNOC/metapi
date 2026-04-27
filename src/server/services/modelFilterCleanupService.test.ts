import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type CleanupModule = typeof import('./modelFilterCleanupService.js');

describe('cleanupStaleAllowListEntries', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let cleanupStaleAllowListEntries: CleanupModule['cleanupStaleAllowListEntries'];

  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'metapi-filter-cleanup-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const cleanupModule = await import('./modelFilterCleanupService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    cleanupStaleAllowListEntries = cleanupModule.cleanupStaleAllowListEntries;
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.siteAllowedModels).run();
    await db.delete(schema.siteDisabledModels).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  // ── Helpers ─────────────────────────────────────────────────────────────

  async function insertSite(overrides: Record<string, unknown> = {}) {
    return db.insert(schema.sites).values({
      name: (overrides.name as string) || 'test-site',
      url: (overrides.url as string) || `https://test-${Date.now()}.example.com`,
      platform: (overrides.platform as string) || 'new-api',
      status: (overrides.status as string) || 'active',
      modelFilterMode: (overrides.modelFilterMode as string) || 'deny-list',
    }).returning().get();
  }

  async function insertAccount(siteId: number, overrides: Record<string, unknown> = {}) {
    return db.insert(schema.accounts).values({
      siteId,
      username: (overrides.username as string) || 'user',
      accessToken: (overrides.accessToken as string) || '',
      apiToken: (overrides.apiToken as string) || 'sk-default-test',
      status: (overrides.status as string) || 'active',
      extraConfig: 'extraConfig' in overrides
        ? (overrides.extraConfig as string | null)
        : JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
  }

  async function insertAccountToken(accountId: number, overrides: Record<string, unknown> = {}) {
    return db.insert(schema.accountTokens).values({
      accountId,
      name: (overrides.name as string) || 'default',
      token: (overrides.token as string) || `sk-${Date.now()}`,
      enabled: overrides.enabled !== undefined ? overrides.enabled as boolean : true,
      valueStatus: 'ready',
      modelFilterMode: (overrides.modelFilterMode as string) || 'none',
      filteredModels: (overrides.filteredModels as string) || null,
    }).returning().get();
  }

  async function insertModelAvailability(accountId: number, modelName: string, isManual = false) {
    await db.insert(schema.modelAvailability).values({
      accountId,
      modelName,
      available: true,
      isManual,
      checkedAt: new Date().toISOString(),
    }).run();
  }

  async function insertTokenModelAvailability(tokenId: number, modelName: string) {
    await db.insert(schema.tokenModelAvailability).values({
      tokenId,
      modelName,
      available: true,
      checkedAt: new Date().toISOString(),
    }).run();
  }

  async function insertSiteAllowedModel(siteId: number, modelName: string) {
    await db.insert(schema.siteAllowedModels).values({
      siteId,
      modelName,
      createdAt: new Date().toISOString(),
    }).run();
  }

  // ── Tests ───────────────────────────────────────────────────────────────

  it('returns zeros when no successful account IDs are provided', async () => {
    const result = await cleanupStaleAllowListEntries([]);
    expect(result).toEqual({ siteAllowedModelsRemoved: 0, tokenFilterModelsUpdated: 0 });
  });

  // ── Site-level allow-list cleanup ─────────────────────────────────────

  it('removes site allow-list entries for models no longer in availability', async () => {
    const site = await insertSite({ modelFilterMode: 'allow-list' });
    const account = await insertAccount(site.id);

    await insertSiteAllowedModel(site.id, 'gpt-4o');
    await insertSiteAllowedModel(site.id, 'gpt-3.5');
    await insertModelAvailability(account.id, 'gpt-4o');

    const result = await cleanupStaleAllowListEntries([account.id]);

    expect(result.siteAllowedModelsRemoved).toBe(1);

    const remaining = await db.select().from(schema.siteAllowedModels)
      .where(eq(schema.siteAllowedModels.siteId, site.id)).all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].modelName).toBe('gpt-4o');
  });

  it('does not remove site allow-list entries when all still available', async () => {
    const site = await insertSite({ modelFilterMode: 'allow-list' });
    const account = await insertAccount(site.id);

    await insertSiteAllowedModel(site.id, 'gpt-4o');
    await insertSiteAllowedModel(site.id, 'claude-3');
    await insertModelAvailability(account.id, 'gpt-4o');
    await insertModelAvailability(account.id, 'claude-3');

    const result = await cleanupStaleAllowListEntries([account.id]);
    expect(result.siteAllowedModelsRemoved).toBe(0);
  });

  it('preserves allow-list entries when model is in token-level availability', async () => {
    const site = await insertSite({ modelFilterMode: 'allow-list' });
    const account = await insertAccount(site.id);
    const token = await insertAccountToken(account.id);

    await insertSiteAllowedModel(site.id, 'gpt-4o');
    await insertTokenModelAvailability(token.id, 'gpt-4o');

    const result = await cleanupStaleAllowListEntries([account.id]);
    expect(result.siteAllowedModelsRemoved).toBe(0);
  });

  it('skips site cleanup when no account under the site had a successful refresh', async () => {
    const site = await insertSite({ modelFilterMode: 'allow-list' });
    const account = await insertAccount(site.id);

    await insertSiteAllowedModel(site.id, 'stale-model');

    const result = await cleanupStaleAllowListEntries([account.id + 1000]);
    expect(result.siteAllowedModelsRemoved).toBe(0);

    const remaining = await db.select().from(schema.siteAllowedModels).all();
    expect(remaining).toHaveLength(1);
  });

  it('does not touch deny-list sites', async () => {
    const site = await insertSite({ modelFilterMode: 'deny-list' });
    const account = await insertAccount(site.id);

    await insertSiteAllowedModel(site.id, 'some-model');

    const result = await cleanupStaleAllowListEntries([account.id]);
    expect(result.siteAllowedModelsRemoved).toBe(0);
  });

  it('preserves allow-list entry when model is manually marked available', async () => {
    const site = await insertSite({ modelFilterMode: 'allow-list' });
    const account = await insertAccount(site.id);

    await insertSiteAllowedModel(site.id, 'manual-model');
    await insertModelAvailability(account.id, 'manual-model', true);

    const result = await cleanupStaleAllowListEntries([account.id]);
    expect(result.siteAllowedModelsRemoved).toBe(0);
  });

  // ── Token-level allow-list cleanup ────────────────────────────────────

  it('removes stale models from token allow-list filteredModels', async () => {
    const site = await insertSite();
    const account = await insertAccount(site.id);
    const token = await insertAccountToken(account.id, {
      modelFilterMode: 'allow-list',
      filteredModels: JSON.stringify(['gpt-4o', 'gpt-3.5', 'claude-3']),
    });

    await insertModelAvailability(account.id, 'gpt-4o');

    const result = await cleanupStaleAllowListEntries([account.id]);
    expect(result.tokenFilterModelsUpdated).toBe(1);

    const updated = await db.select().from(schema.accountTokens)
      .where(eq(schema.accountTokens.id, token.id)).get();
    expect(JSON.parse(updated!.filteredModels!)).toEqual(['gpt-4o']);
  });

  it('does not update token when all filteredModels still exist', async () => {
    const site = await insertSite();
    const account = await insertAccount(site.id);
    await insertAccountToken(account.id, {
      modelFilterMode: 'allow-list',
      filteredModels: JSON.stringify(['gpt-4o']),
    });

    await insertModelAvailability(account.id, 'gpt-4o');

    const result = await cleanupStaleAllowListEntries([account.id]);
    expect(result.tokenFilterModelsUpdated).toBe(0);
  });

  it('skips tokens with deny-list mode', async () => {
    const site = await insertSite();
    const account = await insertAccount(site.id);
    await insertAccountToken(account.id, {
      modelFilterMode: 'deny-list',
      filteredModels: JSON.stringify(['stale-model']),
    });

    const result = await cleanupStaleAllowListEntries([account.id]);
    expect(result.tokenFilterModelsUpdated).toBe(0);
  });

  it('skips tokens whose account did not have a successful refresh', async () => {
    const site = await insertSite();
    const account = await insertAccount(site.id);
    await insertAccountToken(account.id, {
      modelFilterMode: 'allow-list',
      filteredModels: JSON.stringify(['stale-model']),
    });

    const result = await cleanupStaleAllowListEntries([account.id + 1000]);
    expect(result.tokenFilterModelsUpdated).toBe(0);
  });

  it('considers tokenModelAvailability for managed-token allow-list cleanup', async () => {
    const site = await insertSite();
    // Managed-token account uses tokenModelAvailability for cleanup
    const account = await insertAccount(site.id, {
      accessToken: 'session-token',
      apiToken: '',
      extraConfig: null,
    });
    const token = await insertAccountToken(account.id, {
      modelFilterMode: 'allow-list',
      filteredModels: JSON.stringify(['gpt-4o', 'stale-model']),
    });

    await insertTokenModelAvailability(token.id, 'gpt-4o');

    const result = await cleanupStaleAllowListEntries([account.id]);
    expect(result.tokenFilterModelsUpdated).toBe(1);

    const updated = await db.select().from(schema.accountTokens)
      .where(eq(schema.accountTokens.id, token.id)).get();
    expect(JSON.parse(updated!.filteredModels!)).toEqual(['gpt-4o']);
  });

  it('case-insensitive matching for allow-list cleanup', async () => {
    const site = await insertSite({ modelFilterMode: 'allow-list' });
    const account = await insertAccount(site.id);

    await insertSiteAllowedModel(site.id, 'GPT-4o');
    await insertModelAvailability(account.id, 'gpt-4o');

    const result = await cleanupStaleAllowListEntries([account.id]);
    expect(result.siteAllowedModelsRemoved).toBe(0);
  });

  it('managed-token: does NOT use sibling token availability to preserve allow-list entry', async () => {
    // Session-based account → requiresManagedAccountTokens returns true
    const site = await insertSite();
    const account = await insertAccount(site.id, {
      accessToken: 'session-token',
      apiToken: '',
      extraConfig: null,  // auto mode + has accessToken → managed
    });

    const tokenA = await insertAccountToken(account.id, {
      name: 'token-a',
      token: 'sk-a',
      modelFilterMode: 'allow-list',
      filteredModels: JSON.stringify(['gpt-4o', 'claude-3']),
    });
    const tokenB = await insertAccountToken(account.id, {
      name: 'token-b',
      token: 'sk-b',
    });

    // gpt-4o is discovered by sibling token B, not by token A
    await insertTokenModelAvailability(tokenB.id, 'gpt-4o');
    // Account-level has gpt-4o (from the union) — this should NOT prevent cleanup
    await insertModelAvailability(account.id, 'gpt-4o');
    // claude-3 is discovered by token A itself
    await insertTokenModelAvailability(tokenA.id, 'claude-3');

    const result = await cleanupStaleAllowListEntries([account.id]);
    expect(result.tokenFilterModelsUpdated).toBe(1);

    const updated = await db.select().from(schema.accountTokens)
      .where(eq(schema.accountTokens.id, tokenA.id)).get();
    // Only claude-3 survives — gpt-4o was removed because it's not in tokenA's availability
    expect(JSON.parse(updated!.filteredModels!)).toEqual(['claude-3']);
  });

  it('apikey-mode: uses account-level availability for allow-list cleanup', async () => {
    const site = await insertSite();
    // apikey mode → requiresManagedAccountTokens returns false
    const account = await insertAccount(site.id, {
      accessToken: '',
      apiToken: 'sk-direct',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    });

    const token = await insertAccountToken(account.id, {
      modelFilterMode: 'allow-list',
      filteredModels: JSON.stringify(['gpt-4o', 'stale-model']),
    });

    // Account-level availability has gpt-4o, no token-level discovery
    await insertModelAvailability(account.id, 'gpt-4o');

    const result = await cleanupStaleAllowListEntries([account.id]);
    expect(result.tokenFilterModelsUpdated).toBe(1);

    const updated = await db.select().from(schema.accountTokens)
      .where(eq(schema.accountTokens.id, token.id)).get();
    expect(JSON.parse(updated!.filteredModels!)).toEqual(['gpt-4o']);
  });
});

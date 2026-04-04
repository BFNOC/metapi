import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type ModelServiceModule = typeof import('./modelService.js');

describe('rebuildTokenRoutesFromAvailability', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let ensureSiteCompatibilityColumns: DbModule['ensureSiteCompatibilityColumns'];
  let rebuildTokenRoutesFromAvailability: ModelServiceModule['rebuildTokenRoutesFromAvailability'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-model-service-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    await dbModule.ensureSiteCompatibilityColumns();
    const modelService = await import('./modelService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    ensureSiteCompatibilityColumns = dbModule.ensureSiteCompatibilityColumns;
    rebuildTokenRoutesFromAvailability = modelService.rebuildTokenRoutesFromAvailability;
    await ensureSiteCompatibilityColumns();
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('creates an exact route with an account-direct channel for apikey model availability', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'apikey-site',
      url: 'https://apikey-site.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'apikey-user',
      accessToken: '',
      apiToken: 'sk-apikey-route',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-5.2-codex',
      available: true,
      latencyMs: 1200,
      checkedAt: '2026-03-08T08:00:00.000Z',
    }).run();

    const rebuild = await rebuildTokenRoutesFromAvailability();

    expect(rebuild.models).toBe(1);

    const route = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'gpt-5.2-codex'))
      .get();
    expect(route).toBeDefined();

    const channels = await db.select().from(schema.routeChannels)
      .where(and(
        eq(schema.routeChannels.routeId, route!.id),
        eq(schema.routeChannels.accountId, account.id),
      ))
      .all();

    expect(channels).toHaveLength(1);
    expect(channels[0]?.tokenId ?? null).toBeNull();
    expect(channels[0]?.manualOverride).toBe(false);
  });

  it('ignores hidden account_tokens for direct apikey connections when rebuilding routes', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'apikey-legacy-site',
      url: 'https://apikey-legacy.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'apikey-legacy-user',
      accessToken: '',
      apiToken: 'sk-direct-credential',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    const hiddenToken = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'legacy-hidden',
      token: 'sk-hidden-legacy-token',
      source: 'legacy',
      enabled: true,
      isDefault: true,
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-4.1',
      available: true,
      latencyMs: 200,
      checkedAt: '2026-03-20T08:00:00.000Z',
    }).run();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: hiddenToken.id,
      modelName: 'gpt-4.1',
      available: true,
      latencyMs: 180,
      checkedAt: '2026-03-20T08:00:00.000Z',
    }).run();

    const rebuild = await rebuildTokenRoutesFromAvailability();

    expect(rebuild.models).toBe(1);

    const route = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'gpt-4.1'))
      .get();
    expect(route).toBeDefined();

    const channels = await db.select().from(schema.routeChannels)
      .where(and(
        eq(schema.routeChannels.routeId, route!.id),
        eq(schema.routeChannels.accountId, account.id),
      ))
      .all();

    expect(channels).toHaveLength(1);
    expect(channels[0]?.tokenId ?? null).toBeNull();
  });

  it('creates an exact route with an account-direct channel for oauth model availability', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'codex-site',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'codex-user@example.com',
      accessToken: 'oauth-access-token',
      apiToken: null,
      status: 'active',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: {
          provider: 'codex',
          accountId: 'chatgpt-account-123',
          email: 'codex-user@example.com',
          planType: 'team',
        },
      }),
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-5.2-codex',
      available: true,
      latencyMs: 320,
      checkedAt: '2026-03-17T00:00:00.000Z',
    }).run();

    const rebuild = await rebuildTokenRoutesFromAvailability();

    expect(rebuild.models).toBe(1);

    const route = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'gpt-5.2-codex'))
      .get();
    expect(route).toBeDefined();

    const channels = await db.select().from(schema.routeChannels)
      .where(and(
        eq(schema.routeChannels.routeId, route!.id),
        eq(schema.routeChannels.accountId, account.id),
      ))
      .all();

    expect(channels).toHaveLength(1);
    expect(channels[0]?.tokenId ?? null).toBeNull();
    expect(channels[0]?.manualOverride).toBe(false);
  });

  it('builds token routes from token-level reverse mappings instead of account mappings', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'token-mapping-site',
      url: 'https://token-mapping-site.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'token-mapping-user',
      accessToken: 'session-token',
      status: 'active',
      extraConfig: JSON.stringify({
        modelMapping: {
          'account-glm-5': 'vendor-glm-5',
        },
      }),
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'sk-token-mapping',
      enabled: true,
      isDefault: true,
      modelMapping: JSON.stringify({
        'token-glm-5': 'vendor-glm-5',
      }),
    }).returning().get();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName: 'vendor-glm-5',
      available: true,
    }).run();

    await rebuildTokenRoutesFromAvailability();

    const tokenRoute = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'token-glm-5'))
      .get();
    const accountRoute = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'account-glm-5'))
      .get();

    expect(tokenRoute).toBeDefined();
    expect(accountRoute).toBeUndefined();

    const channel = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, tokenRoute!.id))
      .get();
    expect(channel).toMatchObject({
      accountId: account.id,
      tokenId: token.id,
      sourceModel: 'vendor-glm-5',
    });
  });

  it('skips conflicting token-level reverse mappings that resolve two upstream models to the same route name', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const site = await db.insert(schema.sites).values({
        name: 'token-conflict-site',
        url: 'https://token-conflict-site.example.com',
        platform: 'new-api',
      }).returning().get();

      const account = await db.insert(schema.accounts).values({
        siteId: site.id,
        username: 'token-conflict-user',
        accessToken: 'session-token',
        status: 'active',
      }).returning().get();

      const token = await db.insert(schema.accountTokens).values({
        accountId: account.id,
        name: 'default',
        token: 'sk-token-conflict',
        enabled: true,
        isDefault: true,
        modelMapping: JSON.stringify({
          'glm-5-public': 'vendor-glm-5',
        }),
      }).returning().get();

      await db.insert(schema.tokenModelAvailability).values([
        {
          tokenId: token.id,
          modelName: 'vendor-glm-5',
          available: true,
        },
        {
          tokenId: token.id,
          modelName: 'glm-5-public',
          available: true,
        },
      ]).run();

      await rebuildTokenRoutesFromAvailability();

      const route = await db.select().from(schema.tokenRoutes)
        .where(eq(schema.tokenRoutes.modelPattern, 'glm-5-public'))
        .get();
      expect(route).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skip conflicting token model mapping'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('removes stale exact routes and keeps wildcard routes on rebuild', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-1',
      url: 'https://site-1.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'user-1',
      accessToken: 'access-1',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'sk-test',
      source: 'manual',
      enabled: true,
      isDefault: true,
    }).returning().get();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName: 'latest-model',
      available: true,
    }).run();

    const staleRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'old-model',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values({
      routeId: staleRoute.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).run();

    const wildcardRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-*',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values({
      routeId: wildcardRoute.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).run();

    const rebuild = await rebuildTokenRoutesFromAvailability();

    expect(rebuild.models).toBe(1);
    expect(rebuild.removedRoutes).toBe(1);

    const oldRoute = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, staleRoute.id)).get();
    expect(oldRoute).toBeUndefined();

    const oldChannels = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.routeId, staleRoute.id)).all();
    expect(oldChannels).toHaveLength(0);

    const latestRoute = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.modelPattern, 'latest-model')).get();
    expect(latestRoute).toBeDefined();
    const latestChannels = await db.select().from(schema.routeChannels)
      .where(and(eq(schema.routeChannels.routeId, latestRoute!.id), eq(schema.routeChannels.tokenId, token.id)))
      .all();
    expect(latestChannels.length).toBeGreaterThan(0);

    const wildcardRouteAfter = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, wildcardRoute.id)).get();
    expect(wildcardRouteAfter).toBeDefined();
  });

  it('uses token-level reverse mapping to expose token routes by mapped request name', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'token-mapping-site',
      url: 'https://token-mapping.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'token-mapping-user',
      accessToken: 'access-token',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'sk-token-mapping',
      enabled: true,
      isDefault: true,
      modelMapping: JSON.stringify({
        'glm-5': 'provider-glm-5',
      }),
    }).returning().get();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName: 'provider-glm-5',
      available: true,
    }).run();

    const rebuild = await rebuildTokenRoutesFromAvailability();
    expect(rebuild.models).toBe(1);

    const route = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'glm-5'))
      .get();
    expect(route).toBeDefined();

    const channels = await db.select().from(schema.routeChannels)
      .where(and(
        eq(schema.routeChannels.routeId, route!.id),
        eq(schema.routeChannels.tokenId, token.id),
      ))
      .all();
    expect(channels).toHaveLength(1);
    expect(channels[0]?.sourceModel).toBe('provider-glm-5');

    const upstreamNamedRoute = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'provider-glm-5'))
      .get();
    expect(upstreamNamedRoute).toBeUndefined();
  });

  it('skips conflicting token-level route names instead of silently overwriting', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const site = await db.insert(schema.sites).values({
        name: 'token-conflict-site',
        url: 'https://token-conflict.example.com',
        platform: 'new-api',
      }).returning().get();

      const account = await db.insert(schema.accounts).values({
        siteId: site.id,
        username: 'token-conflict-user',
        accessToken: 'access-token',
        status: 'active',
      }).returning().get();

      const token = await db.insert(schema.accountTokens).values({
        accountId: account.id,
        name: 'default',
        token: 'sk-token-conflict',
        enabled: true,
        isDefault: true,
        modelMapping: JSON.stringify({
          'glm-5': 'provider-glm-5',
        }),
      }).returning().get();

      await db.insert(schema.tokenModelAvailability).values([
        {
          tokenId: token.id,
          modelName: 'provider-glm-5',
          available: true,
        },
        {
          tokenId: token.id,
          modelName: 'glm-5',
          available: true,
        },
      ]).run();

      const rebuild = await rebuildTokenRoutesFromAvailability();
      expect(rebuild.models).toBe(0);

      const route = await db.select().from(schema.tokenRoutes)
        .where(eq(schema.tokenRoutes.modelPattern, 'glm-5'))
        .get();
      expect(route).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skip conflicting token model mapping'));
    } finally {
      warnSpy.mockRestore();
    }
  });
});

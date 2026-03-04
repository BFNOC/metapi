import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');
type ConfigModule = typeof import('../config.js');

describe('TokenRouter runtime cache', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let config: ConfigModule['config'];
  let dataDir = '';
  let originalCacheTtlMs = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-router-cache-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    const configModule = await import('../config.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    config = configModule.config;
    originalCacheTtlMs = config.tokenRouterCacheTtlMs;
  });

  beforeEach(() => {
    db.delete(schema.routeChannels).run();
    db.delete(schema.tokenRoutes).run();
    db.delete(schema.accountTokens).run();
    db.delete(schema.accounts).run();
    db.delete(schema.sites).run();
    config.tokenRouterCacheTtlMs = 60_000;
    invalidateTokenRouterCache();
  });

  afterAll(() => {
    config.tokenRouterCacheTtlMs = originalCacheTtlMs;
    invalidateTokenRouterCache();
    delete process.env.DATA_DIR;
  });

  it('keeps route snapshot inside TTL until explicit invalidation', () => {
    const site = db.insert(schema.sites).values({
      name: 'cache-site',
      url: 'https://cache-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'cache-user',
      accessToken: 'cache-access-token',
      apiToken: 'cache-api-token',
      status: 'active',
    }).returning().get();

    const token = db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'cache-token',
      token: 'sk-cache-token',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const route = db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini',
      enabled: true,
    }).returning().get();

    db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).run();

    const router = new TokenRouter();
    expect(router.selectChannel('gpt-4o-mini')).toBeTruthy();

    db.delete(schema.routeChannels).where(eq(schema.routeChannels.routeId, route.id)).run();
    db.delete(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, route.id)).run();

    const cachedSelection = router.selectChannel('gpt-4o-mini');
    expect(cachedSelection).toBeTruthy();

    invalidateTokenRouterCache();
    const refreshedSelection = router.selectChannel('gpt-4o-mini');
    expect(refreshedSelection).toBeNull();
  });
});

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { config } from '../../config.js';

const probeModelsMock = vi.fn();

vi.mock('../../services/modelProbeService.js', () => ({
  probeModels: (...args: unknown[]) => probeModelsMock(...args),
}));

type DbModule = typeof import('../../db/index.js');
type TokenRouterModule = typeof import('../../services/tokenRouter.js');

describe('siteHealthRoutes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let tokenRouter: TokenRouterModule['tokenRouter'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let resetSiteRuntimeHealthState: TokenRouterModule['resetSiteRuntimeHealthState'];
  let originalManualVerifyEnabled = true;
  let dataDir = '';
  let seedId = 0;

  const nextId = () => {
    seedId += 1;
    return seedId;
  };

  const seedChannel = async (options?: { cooldown?: boolean; probeDisabled?: boolean }) => {
    const id = nextId();
    const site = await db.insert(schema.sites).values({
      name: `site-health-site-${id}`,
      url: `https://site-health-${id}.example.com`,
      platform: 'new-api',
      status: 'active',
      probeDisabled: !!options?.probeDisabled,
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `site-health-user-${id}`,
      accessToken: `site-health-access-${id}`,
      apiToken: `sk-site-health-${id}`,
      status: 'active',
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini',
      enabled: true,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      sourceModel: 'gpt-4o-mini',
      priority: 0,
      weight: 10,
      enabled: true,
      cooldownUntil: options?.cooldown ? '2099-01-01T00:00:00.000Z' : null,
      cooldownLevel: options?.cooldown ? 2 : 0,
      consecutiveFailCount: options?.cooldown ? 2 : 0,
      lastFailAt: options?.cooldown ? '2026-04-05T00:00:00.000Z' : null,
    }).returning().get();

    return { site, account, route, channel };
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-site-health-route-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const tokenRouterModule = await import('../../services/tokenRouter.js');
    const routesModule = await import('./siteHealth.js');

    db = dbModule.db;
    schema = dbModule.schema;
    tokenRouter = tokenRouterModule.tokenRouter;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    resetSiteRuntimeHealthState = tokenRouterModule.resetSiteRuntimeHealthState;
    originalManualVerifyEnabled = config.siteHealthEnableManualVerifyEntry;

    app = Fastify();
    await app.register(routesModule.siteHealthRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    seedId = 0;
    probeModelsMock.mockReset();
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
    config.siteHealthEnableManualVerifyEntry = originalManualVerifyEnabled;
  });

  afterAll(async () => {
    await app.close();
    config.siteHealthEnableManualVerifyEntry = originalManualVerifyEnabled;
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
    delete process.env.DATA_DIR;
  });

  it('lists derived site health states', async () => {
    const seeded = await seedChannel({ probeDisabled: true, cooldown: true });
    await tokenRouter.recordFailure(seeded.channel.id, {
      status: 503,
      errorText: 'bad gateway',
      modelName: 'gpt-4o-mini',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/site-health/states',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      enabled: boolean;
      items: Array<{
        siteId: number;
        state: string;
        probePolicy: string;
        cooldownSummary: {
          activeChannelCooldownCount: number;
          affectedRouteCount: number;
          earliestCooldownUntil: string | null;
          latestCooldownUntil: string | null;
        };
      }>;
    };
    expect(body.enabled).toBe(true);
    const row = body.items.find((item) => item.siteId === seeded.site.id);
    expect(row).toMatchObject({
      state: 'penalized',
      probePolicy: 'manual_only',
      cooldownSummary: {
        activeChannelCooldownCount: 1,
        affectedRouteCount: 1,
      },
    });
    expect(row?.cooldownSummary.earliestCooldownUntil).toBeTruthy();
  });

  it('runs conservative manual verify without mutating runtime health', async () => {
    const seeded = await seedChannel({ cooldown: true, probeDisabled: true });
    await tokenRouter.recordFailure(seeded.channel.id, {
      status: 503,
      errorText: 'gateway timeout',
      modelName: 'gpt-4o-mini',
    });
    const beforeChannel = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, seeded.channel.id))
      .get();
    const before = await tokenRouter.explainSelection('gpt-4o-mini');
    const beforePenalty = before.candidates.find((item) => item.channelId === seeded.channel.id)?.runtimeHealth?.penaltyScore || 0;

    probeModelsMock.mockResolvedValue([{
      modelName: 'gpt-4o-mini',
      status: 'supported',
      ttftMs: 180,
      httpStatus: 200,
      error: null,
      responseText: 'ok',
    }]);

    const response = await app.inject({
      method: 'POST',
      url: `/api/site-health/manual-verify/${seeded.site.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      siteId: seeded.site.id,
      probePolicy: 'manual_only',
      candidateModel: 'gpt-4o-mini',
      candidateSource: 'route',
      recoveryHint: true,
    });

    const after = await tokenRouter.explainSelection('gpt-4o-mini');
    const afterPenalty = after.candidates.find((item) => item.channelId === seeded.channel.id)?.runtimeHealth?.penaltyScore || 0;
    expect(Math.abs(afterPenalty - beforePenalty)).toBeLessThan(0.01);

    const refreshed = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, seeded.channel.id))
      .get();
    expect(refreshed).toMatchObject({
      cooldownUntil: beforeChannel?.cooldownUntil,
      cooldownLevel: beforeChannel?.cooldownLevel,
      consecutiveFailCount: beforeChannel?.consecutiveFailCount,
    });
  });
});

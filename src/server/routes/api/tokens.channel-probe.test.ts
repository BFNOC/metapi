import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, inArray } from 'drizzle-orm';

const probeModelsMock = vi.fn();

vi.mock('../../services/modelProbeService.js', () => ({
  probeModels: (...args: unknown[]) => probeModelsMock(...args),
}));

type DbModule = typeof import('../../db/index.js');

function buildProbeResult(
  modelName: string,
  overrides: Partial<{
    status: 'supported' | 'unsupported' | 'inconclusive' | 'skipped';
    ttftMs: number | null;
    httpStatus: number | null;
    error: string | null;
    responseText: string | null;
  }> = {},
) {
  return {
    modelName,
    status: 'supported' as const,
    ttftMs: 120,
    httpStatus: 200,
    error: null,
    responseText: 'ok',
    ...overrides,
  };
}

describe('channel probe routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let seedId = 0;

  const nextSeed = () => {
    seedId += 1;
    return seedId;
  };

  const seedSiteAccountToken = async () => {
    const id = nextSeed();
    const site = await db.insert(schema.sites).values({
      name: `site-${id}`,
      url: `https://site-${id}.example.com`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `user-${id}`,
      accessToken: `account-access-${id}`,
      apiToken: `account-api-${id}`,
      status: 'active',
    }).returning().get();
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: `token-${id}`,
      token: `sk-token-${id}`,
      enabled: true,
      isDefault: true,
    }).returning().get();
    return { site, account, token };
  };

  const seedRoute = async (options?: Partial<typeof schema.tokenRoutes.$inferInsert>) => {
    const id = nextSeed();
    return await db.insert(schema.tokenRoutes).values({
      modelPattern: `gpt-4o-mini-${id}`,
      enabled: true,
      routeMode: 'pattern',
      ...options,
    }).returning().get();
  };

  const seedChannel = async (input: {
    routeId: number;
    accountId: number;
    tokenId?: number | null;
    sourceModel?: string | null;
    priority?: number;
    enabled?: boolean;
    manualOverride?: boolean;
    cooldownUntil?: string | null;
    consecutiveFailCount?: number;
    lastFailAt?: string | null;
  }) => {
    return await db.insert(schema.routeChannels).values({
      routeId: input.routeId,
      accountId: input.accountId,
      tokenId: input.tokenId ?? null,
      sourceModel: input.sourceModel ?? null,
      priority: input.priority ?? 0,
      weight: 10,
      enabled: input.enabled ?? true,
      manualOverride: input.manualOverride ?? false,
      cooldownUntil: input.cooldownUntil ?? null,
      consecutiveFailCount: input.consecutiveFailCount ?? 0,
      lastFailAt: input.lastFailAt ?? null,
    }).returning().get();
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-tokens-channel-probe-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    await dbModule.ensureSiteCompatibilityColumns();
    const routesModule = await import('./tokens.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.tokensRoutes);
  });

  beforeEach(async () => {
    probeModelsMock.mockReset();
    seedId = 0;

    await db.delete(schema.routeChannels).run();
    await db.delete(schema.routeGroupSources).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('clears channel cooldown after a successful single-channel probe', async () => {
    const { account, token } = await seedSiteAccountToken();
    const route = await seedRoute({ modelPattern: 'gpt-4o-mini' });
    const channel = await seedChannel({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      sourceModel: 'gpt-4o-mini',
      cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
      consecutiveFailCount: 3,
      lastFailAt: new Date().toISOString(),
    });
    probeModelsMock.mockResolvedValue([
      buildProbeResult('gpt-4o-mini', { status: 'supported', ttftMs: 88 }),
    ]);

    const response = await app.inject({
      method: 'POST',
      url: `/api/channels/${channel.id}/probe`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      result: expect.objectContaining({
        status: 'supported',
        ttftMs: 88,
      }),
    });

    const updatedChannel = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();
    expect(updatedChannel?.cooldownUntil).toBeNull();
    expect(updatedChannel?.consecutiveFailCount).toBe(0);
    expect(updatedChannel?.lastFailAt).toBeNull();
  });

  it('streams start/result frames and [DONE] for route-level probes', async () => {
    const fixtureA = await seedSiteAccountToken();
    const fixtureB = await seedSiteAccountToken();
    const route = await seedRoute({ modelPattern: 'gpt-4o-mini' });
    const channelA = await seedChannel({
      routeId: route.id,
      accountId: fixtureA.account.id,
      tokenId: fixtureA.token.id,
      sourceModel: 'gpt-4o-mini',
      priority: 0,
    });
    const channelB = await seedChannel({
      routeId: route.id,
      accountId: fixtureB.account.id,
      tokenId: fixtureB.token.id,
      sourceModel: 'gpt-4o',
      priority: 1,
    });

    probeModelsMock.mockImplementation(async (input: { modelNames: string[] }) => {
      const modelName = input.modelNames[0] || '';
      if (modelName === 'gpt-4o') {
        return [buildProbeResult(modelName, {
          status: 'skipped',
          httpStatus: 403,
          error: 'Forbidden',
          responseText: null,
        })];
      }
      return [buildProbeResult(modelName, { status: 'supported', ttftMs: 101 })];
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/routes/${route.id}/channels/probe`,
      headers: {
        accept: 'text/event-stream',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    const lines = response.payload
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data: '));
    expect(lines[0]).toBe('data: {"type":"start","totalCount":2}');
    expect(lines.at(-1)).toBe('data: [DONE]');
    const resultPayloads = lines.slice(1, -1).map((line) => JSON.parse(line.slice(6)));
    expect(resultPayloads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'result',
        channelId: channelA.id,
        status: 'supported',
        ttftMs: 101,
        httpStatus: 200,
      }),
      expect.objectContaining({
        type: 'result',
        channelId: channelB.id,
        status: 'skipped',
        httpStatus: 403,
        error: 'Forbidden',
      }),
    ]));
  });

  it('rejects explicit-group routes and zero-channel routes for batch probe and apply ranking', async () => {
    const fixture = await seedSiteAccountToken();
    const sourceRoute = await seedRoute({ modelPattern: 'gpt-4o-mini' });
    await seedChannel({
      routeId: sourceRoute.id,
      accountId: fixture.account.id,
      tokenId: fixture.token.id,
      sourceModel: 'gpt-4o-mini',
    });
    const groupRoute = await seedRoute({
      modelPattern: 'group/gpt-4o-mini',
      routeMode: 'explicit_group',
    });
    await db.insert(schema.routeGroupSources).values({
      groupRouteId: groupRoute.id,
      sourceRouteId: sourceRoute.id,
    }).run();
    const zeroChannelRoute = await seedRoute({ modelPattern: 'gpt-4o-empty' });

    const explicitProbe = await app.inject({
      method: 'POST',
      url: `/api/routes/${groupRoute.id}/channels/probe`,
      headers: { accept: 'text/event-stream' },
    });
    expect(explicitProbe.statusCode).toBe(400);

    const explicitApply = await app.inject({
      method: 'POST',
      url: `/api/routes/${groupRoute.id}/channels/apply-probe-ranking`,
      payload: {
        ranking: [],
      },
    });
    expect(explicitApply.statusCode).toBe(400);

    const zeroProbe = await app.inject({
      method: 'POST',
      url: `/api/routes/${zeroChannelRoute.id}/channels/probe`,
      headers: { accept: 'text/event-stream' },
    });
    expect(zeroProbe.statusCode).toBe(400);

    const zeroApply = await app.inject({
      method: 'POST',
      url: `/api/routes/${zeroChannelRoute.id}/channels/apply-probe-ranking`,
      payload: {
        ranking: [{
          channelId: 999999,
          ttftMs: 123,
          status: 'supported',
          httpStatus: 200,
        }],
      },
    });
    expect(zeroApply.statusCode).toBe(400);
  });

  it('rejects foreign channel ids and incomplete channel sets when applying probe ranking', async () => {
    const fixtureA = await seedSiteAccountToken();
    const fixtureB = await seedSiteAccountToken();
    const routeA = await seedRoute({ modelPattern: 'gpt-4o-mini-a' });
    const routeB = await seedRoute({ modelPattern: 'gpt-4o-mini-b' });
    const routeAChannel1 = await seedChannel({
      routeId: routeA.id,
      accountId: fixtureA.account.id,
      tokenId: fixtureA.token.id,
      sourceModel: 'gpt-4o-mini-a',
      priority: 1,
    });
    const routeAChannel2 = await seedChannel({
      routeId: routeA.id,
      accountId: fixtureB.account.id,
      tokenId: fixtureB.token.id,
      sourceModel: 'gpt-4o-mini-a',
      priority: 2,
    });
    const routeBChannel = await seedChannel({
      routeId: routeB.id,
      accountId: fixtureA.account.id,
      tokenId: fixtureA.token.id,
      sourceModel: 'gpt-4o-mini-b',
      priority: 0,
    });

    const ownershipResponse = await app.inject({
      method: 'POST',
      url: `/api/routes/${routeA.id}/channels/apply-probe-ranking`,
      payload: {
        ranking: [{
          channelId: routeBChannel.id,
          ttftMs: 80,
          status: 'supported',
          httpStatus: 200,
        }],
      },
    });
    expect(ownershipResponse.statusCode).toBe(400);
    expect(ownershipResponse.json()).toMatchObject({
      message: `通道 ${routeBChannel.id} 不属于该路由`,
    });

    const incompleteResponse = await app.inject({
      method: 'POST',
      url: `/api/routes/${routeA.id}/channels/apply-probe-ranking`,
      payload: {
        ranking: [{
          channelId: routeAChannel1.id,
          ttftMs: 90,
          status: 'supported',
          httpStatus: 200,
        }],
      },
    });
    expect(incompleteResponse.statusCode).toBe(400);
    expect(incompleteResponse.json()).toMatchObject({
      message: '通道列表已变更，请重新探活',
    });

    const untouchedChannels = await db.select().from(schema.routeChannels)
      .where(inArray(schema.routeChannels.id, [routeAChannel1.id, routeAChannel2.id]))
      .all();
    expect(untouchedChannels.map((channel) => channel.manualOverride)).toEqual([false, false]);
  });

  it('writes priorities with manualOverride and clears dependent decision snapshots', async () => {
    const fixtureA = await seedSiteAccountToken();
    const fixtureB = await seedSiteAccountToken();
    const route = await seedRoute({
      modelPattern: 'gpt-4o-mini',
      decisionSnapshot: JSON.stringify({ route: 'snapshot' }),
      decisionRefreshedAt: new Date().toISOString(),
    });
    const dependentGroupRoute = await seedRoute({
      modelPattern: 'group/gpt-4o-mini',
      routeMode: 'explicit_group',
      decisionSnapshot: JSON.stringify({ group: 'snapshot' }),
      decisionRefreshedAt: new Date().toISOString(),
    });
    await db.insert(schema.routeGroupSources).values({
      groupRouteId: dependentGroupRoute.id,
      sourceRouteId: route.id,
    }).run();

    const slowSupported = await seedChannel({
      routeId: route.id,
      accountId: fixtureA.account.id,
      tokenId: fixtureA.token.id,
      sourceModel: 'gpt-4o-mini',
      priority: 5,
      manualOverride: false,
    });
    const unsupported = await seedChannel({
      routeId: route.id,
      accountId: fixtureB.account.id,
      tokenId: fixtureB.token.id,
      sourceModel: 'gpt-4o-mini',
      priority: 0,
      manualOverride: false,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/routes/${route.id}/channels/apply-probe-ranking`,
      payload: {
        ranking: [
          {
            channelId: slowSupported.id,
            ttftMs: 2400,
            status: 'supported',
            httpStatus: 200,
          },
          {
            channelId: unsupported.id,
            ttftMs: null,
            status: 'unsupported',
            httpStatus: 404,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      updatedCount: 2,
    });

    const updatedChannels = await db.select().from(schema.routeChannels)
      .where(inArray(schema.routeChannels.id, [slowSupported.id, unsupported.id]))
      .all();
    const updatedById = new Map(updatedChannels.map((channel) => [channel.id, channel]));
    expect(updatedById.get(slowSupported.id)?.priority).toBe(5);
    expect(updatedById.get(slowSupported.id)?.weight).toBe(100);
    expect(updatedById.get(unsupported.id)?.priority).toBe(6);
    expect(updatedById.get(unsupported.id)?.weight).toBe(10);
    expect(updatedById.get(slowSupported.id)?.manualOverride).toBe(true);
    expect(updatedById.get(unsupported.id)?.manualOverride).toBe(true);

    const refreshedRoutes = await db.select().from(schema.tokenRoutes)
      .where(inArray(schema.tokenRoutes.id, [route.id, dependentGroupRoute.id]))
      .all();
    const routeById = new Map(refreshedRoutes.map((item) => [item.id, item]));
    expect(routeById.get(route.id)?.decisionSnapshot).toBeNull();
    expect(routeById.get(route.id)?.decisionRefreshedAt).toBeNull();
    expect(routeById.get(dependentGroupRoute.id)?.decisionSnapshot).toBeNull();
    expect(routeById.get(dependentGroupRoute.id)?.decisionRefreshedAt).toBeNull();
  });

  it('keeps healthy channel priority unchanged and sets weight by TTFT tier', async () => {
    const fastFixture = await seedSiteAccountToken();
    const normalFixture = await seedSiteAccountToken();
    const slowFixture = await seedSiteAccountToken();
    const route = await seedRoute({ modelPattern: 'gpt-4o-weight-test' });

    const fastChannel = await seedChannel({
      routeId: route.id,
      accountId: fastFixture.account.id,
      tokenId: fastFixture.token.id,
      sourceModel: 'gpt-4o-weight-test',
      priority: 3,
    });
    const normalChannel = await seedChannel({
      routeId: route.id,
      accountId: normalFixture.account.id,
      tokenId: normalFixture.token.id,
      sourceModel: 'gpt-4o-weight-test',
      priority: 3,
    });
    const slowChannel = await seedChannel({
      routeId: route.id,
      accountId: slowFixture.account.id,
      tokenId: slowFixture.token.id,
      sourceModel: 'gpt-4o-weight-test',
      priority: 3,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/routes/${route.id}/channels/apply-probe-ranking`,
      payload: {
        ranking: [
          { channelId: fastChannel.id, ttftMs: 500, status: 'supported', httpStatus: 200 },
          { channelId: normalChannel.id, ttftMs: 1500, status: 'supported', httpStatus: 200 },
          { channelId: slowChannel.id, ttftMs: 4000, status: 'supported', httpStatus: 200 },
        ],
      },
    });

    expect(response.statusCode).toBe(200);

    const updatedChannels = await db.select().from(schema.routeChannels)
      .where(inArray(schema.routeChannels.id, [fastChannel.id, normalChannel.id, slowChannel.id]))
      .all();
    const updatedById = new Map(updatedChannels.map((channel) => [channel.id, channel]));
    expect(updatedById.get(fastChannel.id)?.priority).toBe(3);
    expect(updatedById.get(normalChannel.id)?.priority).toBe(3);
    expect(updatedById.get(slowChannel.id)?.priority).toBe(3);
    expect(updatedById.get(fastChannel.id)?.weight).toBe(200);
    expect(updatedById.get(normalChannel.id)?.weight).toBe(100);
    expect(updatedById.get(slowChannel.id)?.weight).toBe(30);
  });

  it('sinks unhealthy channels to maxExistingPriority + 1', async () => {
    const healthyFixture = await seedSiteAccountToken();
    const unhealthyFixture = await seedSiteAccountToken();
    const route = await seedRoute({ modelPattern: 'gpt-4o-sink-test' });

    const healthyChannel = await seedChannel({
      routeId: route.id,
      accountId: healthyFixture.account.id,
      tokenId: healthyFixture.token.id,
      sourceModel: 'gpt-4o-sink-test',
      priority: 9,
    });
    const unhealthyChannel = await seedChannel({
      routeId: route.id,
      accountId: unhealthyFixture.account.id,
      tokenId: unhealthyFixture.token.id,
      sourceModel: 'gpt-4o-sink-test',
      priority: 2,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/routes/${route.id}/channels/apply-probe-ranking`,
      payload: {
        ranking: [
          { channelId: healthyChannel.id, ttftMs: 800, status: 'supported', httpStatus: 200 },
          { channelId: unhealthyChannel.id, ttftMs: null, status: 'unsupported', httpStatus: 401 },
        ],
      },
    });

    expect(response.statusCode).toBe(200);

    const updatedChannels = await db.select().from(schema.routeChannels)
      .where(inArray(schema.routeChannels.id, [healthyChannel.id, unhealthyChannel.id]))
      .all();
    const updatedById = new Map(updatedChannels.map((channel) => [channel.id, channel]));
    expect(updatedById.get(healthyChannel.id)?.priority).toBe(9);
    expect(updatedById.get(healthyChannel.id)?.weight).toBe(200);
    expect(updatedById.get(unhealthyChannel.id)?.priority).toBe(10);
    expect(updatedById.get(unhealthyChannel.id)?.weight).toBe(10);
  });

  it('keeps uncertain channels with original priority and weight', async () => {
    const healthyFixture = await seedSiteAccountToken();
    const inconclusiveFixture = await seedSiteAccountToken();
    const route = await seedRoute({ modelPattern: 'gpt-4o-uncertain-test' });

    const healthyChannel = await seedChannel({
      routeId: route.id,
      accountId: healthyFixture.account.id,
      tokenId: healthyFixture.token.id,
      sourceModel: 'gpt-4o-uncertain-test',
      priority: 1,
    });
    const inconclusiveChannel = await seedChannel({
      routeId: route.id,
      accountId: inconclusiveFixture.account.id,
      tokenId: inconclusiveFixture.token.id,
      sourceModel: 'gpt-4o-uncertain-test',
      priority: 4,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/routes/${route.id}/channels/apply-probe-ranking`,
      payload: {
        ranking: [
          { channelId: healthyChannel.id, ttftMs: 200, status: 'supported', httpStatus: 200 },
          { channelId: inconclusiveChannel.id, ttftMs: null, status: 'inconclusive', httpStatus: null },
        ],
      },
    });

    expect(response.statusCode).toBe(200);

    const updatedChannels = await db.select().from(schema.routeChannels)
      .where(inArray(schema.routeChannels.id, [healthyChannel.id, inconclusiveChannel.id]))
      .all();
    const updatedById = new Map(updatedChannels.map((channel) => [channel.id, channel]));
    expect(updatedById.get(healthyChannel.id)?.priority).toBe(1);
    expect(updatedById.get(healthyChannel.id)?.weight).toBe(200);
    expect(updatedById.get(inconclusiveChannel.id)?.priority).toBe(4);
    expect(updatedById.get(inconclusiveChannel.id)?.weight).toBe(10);
  });
});

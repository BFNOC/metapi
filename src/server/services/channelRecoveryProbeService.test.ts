import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const probeModelsMock = vi.fn();

vi.mock('./modelProbeService.js', () => ({
  probeModels: (...args: unknown[]) => probeModelsMock(...args),
}));

type DbModule = typeof import('../db/index.js');
type ConfigModule = typeof import('../config.js');
type RecoveryModule = typeof import('./channelRecoveryProbeService.js');

describe('channelRecoveryProbeService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let ensureSiteCompatibilityColumns: DbModule['ensureSiteCompatibilityColumns'];
  let config: ConfigModule['config'];
  let runChannelRecoveryProbeSweep: RecoveryModule['runChannelRecoveryProbeSweep'];
  let resetChannelRecoveryProbeServiceState: RecoveryModule['resetChannelRecoveryProbeServiceState'];
  let dataDir = '';
  let seedId = 0;
  let originalEnabled: boolean;
  let originalIntervalMs: number;
  let originalMaxPerSitePerHour: number;

  const nextSeed = () => {
    seedId += 1;
    return seedId;
  };

  async function seedCoolingChannel(options: {
    siteId?: number;
    accountId?: number;
    tokenId?: number;
    routeModel?: string;
    sourceModel?: string | null;
    cooldownUntil?: string;
  } = {}) {
    let siteId = options.siteId;
    if (!siteId) {
      const site = await db.insert(schema.sites).values({
        name: `site-${nextSeed()}`,
        url: `https://site-${seedId}.example.com`,
        platform: 'new-api',
        status: 'active',
      }).returning().get();
      siteId = site.id;
    }

    let accountId = options.accountId;
    if (!accountId) {
      const account = await db.insert(schema.accounts).values({
        siteId,
        username: `user-${nextSeed()}`,
        accessToken: `access-${seedId}`,
        apiToken: `sk-api-${seedId}`,
        status: 'active',
      }).returning().get();
      accountId = account.id;
    }

    let tokenId = options.tokenId;
    if (!tokenId) {
      const token = await db.insert(schema.accountTokens).values({
        accountId,
        name: `token-${nextSeed()}`,
        token: `sk-token-${seedId}`,
        enabled: true,
      }).returning().get();
      tokenId = token.id;
    }

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: options.routeModel || 'gpt-4o-mini',
      enabled: true,
    }).returning().get();

    return await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId,
      tokenId,
      priority: 0,
      weight: 10,
      enabled: true,
      cooldownUntil: options.cooldownUntil || new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      lastFailAt: new Date().toISOString(),
      consecutiveFailCount: 3,
      cooldownLevel: 1,
      sourceModel: options.sourceModel ?? null,
    }).returning().get();
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-channel-recovery-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const configModule = await import('../config.js');
    const recoveryModule = await import('./channelRecoveryProbeService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    ensureSiteCompatibilityColumns = dbModule.ensureSiteCompatibilityColumns;
    config = configModule.config;
    runChannelRecoveryProbeSweep = recoveryModule.runChannelRecoveryProbeSweep;
    resetChannelRecoveryProbeServiceState = recoveryModule.resetChannelRecoveryProbeServiceState;
    originalEnabled = config.channelRecoveryProbeEnabled;
    originalIntervalMs = config.channelRecoveryProbeIntervalMs;
    originalMaxPerSitePerHour = config.channelRecoveryProbeMaxPerSitePerHour;
  });

  beforeEach(async () => {
    seedId = 0;
    probeModelsMock.mockReset();
    resetChannelRecoveryProbeServiceState();
    await ensureSiteCompatibilityColumns();
    config.channelRecoveryProbeEnabled = true;
    config.channelRecoveryProbeIntervalMs = 60_000;
    config.channelRecoveryProbeMaxPerSitePerHour = 4;

    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.settings).run();
  });

  afterAll(() => {
    config.channelRecoveryProbeEnabled = originalEnabled;
    config.channelRecoveryProbeIntervalMs = originalIntervalMs;
    config.channelRecoveryProbeMaxPerSitePerHour = originalMaxPerSitePerHour;
    resetChannelRecoveryProbeServiceState();
    delete process.env.DATA_DIR;
  });

  it('clears channel cooldown when a recovery probe succeeds', async () => {
    const channel = await seedCoolingChannel({
      routeModel: 'gpt-4.1-mini',
    });
    probeModelsMock.mockResolvedValue([
      {
        modelName: 'gpt-4.1-mini',
        status: 'supported',
        ttftMs: 120,
        httpStatus: 200,
        error: null,
        responseText: 'ok',
      },
    ]);

    const result = await runChannelRecoveryProbeSweep(Date.now());
    const refreshed = await db.select()
      .from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();

    expect(result).toMatchObject({
      enabled: true,
      scanned: 1,
      recovered: 1,
    });
    expect(probeModelsMock).toHaveBeenCalledTimes(1);
    expect(refreshed?.cooldownUntil).toBeNull();
    expect(refreshed?.lastFailAt).toBeNull();
    expect(refreshed?.consecutiveFailCount).toBe(0);
    expect(refreshed?.cooldownLevel).toBe(0);
  });

  it('respects per-site hourly probe cap within a sweep', async () => {
    const site = await db.insert(schema.sites).values({
      name: `shared-site-${nextSeed()}`,
      url: `https://shared-site-${seedId}.example.com`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `shared-user-${nextSeed()}`,
      accessToken: `shared-access-${seedId}`,
      apiToken: `shared-api-${seedId}`,
      status: 'active',
    }).returning().get();
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: `shared-token-${nextSeed()}`,
      token: `shared-token-${seedId}`,
      enabled: true,
    }).returning().get();

    await seedCoolingChannel({
      siteId: site.id,
      accountId: account.id,
      tokenId: token.id,
      routeModel: 'gpt-4o-mini',
    });
    await seedCoolingChannel({
      siteId: site.id,
      accountId: account.id,
      tokenId: token.id,
      routeModel: 'gpt-4.1-mini',
    });

    config.channelRecoveryProbeMaxPerSitePerHour = 1;
    probeModelsMock.mockResolvedValue([
      {
        modelName: 'gpt-4o-mini',
        status: 'inconclusive',
        ttftMs: 150,
        httpStatus: 503,
        error: 'upstream overload',
        responseText: null,
      },
    ]);

    const result = await runChannelRecoveryProbeSweep(Date.now());

    expect(result).toMatchObject({
      enabled: true,
      scanned: 1,
      recovered: 0,
      skippedByRateLimit: 1,
    });
    expect(probeModelsMock).toHaveBeenCalledTimes(1);
  });
});

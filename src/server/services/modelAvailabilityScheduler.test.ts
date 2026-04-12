import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { PROBE_PROMPTS } from '../../shared/probePrompts.js';

const probeModelsMock = vi.fn();

vi.mock('./modelProbeService.js', () => ({
  probeModels: (...args: unknown[]) => probeModelsMock(...args),
}));

type DbModule = typeof import('../db/index.js');
type ConfigModule = typeof import('../config.js');
type SchedulerModule = typeof import('./modelAvailabilityScheduler.js');

describe('modelAvailabilityScheduler', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let ensureSiteCompatibilityColumns: DbModule['ensureSiteCompatibilityColumns'];
  let config: ConfigModule['config'];
  let runModelAvailabilitySchedulerSweep: SchedulerModule['runModelAvailabilitySchedulerSweep'];
  let resetModelAvailabilitySchedulerState: SchedulerModule['resetModelAvailabilitySchedulerState'];
  let dataDir = '';
  let seedId = 0;
  let originalEnabled: boolean;
  let originalIntervalMs: number;
  let originalMaxTokensPerSweep: number;
  let originalMaxModelsPerToken: number;

  const nextSeed = () => {
    seedId += 1;
    return seedId;
  };

  async function seedToken(options: {
    siteProxyUrl?: string | null;
    enabled?: boolean;
    tokenValue?: string;
  } = {}) {
    const id = nextSeed();
    const site = await db.insert(schema.sites).values({
      name: `site-${id}`,
      url: `https://site-${id}.example.com`,
      platform: 'new-api',
      status: 'active',
      proxyUrl: options.siteProxyUrl ?? null,
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `user-${id}`,
      accessToken: `access-${id}`,
      apiToken: `api-${id}`,
      status: 'active',
    }).returning().get();
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: `token-${id}`,
      token: options.tokenValue || `sk-token-${id}`,
      enabled: options.enabled ?? true,
      valueStatus: 'ready',
    }).returning().get();
    return { site, account, token };
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-model-availability-scheduler-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const configModule = await import('../config.js');
    const schedulerModule = await import('./modelAvailabilityScheduler.js');
    db = dbModule.db;
    schema = dbModule.schema;
    ensureSiteCompatibilityColumns = dbModule.ensureSiteCompatibilityColumns;
    config = configModule.config;
    runModelAvailabilitySchedulerSweep = schedulerModule.runModelAvailabilitySchedulerSweep;
    resetModelAvailabilitySchedulerState = schedulerModule.resetModelAvailabilitySchedulerState;
    originalEnabled = config.modelAvailabilitySchedulerEnabled;
    originalIntervalMs = config.modelAvailabilitySchedulerIntervalMs;
    originalMaxTokensPerSweep = config.modelAvailabilitySchedulerMaxTokensPerSweep;
    originalMaxModelsPerToken = config.modelAvailabilitySchedulerMaxModelsPerToken;
  });

  beforeEach(async () => {
    seedId = 0;
    probeModelsMock.mockReset();
    resetModelAvailabilitySchedulerState();
    await ensureSiteCompatibilityColumns();
    config.modelAvailabilitySchedulerEnabled = true;
    config.modelAvailabilitySchedulerIntervalMs = 15 * 60 * 1000;
    config.modelAvailabilitySchedulerMaxTokensPerSweep = 2;
    config.modelAvailabilitySchedulerMaxModelsPerToken = 6;

    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    config.modelAvailabilitySchedulerEnabled = originalEnabled;
    config.modelAvailabilitySchedulerIntervalMs = originalIntervalMs;
    config.modelAvailabilitySchedulerMaxTokensPerSweep = originalMaxTokensPerSweep;
    config.modelAvailabilitySchedulerMaxModelsPerToken = originalMaxModelsPerToken;
    resetModelAvailabilitySchedulerState();
    delete process.env.DATA_DIR;
  });

  it('probes bounded model candidates and persists four-state results', async () => {
    const { site, account, token } = await seedToken({
      siteProxyUrl: 'http://127.0.0.1:7890',
    });

    await db.insert(schema.tokenModelAvailability).values([
      {
        tokenId: token.id,
        modelName: 'token-supported',
        available: true,
      },
      {
        tokenId: token.id,
        modelName: 'token-inconclusive-existing',
        available: true,
      },
      {
        tokenId: token.id,
        modelName: 'token-unsupported',
        available: false,
      },
    ]).run();
    await db.insert(schema.modelAvailability).values([
      {
        accountId: account.id,
        modelName: 'account-only-supported',
        available: false,
      },
      {
        accountId: account.id,
        modelName: 'account-only-skipped',
        available: true,
      },
    ]).run();

    probeModelsMock.mockResolvedValue([
      {
        modelName: 'token-supported',
        status: 'supported',
        ttftMs: 100,
        httpStatus: 200,
        error: null,
        responseText: 'ok',
      },
      {
        modelName: 'token-inconclusive-existing',
        status: 'inconclusive',
        ttftMs: 110,
        httpStatus: 503,
        error: 'upstream overload',
        responseText: null,
      },
      {
        modelName: 'token-unsupported',
        status: 'unsupported',
        ttftMs: 120,
        httpStatus: 404,
        error: 'model not found',
        responseText: 'model not found',
      },
      {
        modelName: 'account-only-supported',
        status: 'supported',
        ttftMs: 130,
        httpStatus: 200,
        error: null,
        responseText: 'ok',
      },
      {
        modelName: 'account-only-skipped',
        status: 'skipped',
        ttftMs: 140,
        httpStatus: 429,
        error: 'rate limited',
        responseText: null,
      },
    ]);

    const result = await runModelAvailabilitySchedulerSweep();

    expect(result).toEqual({
      enabled: true,
      tokensScanned: 1,
      modelsScanned: 5,
    });
    expect(probeModelsMock).toHaveBeenCalledTimes(1);
    expect(probeModelsMock.mock.calls[0]?.[0]).toMatchObject({
      siteUrl: site.url,
      apiToken: token.token,
      modelNames: [
        'token-supported',
        'token-inconclusive-existing',
        'token-unsupported',
        'account-only-skipped',
        'account-only-supported',
      ],
      concurrency: 1,
      timeoutMs: 15_000,
    });
    expect(PROBE_PROMPTS).toContain(probeModelsMock.mock.calls[0]?.[0]?.prompt);
    expect(probeModelsMock.mock.calls[0]?.[0]?.dispatcher).toBeTruthy();

    const tokenRows = await db.select()
      .from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, token.id))
      .all();
    const tokenByModel = new Map<string, any>(tokenRows.map((row: any) => [row.modelName, row]));
    expect(tokenByModel.get('token-supported')?.available).toBe(true);
    expect(tokenByModel.get('token-inconclusive-existing')?.available).toBe(true);
    expect(tokenByModel.get('token-unsupported')?.available).toBe(false);
    expect(tokenByModel.get('account-only-supported')?.available).toBe(true);
    expect(tokenByModel.get('account-only-skipped')?.available).toBeNull();

    const accountRows = await db.select()
      .from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();
    const accountByModel = new Map<string, any>(accountRows.map((row: any) => [row.modelName, row]));
    expect(accountByModel.get('account-only-supported')?.available).toBe(true);
    expect(accountByModel.get('account-only-skipped')?.available).toBe(true);
  });

  it('filters tokens without known models and respects maxTokensPerSweep', async () => {
    const first = await seedToken();
    const second = await seedToken();
    await seedToken();

    await db.insert(schema.modelAvailability).values({
      accountId: first.account.id,
      modelName: 'first-account-model',
      available: true,
    }).run();
    await db.insert(schema.tokenModelAvailability).values({
      tokenId: second.token.id,
      modelName: 'second-token-model',
      available: true,
    }).run();

    config.modelAvailabilitySchedulerMaxTokensPerSweep = 1;
    probeModelsMock.mockResolvedValue([
      {
        modelName: 'first-account-model',
        status: 'supported',
        ttftMs: 90,
        httpStatus: 200,
        error: null,
        responseText: 'ok',
      },
    ]);

    const result = await runModelAvailabilitySchedulerSweep();

    expect(result).toEqual({
      enabled: true,
      tokensScanned: 1,
      modelsScanned: 1,
    });
    expect(probeModelsMock).toHaveBeenCalledTimes(1);
    expect(probeModelsMock.mock.calls[0]?.[0]?.modelNames).toEqual(['first-account-model']);
  });
});

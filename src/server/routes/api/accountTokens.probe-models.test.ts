import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { PROBE_PROMPTS } from '../../../shared/probePrompts.js';

const probeModelsMock = vi.fn();
const rebuildRoutesBestEffortMock = vi.fn();

vi.mock('../../services/modelProbeService.js', () => ({
  probeModels: (...args: unknown[]) => probeModelsMock(...args),
}));

vi.mock('../../services/accountMutationWorkflow.js', () => ({
  convergeAccountMutation: vi.fn(),
  refreshAccountCoverageBatch: vi.fn(),
  rebuildRoutesBestEffort: (...args: unknown[]) => rebuildRoutesBestEffortMock(...args),
}));

type DbModule = typeof import('../../db/index.js');

describe('account token probe models route', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let seedId = 0;

  const nextSeed = () => {
    seedId += 1;
    return seedId;
  };

  const seedTokenFixture = async () => {
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
      accessToken: `account-token-${id}`,
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: `token-${id}`,
      token: `sk-token-${id}`,
    }).returning().get();

    return { site, account, token };
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-account-token-probe-models-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    await dbModule.ensureSiteCompatibilityColumns();
    const routesModule = await import('./accountTokens.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.accountTokensRoutes);
  });

  beforeEach(async () => {
    probeModelsMock.mockReset();
    rebuildRoutesBestEffortMock.mockReset();
    seedId = 0;

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

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('uses shared random prompt by default and preserves explicit prompt', async () => {
    const { token } = await seedTokenFixture();
    probeModelsMock.mockResolvedValue([]);

    const defaultPromptResponse = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/${token.id}/probe-models`,
      payload: {
        modelNames: ['gpt-4o-mini'],
      },
    });

    expect(defaultPromptResponse.statusCode).toBe(200);
    expect(probeModelsMock).toHaveBeenCalledTimes(1);
    const defaultPrompt = probeModelsMock.mock.calls[0]?.[0]?.prompt;
    expect(defaultPrompt).not.toBe('hi');
    expect(PROBE_PROMPTS).toContain(defaultPrompt);

    probeModelsMock.mockReset();
    probeModelsMock.mockResolvedValue([]);
    const explicitPromptResponse = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/${token.id}/probe-models`,
      payload: {
        modelNames: ['gpt-4o-mini'],
        prompt: 'please use this prompt',
      },
    });

    expect(explicitPromptResponse.statusCode).toBe(200);
    expect(probeModelsMock).toHaveBeenCalledTimes(1);
    expect(probeModelsMock.mock.calls[0]?.[0]?.prompt).toBe('please use this prompt');
  });

  it('persists four-state probe results without overwriting availability for inconclusive or skipped', async () => {
    const { account, token } = await seedTokenFixture();
    await db.insert(schema.tokenModelAvailability).values([
      {
        tokenId: token.id,
        modelName: 'inconclusive-existing',
        available: true,
        latencyMs: 10,
      },
      {
        tokenId: token.id,
        modelName: 'skipped-existing',
        available: false,
        latencyMs: 20,
      },
    ]).run();
    await db.insert(schema.modelAvailability).values([
      {
        accountId: account.id,
        modelName: 'supported-model',
        available: false,
      },
      {
        accountId: account.id,
        modelName: 'unsupported-model',
        available: false,
      },
    ]).run();

    probeModelsMock.mockResolvedValue([
      {
        modelName: 'supported-model',
        status: 'supported',
        ttftMs: 111,
        httpStatus: 200,
        error: null,
        responseText: 'ok',
      },
      {
        modelName: 'unsupported-model',
        status: 'unsupported',
        ttftMs: 222,
        httpStatus: 404,
        error: 'model not found',
        responseText: 'model not found',
      },
      {
        modelName: 'inconclusive-existing',
        status: 'inconclusive',
        ttftMs: 333,
        httpStatus: null,
        error: 'Timeout after 15000ms',
        responseText: null,
      },
      {
        modelName: 'skipped-existing',
        status: 'skipped',
        ttftMs: 444,
        httpStatus: 429,
        error: 'rate limited',
        responseText: null,
      },
      {
        modelName: 'inconclusive-new',
        status: 'inconclusive',
        ttftMs: 555,
        httpStatus: 503,
        error: 'upstream overload',
        responseText: null,
      },
    ]);
    rebuildRoutesBestEffortMock.mockResolvedValue(undefined);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/${token.id}/probe-models`,
      payload: {
        modelNames: [
          'supported-model',
          'unsupported-model',
          'inconclusive-existing',
          'skipped-existing',
          'inconclusive-new',
        ],
        prompt: 'custom prompt',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      tokenId: token.id,
      results: [
        expect.objectContaining({ modelName: 'supported-model', status: 'supported' }),
        expect.objectContaining({ modelName: 'unsupported-model', status: 'unsupported' }),
        expect.objectContaining({ modelName: 'inconclusive-existing', status: 'inconclusive' }),
        expect.objectContaining({ modelName: 'skipped-existing', status: 'skipped' }),
        expect.objectContaining({ modelName: 'inconclusive-new', status: 'inconclusive' }),
      ],
    });

    const tokenRows = await db.select()
      .from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, token.id))
      .all();
    const tokenByModel = new Map<any, any>(tokenRows.map((row: any) => [row.modelName, row]));

    expect(tokenByModel.get('supported-model')?.available).toBe(true);
    expect(tokenByModel.get('unsupported-model')?.available).toBe(false);
    expect(tokenByModel.get('inconclusive-existing')?.available).toBe(true);
    expect(tokenByModel.get('skipped-existing')?.available).toBe(false);
    expect(tokenByModel.get('inconclusive-new')?.available).toBeNull();

    const accountRows = await db.select()
      .from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();
    const accountByModel = new Map<any, any>(accountRows.map((row: any) => [row.modelName, row]));

    expect(accountByModel.get('supported-model')?.available).toBe(true);
    expect(accountByModel.get('unsupported-model')?.available).toBe(false);
    expect(accountByModel.has('inconclusive-new')).toBe(false);

    expect(rebuildRoutesBestEffortMock).toHaveBeenCalledTimes(1);
  });
});

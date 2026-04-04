import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const rebuildRoutesBestEffortMock = vi.fn();

vi.mock('../../services/accountMutationWorkflow.js', () => ({
  convergeAccountMutation: vi.fn(),
  refreshAccountCoverageBatch: vi.fn(),
  rebuildRoutesBestEffort: (...args: unknown[]) => rebuildRoutesBestEffortMock(...args),
}));

type DbModule = typeof import('../../db/index.js');

describe('account token model mapping routes', () => {
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
      modelMapping: JSON.stringify({ 'glm-5': 'provider-glm-5' }),
    }).returning().get();

    return { site, account, token };
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-account-token-model-mapping-'));
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
    rebuildRoutesBestEffortMock.mockReset();
    rebuildRoutesBestEffortMock.mockResolvedValue(undefined);
    seedId = 0;

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

  it('returns the current token-level model mapping', async () => {
    const { token } = await seedTokenFixture();

    const response = await app.inject({
      method: 'GET',
      url: `/api/account-tokens/${token.id}/model-mapping`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      tokenId: token.id,
      tokenName: token.name,
      modelMapping: { 'glm-5': 'provider-glm-5' },
    });
  });

  it('updates the token-level model mapping and rebuilds routes', async () => {
    const { token } = await seedTokenFixture();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/account-tokens/${token.id}/model-mapping`,
      payload: {
        modelMapping: {
          'gpt-4o-mini': 'provider-gpt-4o-mini',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      tokenId: token.id,
      tokenName: token.name,
      modelMapping: {
        'gpt-4o-mini': 'provider-gpt-4o-mini',
      },
    });
    expect(rebuildRoutesBestEffortMock).toHaveBeenCalledTimes(1);

    const updated = await db.select().from(schema.accountTokens)
      .where(eq(schema.accountTokens.id, token.id))
      .get();
    expect(updated?.modelMapping).toBe(JSON.stringify({
      'gpt-4o-mini': 'provider-gpt-4o-mini',
    }));
  });

  it('clears the token-level model mapping when modelMapping is null', async () => {
    const { token } = await seedTokenFixture();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/account-tokens/${token.id}/model-mapping`,
      payload: {
        modelMapping: null,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(rebuildRoutesBestEffortMock).toHaveBeenCalledTimes(1);

    const updated = await db.select().from(schema.accountTokens)
      .where(eq(schema.accountTokens.id, token.id))
      .get();
    expect(updated?.modelMapping).toBeNull();
  });
});

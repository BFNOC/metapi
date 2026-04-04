import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../../db/index.js');

describe('route channel direct-account binding', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let seedId = 0;

  const nextId = () => {
    seedId += 1;
    return seedId;
  };

  async function createRoute(modelPattern = 'gpt-4o-mini') {
    return await db.insert(schema.tokenRoutes).values({
      modelPattern,
      enabled: true,
    }).returning().get();
  }

  async function createDirectApiKeyAccount(options?: {
    apiToken?: string | null;
    modelName?: string;
  }) {
    const id = nextId();
    const modelName = options?.modelName || 'gpt-4o-mini';
    const site = await db.insert(schema.sites).values({
      name: `site-direct-${id}`,
      url: `https://direct-${id}.example.com`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `welfare-${id}`,
      accessToken: '',
      apiToken: options?.apiToken ?? `sk-direct-${id}`,
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName,
      available: true,
    }).run();

    return { site, account };
  }

  async function createManagedAccountWithTokens(options?: {
    modelName?: string;
  }) {
    const id = nextId();
    const modelName = options?.modelName || 'gpt-4o-mini';
    const site = await db.insert(schema.sites).values({
      name: `site-managed-${id}`,
      url: `https://managed-${id}.example.com`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `managed-${id}`,
      accessToken: `session-${id}`,
      apiToken: `sk-managed-${id}`,
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();

    const defaultToken = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: `default-${id}`,
      token: `sk-default-${id}`,
      enabled: true,
      isDefault: true,
    }).returning().get();

    const fixedToken = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: `fixed-${id}`,
      token: `sk-fixed-${id}`,
      enabled: true,
      isDefault: false,
    }).returning().get();

    await db.insert(schema.tokenModelAvailability).values([
      {
        tokenId: defaultToken.id,
        modelName,
        available: true,
      },
      {
        tokenId: fixedToken.id,
        modelName,
        available: true,
      },
    ]).run();

    return { site, account, defaultToken, fixedToken };
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-tokens-direct-account-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./tokens.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.tokensRoutes);
  });

  beforeEach(async () => {
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

  it('creates a direct-account channel with null tokenId for apikey connections', async () => {
    const { account } = await createDirectApiKeyAccount();
    const route = await createRoute();

    const response = await app.inject({
      method: 'POST',
      url: `/api/routes/${route.id}/channels`,
      payload: {
        accountId: account.id,
        tokenId: null,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { accountId: number; tokenId: number | null };
    expect(body.accountId).toBe(account.id);
    expect(body.tokenId).toBeNull();
  });

  it('batch-adds direct-account channels with null tokenId for apikey connections', async () => {
    const { account } = await createDirectApiKeyAccount();
    const route = await createRoute();

    const response = await app.inject({
      method: 'POST',
      url: `/api/routes/${route.id}/channels/batch`,
      payload: {
        channels: [
          { accountId: account.id, tokenId: null },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      created: 1,
      skipped: 0,
      errors: [],
    });

    const channels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, route.id))
      .all();
    expect(channels).toHaveLength(1);
    expect(channels[0]?.accountId).toBe(account.id);
    expect(channels[0]?.tokenId).toBeNull();
  });

  it('rejects direct-account binding when the apikey principal is missing', async () => {
    const { account } = await createDirectApiKeyAccount({ apiToken: '' });
    const route = await createRoute();

    const response = await app.inject({
      method: 'POST',
      url: `/api/routes/${route.id}/channels`,
      payload: {
        accountId: account.id,
        tokenId: null,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      message: '当前账号主凭证不可用',
    });
  });

  it('keeps null tokenId as direct-account binding on channel updates for apikey connections', async () => {
    const { account } = await createDirectApiKeyAccount();
    const route = await createRoute();
    const mirroredToken = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'legacy-direct-token',
      token: 'sk-legacy-direct',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: mirroredToken.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: true,
    }).returning().get();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/channels/${channel.id}`,
      payload: {
        tokenId: null,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { tokenId: number | null };
    expect(body.tokenId).toBeNull();
  });

  it('rejects null tokenId for managed-token accounts on update', async () => {
    const { account, defaultToken, fixedToken } = await createManagedAccountWithTokens();
    const route = await createRoute();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: fixedToken.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: true,
    }).returning().get();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/channels/${channel.id}`,
      payload: {
        tokenId: null,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      message: '当前账号不支持绑定账号主凭证',
    });

    const updated = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, channel.id)).get();
    expect(updated?.tokenId).toBe(fixedToken.id);
    expect(defaultToken.id).toBeGreaterThan(0);
  });

  it('treats tokenId=0 as follow-default for managed-token accounts on update', async () => {
    const { account, defaultToken, fixedToken } = await createManagedAccountWithTokens();
    const route = await createRoute();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: fixedToken.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: true,
    }).returning().get();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/channels/${channel.id}`,
      payload: {
        tokenId: 0,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      tokenId: null,
    });

    const updated = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, channel.id)).get();
    expect(updated?.tokenId).toBeNull();
    expect(defaultToken.id).toBeGreaterThan(0);
  });
});

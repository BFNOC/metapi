import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { getModelsMock, verifyTokenMock, startBackgroundTaskMock } = vi.hoisted(() => ({
  getModelsMock: vi.fn(),
  verifyTokenMock: vi.fn(),
  startBackgroundTaskMock: vi.fn(),
}));

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    getModels: (...args: unknown[]) => getModelsMock(...args),
    verifyToken: (...args: unknown[]) => verifyTokenMock(...args),
  }),
}));

vi.mock('../../services/backgroundTaskService.js', () => ({
  startBackgroundTask: (...args: unknown[]) => startBackgroundTaskMock(...args),
}));

type DbModule = typeof import('../../db/index.js');

describe('accounts batch API key creation', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-batch-create-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./accounts.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.accountsRoutes);
  });

  beforeEach(async () => {
    getModelsMock.mockReset();
    verifyTokenMock.mockReset();
    startBackgroundTaskMock.mockReset();
    startBackgroundTaskMock.mockImplementation(() => ({
      task: { id: 'task-batch-create' },
    }));

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
    if (dataDir) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch { }
    }
    delete process.env.DATA_DIR;
  });

  async function createSite() {
    return await db.insert(schema.sites).values({
      name: 'Batch Site',
      url: 'https://batch.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
  }

  it('creates multiple API key connections from multiline input', async () => {
    getModelsMock.mockResolvedValue(['gpt-4o-mini']);
    const site = await createSite();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        username: 'batch-key',
        accessToken: 'sk-batch-a\nsk-batch-b',
        credentialMode: 'apikey',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      batch: true,
      totalCount: 2,
      createdCount: 2,
      failedCount: 0,
    });

    expect(getModelsMock).toHaveBeenNthCalledWith(1, 'https://batch.example.com', 'sk-batch-a', undefined);
    expect(getModelsMock).toHaveBeenNthCalledWith(2, 'https://batch.example.com', 'sk-batch-b', undefined);

    const accounts = await db.select().from(schema.accounts).orderBy(schema.accounts.id).all();
    expect(accounts).toHaveLength(2);
    expect(accounts.map((item: any) => item.apiToken)).toEqual(['sk-batch-a', 'sk-batch-b']);
    expect(accounts.map((item: any) => item.username)).toEqual(['batch-key #1', 'batch-key #2']);
  });

  it('treats accessTokens payloads as batch API key creation without credentialMode', async () => {
    const site = await createSite();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        username: 'array-batch',
        accessTokens: ['sk-array-a', 'sk-array-b'],
        skipModelFetch: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      batch: true,
      totalCount: 2,
      createdCount: 2,
      failedCount: 0,
    });
    expect(getModelsMock).not.toHaveBeenCalled();
    expect(verifyTokenMock).not.toHaveBeenCalled();

    const accounts = await db.select().from(schema.accounts).orderBy(schema.accounts.id).all();
    expect(accounts.map((item: any) => item.apiToken)).toEqual(['sk-array-a', 'sk-array-b']);
  });

  it('returns an aggregated success payload when batch creation partially fails', async () => {
    getModelsMock
      .mockResolvedValueOnce(['gpt-4o-mini'])
      .mockRejectedValueOnce(new Error('second key invalid'));
    const site = await createSite();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        accessToken: 'sk-partial-a\nsk-partial-b',
        credentialMode: 'apikey',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      batch: true,
      totalCount: 2,
      createdCount: 1,
      failedCount: 1,
      items: [
        { index: 0, status: 'created' },
        { index: 1, status: 'failed', message: 'second key invalid' },
      ],
    });

    const accounts = await db.select().from(schema.accounts).all();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.apiToken).toBe('sk-partial-a');
  });

  it('returns an aggregated error payload when all batch entries fail validation', async () => {
    getModelsMock
      .mockRejectedValueOnce(new Error('key a invalid'))
      .mockRejectedValueOnce(new Error('key b invalid'));
    const site = await createSite();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        accessToken: 'sk-fail-a\nsk-fail-b',
        credentialMode: 'apikey',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      batch: true,
      totalCount: 2,
      createdCount: 0,
      failedCount: 2,
      message: expect.stringContaining('批量添加失败'),
      items: [
        { index: 0, status: 'failed', message: 'key a invalid' },
        { index: 1, status: 'failed', message: 'key b invalid' },
      ],
    });

    const accounts = await db.select().from(schema.accounts).all();
    expect(accounts).toHaveLength(0);
  });
});

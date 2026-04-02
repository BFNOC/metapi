import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
}));

function createStreamBody(chunks: string[]) {
  return {
    getReader() {
      let index = 0;
      return {
        async read() {
          if (index < chunks.length) {
            const value = new TextEncoder().encode(chunks[index] || '');
            index += 1;
            return { done: false, value };
          }
          return { done: true, value: undefined };
        },
        releaseLock() {},
      };
    },
  };
}

describe('modelProbeService', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function loadModule() {
    return await import('./modelProbeService.js');
  }

  it('classifies streamed 2xx responses as supported', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      body: createStreamBody([
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    });

    const { probeModels } = await loadModule();
    const [result] = await probeModels({
      siteUrl: 'https://probe.example.com',
      apiToken: 'sk-token',
      modelNames: ['gpt-4o-mini'],
      prompt: 'custom prompt',
      concurrency: 1,
      timeoutMs: 1500,
      delayMs: 0,
    });

    expect(result).toMatchObject({
      modelName: 'gpt-4o-mini',
      status: 'supported',
      httpStatus: 200,
      error: null,
      responseText: 'hello',
    });
  });

  it('classifies 404 and explicit model-not-found errors as unsupported', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'not found',
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: 'Unsupported model for this endpoint' } }),
      });

    const { probeModels } = await loadModule();
    const results = await probeModels({
      siteUrl: 'https://probe.example.com',
      apiToken: 'sk-token',
      modelNames: ['missing-model', 'wrong-model'],
      prompt: 'custom prompt',
      concurrency: 2,
      timeoutMs: 1500,
      delayMs: 0,
    });

    expect(results.map((item) => item.status)).toEqual(['unsupported', 'unsupported']);
  });

  it('classifies 401 as skipped', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    });

    const { probeModels } = await loadModule();
    const [result] = await probeModels({
      siteUrl: 'https://probe.example.com',
      apiToken: 'sk-token',
      modelNames: ['gpt-4o-mini'],
      prompt: 'custom prompt',
      concurrency: 1,
      timeoutMs: 1500,
      delayMs: 0,
    });

    expect(result?.status).toBe('skipped');
  });

  it('classifies missing body and 5xx responses as inconclusive', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: null,
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => 'upstream overload',
      });

    const { probeModels } = await loadModule();
    const results = await probeModels({
      siteUrl: 'https://probe.example.com',
      apiToken: 'sk-token',
      modelNames: ['missing-body', 'server-error'],
      prompt: 'custom prompt',
      concurrency: 2,
      timeoutMs: 1500,
      delayMs: 0,
    });

    expect(results.map((item) => item.status)).toEqual(['inconclusive', 'inconclusive']);
  });

  it('classifies internal aborts as inconclusive timeouts', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    const { probeModels } = await loadModule();
    const [result] = await probeModels({
      siteUrl: 'https://probe.example.com',
      apiToken: 'sk-token',
      modelNames: ['timeout-model'],
      prompt: 'custom prompt',
      concurrency: 1,
      timeoutMs: 1234,
      delayMs: 0,
    });

    expect(result).toMatchObject({
      status: 'inconclusive',
      ttftMs: 1234,
      error: 'Timeout after 1234ms',
    });
  });

  it('classifies external aborts as skipped', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async (_url: string, init?: { signal?: AbortSignal }) => {
      return await new Promise((_, reject) => {
        if (init?.signal?.aborted) {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          return;
        }
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
    });

    const { probeModels } = await loadModule();
    const pendingResults = probeModels({
      siteUrl: 'https://probe.example.com',
      apiToken: 'sk-token',
      modelNames: ['cancelled-model'],
      prompt: 'custom prompt',
      concurrency: 1,
      timeoutMs: 1500,
      delayMs: 0,
      signal: controller.signal,
    });
    controller.abort();
    const [result] = await pendingResults;

    expect(result).toMatchObject({
      status: 'skipped',
      error: 'Client disconnected',
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchModelPricingCatalogMock = vi.fn(async (_arg?: unknown): Promise<any> => null);

vi.mock('../../services/modelPricingService.js', () => ({
  fetchModelPricingCatalog: (arg: unknown) => fetchModelPricingCatalogMock(arg),
}));

import { isEndpointDowngradeError, resolveUpstreamEndpointCandidates } from './upstreamEndpoint.js';

const baseContext = {
  site: {
    id: 1,
    url: 'https://upstream.example.com',
    platform: '',
    apiKey: null,
  },
  account: {
    id: 2,
    accessToken: 'token-demo',
    apiToken: null,
  },
};

describe('resolveUpstreamEndpointCandidates', () => {
  beforeEach(() => {
    fetchModelPricingCatalogMock.mockReset();
    fetchModelPricingCatalogMock.mockResolvedValue(null);
  });

  it('uses downstream-aligned endpoint priority for unknown platforms', async () => {
    const openaiOrder = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: { ...baseContext.site, platform: 'new-api' },
      },
      'gpt-5.3',
      'openai',
    );
    expect(openaiOrder).toEqual(['chat', 'messages', 'responses']);

    const claudeOrder = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: { ...baseContext.site, platform: 'new-api' },
      },
      'gpt-5.3',
      'claude',
    );
    expect(claudeOrder).toEqual(['messages', 'chat', 'responses']);

    const responsesOrder = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: { ...baseContext.site, platform: 'new-api' },
      },
      'gpt-5.3',
      'responses',
    );
    expect(responsesOrder).toEqual(['responses', 'chat', 'messages']);
  });

  it('prioritizes messages-first for claude-family models on openai downstream', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'claude-opus-4-6',
          supportedEndpointTypes: ['anthropic', 'openai'],
        },
      ],
      groupRatio: {},
    });

    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: { ...baseContext.site, platform: 'new-api' },
      },
      'claude-opus-4-6',
      'openai',
    );

    expect(order).toEqual(['messages', 'chat', 'responses']);

    const aliasedOrder = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: { ...baseContext.site, platform: 'new-api' },
      },
      'upstream-gpt',
      'openai',
      'claude-haiku-4-5-20251001',
    );

    expect(aliasedOrder).toEqual(['messages', 'chat', 'responses']);
  });

  it('keeps explicit platform priority rules', async () => {
    const openaiOrder = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: { ...baseContext.site, platform: 'openai' },
      },
      'gpt-5.3',
      'openai',
    );
    expect(openaiOrder).toEqual(['chat', 'responses', 'messages']);

    const openaiResponsesOrder = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: { ...baseContext.site, platform: 'openai' },
      },
      'gpt-5.3',
      'responses',
    );
    expect(openaiResponsesOrder).toEqual(['responses', 'chat', 'messages']);

    const openaiClaudeOrder = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: { ...baseContext.site, platform: 'openai' },
      },
      'claude-opus-4-6',
      'openai',
    );
    expect(openaiClaudeOrder).toEqual(['messages', 'chat', 'responses']);

    const claudeOrder = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: { ...baseContext.site, platform: 'claude' },
      },
      'claude-opus-4-6',
      'claude',
    );
    expect(claudeOrder).toEqual(['messages']);
  });

  it('keeps claude models messages-first even when openai platform catalog prefers chat', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'claude-opus-4-6',
          supportedEndpointTypes: ['/v1/chat/completions', 'openai'],
        },
      ],
      groupRatio: {},
    });

    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: { ...baseContext.site, platform: 'openai' },
      },
      'claude-opus-4-6',
      'openai',
    );

    expect(order).toEqual(['messages', 'chat', 'responses']);
  });

  it('keeps anyrouter messages-first special case', async () => {
    const openaiOrder = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: { ...baseContext.site, platform: 'anyrouter' },
      },
      'claude-opus-4-6',
      'openai',
    );
    expect(openaiOrder).toEqual(['messages', 'chat']);

    const responsesOrder = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: { ...baseContext.site, platform: 'anyrouter' },
      },
      'claude-opus-4-6',
      'responses',
    );
    expect(responsesOrder).toEqual(['responses', 'messages', 'chat']);
  });

  it('treats endpoint-not-found responses as downgrade candidates', () => {
    expect(isEndpointDowngradeError(404, '{"error":{"message":"Not Found","type":"not_found_error"}}')).toBe(true);
    expect(isEndpointDowngradeError(405, '{"error":{"message":"Method Not Allowed"}}')).toBe(true);
    expect(isEndpointDowngradeError(400, '{"error":{"message":"unsupported endpoint","type":"invalid_request_error"}}')).toBe(true);
  });

  it('treats Claude Code CLI-only restriction on responses as downgrade candidate', () => {
    const upstreamError = JSON.stringify({
      error: {
        code: 'invalid_request',
        type: 'new_api_error',
        message: '请勿在 Claude Code CLI 之外使用接口 (request id: abc123)',
      },
    });

    expect(isEndpointDowngradeError(400, upstreamError)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import {
  normalizeEndpointOverridesInput,
  parseEndpointOverrideValue,
  resolveEndpointCandidatesWithOverrides,
  resolveRecordEndpointOverride,
  resolveSiteEndpointOverride,
  serializeEndpointOverridesValue,
} from './endpointOverrides.js';

describe('endpointOverrides', () => {
  it('treats empty strings and empty arrays as inherit on read', () => {
    expect(parseEndpointOverrideValue('')).toEqual({ present: false, endpoints: [] });
    expect(parseEndpointOverrideValue('   ')).toEqual({ present: false, endpoints: [] });
    expect(parseEndpointOverrideValue([])).toEqual({ present: false, endpoints: [] });
    expect(parseEndpointOverrideValue('[]')).toEqual({ present: false, endpoints: [] });
  });

  it('keeps resolveSiteEndpointOverride as a backward-compatible alias', () => {
    const site = { endpointOverrides: ['responses'] };

    expect(resolveSiteEndpointOverride(site)).toEqual(resolveRecordEndpointOverride(site));
  });

  it('applies token > account > site replace semantics before request override filtering', () => {
    expect(resolveEndpointCandidatesWithOverrides({
      candidates: ['chat', 'messages', 'responses'],
      site: { endpointOverrides: ['chat', 'messages'] },
      account: { endpointOverrides: ['responses'] },
      token: { endpointOverrides: [] },
    })).toEqual(['responses']);

    expect(resolveEndpointCandidatesWithOverrides({
      candidates: ['chat', 'messages', 'responses'],
      site: { endpointOverrides: ['chat', 'messages'] },
      account: { endpointOverrides: ['responses'] },
      token: { endpointOverrides: ['chat'] },
    })).toEqual(['chat']);

    expect(resolveEndpointCandidatesWithOverrides({
      candidates: ['chat', 'messages', 'responses'],
      site: { endpointOverrides: ['responses'] },
      account: { endpointOverrides: ['responses'] },
      override: ['chat'],
    })).toEqual([]);
  });

  it('normalizes API input and serializes stored values consistently', () => {
    expect(normalizeEndpointOverridesInput([])).toEqual({ endpointOverrides: null });
    expect(normalizeEndpointOverridesInput('')).toEqual({ endpointOverrides: null });
    expect(normalizeEndpointOverridesInput(['responses', 'chat', 'responses'])).toEqual({
      endpointOverrides: ['responses', 'chat'],
    });
    expect(normalizeEndpointOverridesInput(['openai'])).toEqual({
      endpointOverrides: null,
      error: 'Invalid endpointOverrides. Only chat/messages/responses are supported.',
    });

    expect(serializeEndpointOverridesValue(null)).toBeNull();
    expect(serializeEndpointOverridesValue('[]')).toBeNull();
    expect(serializeEndpointOverridesValue(['responses', 'chat', 'responses'])).toBe('["responses","chat"]');
  });
});

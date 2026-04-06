import { describe, expect, it } from 'vitest';

import {
  sanitizeCompactResponsesRequestBody,
  shouldFallbackCompactResponsesToResponses,
} from './responsesCompact.js';

describe('responsesCompact', () => {
  it('strips stream-only fields from compact requests', () => {
    expect(sanitizeCompactResponsesRequestBody({
      model: 'gpt-5.4',
      input: 'hello',
      stream: false,
      stream_options: { include_obfuscation: true },
      instructions: '',
    })).toEqual({
      model: 'gpt-5.4',
      input: 'hello',
      instructions: '',
    });
  });

  it('matches explicit compact endpoint absence and protocol mismatch errors', () => {
    expect(shouldFallbackCompactResponsesToResponses({
      status: 404,
      rawErrText: 'Invalid URL (POST /v1/responses/compact)',
    })).toBe(true);

    expect(shouldFallbackCompactResponsesToResponses({
      status: 422,
      rawErrText: 'Invalid URL (POST /v1/responses/compact)',
    })).toBe(true);

    expect(shouldFallbackCompactResponsesToResponses({
      status: 422,
      rawErrText: 'Compact endpoint not supported by this upstream',
    })).toBe(true);

    expect(shouldFallbackCompactResponsesToResponses({
      status: 422,
      rawErrText: "unknown parameter: 'stream'",
    })).toBe(true);
  });

  it('does not match unrelated unsupported or auth errors', () => {
    expect(shouldFallbackCompactResponsesToResponses({
      status: 404,
      rawErrText: 'Model not found',
    })).toBe(false);

    expect(shouldFallbackCompactResponsesToResponses({
      status: 422,
      rawErrText: 'Model not supported for this account',
    })).toBe(false);

    expect(shouldFallbackCompactResponsesToResponses({
      status: 403,
      rawErrText: 'permission denied',
    })).toBe(false);

    expect(shouldFallbackCompactResponsesToResponses({
      status: 429,
      rawErrText: 'insufficient_quota',
    })).toBe(false);
  });
});

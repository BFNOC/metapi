import { describe, expect, it } from 'vitest';
import { composeProxyLogMessage } from './logPathMeta.js';

describe('composeProxyLogMessage', () => {
  it('adds downstream path metadata before plain errors', () => {
    expect(composeProxyLogMessage({
      downstreamPath: '/v1/responses',
      errorMessage: 'upstream failed',
    })).toBe('[downstream:/v1/responses] upstream failed');
  });

  it('keeps existing upstream metadata and avoids duplicate prefixes', () => {
    expect(composeProxyLogMessage({
      downstreamPath: '/v1/responses',
      errorMessage: '[upstream:/v1/chat/completions] bad request',
    })).toBe('[downstream:/v1/responses] [upstream:/v1/chat/completions] bad request');
  });

  it('returns metadata-only message when no error text exists', () => {
    expect(composeProxyLogMessage({
      downstreamPath: '/v1/chat/completions',
      upstreamPath: '/v1/messages',
      errorMessage: null,
    })).toBe('[downstream:/v1/chat/completions] [upstream:/v1/messages]');
  });

  it('returns null when nothing can be recorded', () => {
    expect(composeProxyLogMessage({
      downstreamPath: null,
      upstreamPath: null,
      errorMessage: '',
    })).toBe(null);
  });
});

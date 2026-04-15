import { describe, expect, it, vi } from 'vitest';
import { Response } from 'undici';

import { createResponsesEndpointStrategy } from './routeCompatibility.js';

function createStrategy() {
  return createResponsesEndpointStrategy({
    isStream: false,
    requiresNativeResponsesFileUrl: false,
    dispatchRequest: vi.fn(),
  });
}

function createContext(input?: {
  endpoint?: 'chat' | 'messages' | 'responses';
  path?: string;
  status?: number;
  rawErrText?: string;
}) {
  const endpoint = input?.endpoint ?? 'responses';
  const path = input?.path ?? '/v1/responses';
  const status = input?.status ?? 403;
  const rawErrText = input?.rawErrText ?? '';

  return {
    request: {
      endpoint,
      path,
      headers: {},
      body: {},
    },
    targetUrl: `https://upstream.example.com${path}`,
    response: new Response(rawErrText, { status }),
    rawErrText,
  };
}

describe('createResponsesEndpointStrategy.shouldDowngrade', () => {
  it('downgrades responses endpoint requests when upstream blocks the route with 403', () => {
    const strategy = createStrategy();

    const shouldDowngrade = strategy.shouldDowngrade(createContext({
      rawErrText: JSON.stringify({
        error: {
          message: 'Your request was blocked',
        },
      }),
    }));

    expect(shouldDowngrade).toBe(true);
  });

  it('does not downgrade the same 403 block message for chat endpoint requests', () => {
    const strategy = createStrategy();

    const shouldDowngrade = strategy.shouldDowngrade(createContext({
      endpoint: 'chat',
      path: '/v1/chat/completions',
      rawErrText: JSON.stringify({
        error: {
          message: 'Your request was blocked',
        },
      }),
    }));

    expect(shouldDowngrade).toBe(false);
  });

  it('does not downgrade 403 auth failures on responses endpoint', () => {
    const strategy = createStrategy();

    const shouldDowngrade = strategy.shouldDowngrade(createContext({
      rawErrText: JSON.stringify({
        error: {
          message: 'Invalid API key provided',
        },
      }),
    }));

    expect(shouldDowngrade).toBe(false);
  });

  it('does not downgrade empty 403 errors on responses endpoint', () => {
    const strategy = createStrategy();

    const shouldDowngrade = strategy.shouldDowngrade(createContext({
      rawErrText: '',
    }));

    expect(shouldDowngrade).toBe(false);
  });

  it('keeps existing endpoint downgrade behavior for 404 and 200 responses', () => {
    const strategy = createStrategy();

    expect(strategy.shouldDowngrade(createContext({
      status: 404,
      rawErrText: JSON.stringify({
        error: {
          message: 'Not Found',
          type: 'not_found_error',
        },
      }),
    }))).toBe(true);

    expect(strategy.shouldDowngrade(createContext({
      status: 200,
      rawErrText: '',
    }))).toBe(false);
  });
});

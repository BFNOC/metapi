import { describe, expect, it } from 'vitest';

import {
  fetchWithObservedFirstByte,
  getObservedResponseMeta,
  isObservedFirstByteTimeoutResponse,
} from './firstByteTimeout.js';

function buildDelayedResponse(bodyText: string, delayMs: number, status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      setTimeout(() => {
        controller.enqueue(encoder.encode(bodyText));
        controller.close();
      }, delayMs);
    },
  });
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

describe('fetchWithObservedFirstByte', () => {
  it('replays the first chunk and records first-byte latency when upstream responds in time', async () => {
    const response = await fetchWithObservedFirstByte(
      async () => buildDelayedResponse('hello world', 5) as any,
      {
        firstByteTimeoutMs: 100,
        startedAtMs: Date.now(),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello world');

    const meta = getObservedResponseMeta(response);
    expect(meta?.timedOutBeforeFirstByte).toBe(false);
    expect(meta?.firstByteLatencyMs).not.toBeNull();
    expect(meta?.firstByteLatencyMs).toBeGreaterThanOrEqual(0);
    expect(meta?.firstByteLatencyMs).toBeLessThan(100);
  });

  it('returns a synthetic timeout response when upstream sends no first byte before the deadline', async () => {
    const response = await fetchWithObservedFirstByte(
      async () => buildDelayedResponse('too late', 80) as any,
      {
        firstByteTimeoutMs: 10,
        startedAtMs: Date.now(),
      },
    );

    expect(response.status).toBe(408);
    expect(await response.text()).toContain('first byte timeout');
    expect(isObservedFirstByteTimeoutResponse(response)).toBe(true);

    const meta = getObservedResponseMeta(response);
    expect(meta?.timedOutBeforeFirstByte).toBe(true);
    expect(meta?.firstByteLatencyMs).toBeNull();
  });

  it('preserves non-ok response bodies after replaying the first observed chunk', async () => {
    const response = await fetchWithObservedFirstByte(
      async () => buildDelayedResponse('upstream unavailable', 5, 503) as any,
      {
        firstByteTimeoutMs: 100,
        startedAtMs: Date.now(),
      },
    );

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe('upstream unavailable');

    const meta = getObservedResponseMeta(response);
    expect(meta?.timedOutBeforeFirstByte).toBe(false);
    expect(meta?.firstByteLatencyMs).not.toBeNull();
  });

  it('skips timeout wrapping when firstByteTimeoutMs is 0', async () => {
    let receivedSignal: AbortSignal | undefined;
    const response = await fetchWithObservedFirstByte(
      async (signal) => {
        receivedSignal = signal;
        return buildDelayedResponse('no timeout', 5) as any;
      },
      {
        firstByteTimeoutMs: 0,
        startedAtMs: Date.now(),
      },
    );

    expect(receivedSignal).toBeUndefined();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('no timeout');
    expect(isObservedFirstByteTimeoutResponse(response)).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { deriveProbeHealthStatus, aggregateProbeHealthStats } from './probeHealthClassifier.js';

describe('deriveProbeHealthStatus', () => {
  describe('success cases', () => {
    it('should return success for supported status', () => {
      expect(deriveProbeHealthStatus('supported', 200, null)).toBe('success');
      expect(deriveProbeHealthStatus('supported', 200, '')).toBe('success');
    });
  });

  describe('auth/rate-limit cases (skipped)', () => {
    it('should return failure for 401/403/429 with httpStatus', () => {
      expect(deriveProbeHealthStatus('skipped', 401, 'Invalid API key')).toBe('failure');
      expect(deriveProbeHealthStatus('skipped', 403, 'Forbidden')).toBe('failure');
      expect(deriveProbeHealthStatus('skipped', 429, 'Rate limit exceeded')).toBe('failure');
      expect(deriveProbeHealthStatus('skipped', 429, 'All credentials for model gpt-5.4 are cooling down')).toBe('failure');
    });

    it('should return skipped for skipped without httpStatus', () => {
      expect(deriveProbeHealthStatus('skipped', null, '通道无有效探活令牌')).toBe('skipped');
      expect(deriveProbeHealthStatus('skipped', null, 'No token available')).toBe('skipped');
    });
  });

  describe('model not supported', () => {
    it('should return failure for unsupported status', () => {
      expect(deriveProbeHealthStatus('unsupported', 404, 'Model not found')).toBe('failure');
      expect(deriveProbeHealthStatus('unsupported', 400, 'Unsupported model')).toBe('failure');
    });
  });

  describe('5xx errors', () => {
    it('should return failure for 5xx status codes', () => {
      expect(deriveProbeHealthStatus('inconclusive', 500, 'Internal Server Error')).toBe('failure');
      expect(deriveProbeHealthStatus('inconclusive', 502, 'Bad Gateway')).toBe('failure');
      expect(deriveProbeHealthStatus('inconclusive', 503, 'Service temporarily unavailable')).toBe('failure');
      expect(deriveProbeHealthStatus('inconclusive', 521, 'Web server is down')).toBe('failure');
    });
  });

  describe('timeout errors', () => {
    it('should return failure for timeout errors', () => {
      expect(deriveProbeHealthStatus('inconclusive', null, 'Timeout after 15000ms')).toBe('failure');
      expect(deriveProbeHealthStatus('inconclusive', null, 'Timeout after 30000ms')).toBe('failure');
    });
  });

  describe('network errors', () => {
    it('should return failure for fetch failed', () => {
      expect(deriveProbeHealthStatus('inconclusive', null, 'fetch failed')).toBe('failure');
      expect(deriveProbeHealthStatus('inconclusive', null, 'Fetch Failed')).toBe('failure');
    });
  });

  describe('gateway errors', () => {
    it('should return failure for bad gateway', () => {
      expect(deriveProbeHealthStatus('inconclusive', 502, 'Bad Gateway')).toBe('failure');
      expect(deriveProbeHealthStatus('inconclusive', 502, 'bad gateway')).toBe('failure');
    });
  });

  describe('service unavailable', () => {
    it('should return failure for service temporarily unavailable', () => {
      expect(deriveProbeHealthStatus('inconclusive', 503, 'Service temporarily unavailable')).toBe('failure');
      expect(deriveProbeHealthStatus('inconclusive', 503, 'Service Temporarily Unavailable')).toBe('failure');
    });
  });

  describe('resource overload', () => {
    it('should return failure for overload errors', () => {
      expect(deriveProbeHealthStatus('inconclusive', 503, 'system disk overloaded')).toBe('failure');
      expect(deriveProbeHealthStatus('inconclusive', 503, 'system cpu overloaded')).toBe('failure');
      expect(deriveProbeHealthStatus('inconclusive', 503, 'System Overload')).toBe('failure');
    });
  });

  describe('configuration errors', () => {
    it('should return failure for no available channels', () => {
      expect(deriveProbeHealthStatus('inconclusive', 503, '分组 gpt 下模型 gpt-5.4 无可用渠道（distributor）')).toBe('failure');
      expect(deriveProbeHealthStatus('inconclusive', 503, '当前分组 默认分组 下对于模型 gpt-5.4 无可用渠道')).toBe('failure');
    });

    it('should return failure for unknown provider', () => {
      expect(deriveProbeHealthStatus('inconclusive', 502, 'unknown provider for model gpt-5.4')).toBe('failure');
      expect(deriveProbeHealthStatus('inconclusive', 502, 'Unknown Provider')).toBe('failure');
    });
  });

  describe('HTML error pages', () => {
    it('should return failure for HTML error pages', () => {
      expect(deriveProbeHealthStatus('inconclusive', 521, '<!DOCTYPE html>\n<!--[if lt IE 7]>')).toBe('failure');
      expect(deriveProbeHealthStatus('inconclusive', 502, '<html><head><title>Error</title></head></html>')).toBe('failure');
    });
  });

  describe('truly unknown cases', () => {
    it('should return unknown for ambiguous errors', () => {
      expect(deriveProbeHealthStatus('inconclusive', 200, 'No response body')).toBe('unknown');
      expect(deriveProbeHealthStatus('inconclusive', 200, 'Stream ended immediately')).toBe('unknown');
      expect(deriveProbeHealthStatus('inconclusive', null, 'Probe returned no result')).toBe('unknown');
      expect(deriveProbeHealthStatus('inconclusive', null, 'Unknown error')).toBe('unknown');
    });
  });
});

describe('aggregateProbeHealthStats', () => {
  it('should aggregate empty results', () => {
    const stats = aggregateProbeHealthStats([]);
    expect(stats).toEqual({
      successCount: 0,
      failureCount: 0,
      unknownCount: 0,
      skippedCount: 0,
    });
  });

  it('should aggregate mixed results', () => {
    const results = [
      { status: 'supported', httpStatus: 200, error: null },
      { status: 'supported', httpStatus: 200, error: null },
      { status: 'skipped', httpStatus: 401, error: 'Invalid API key' },
      { status: 'skipped', httpStatus: 403, error: 'Forbidden' },
      { status: 'inconclusive', httpStatus: 502, error: 'Bad Gateway' },
      { status: 'inconclusive', httpStatus: 503, error: 'Service temporarily unavailable' },
      { status: 'inconclusive', httpStatus: null, error: 'Timeout after 15000ms' },
      { status: 'unsupported', httpStatus: 404, error: 'Model not found' },
      { status: 'inconclusive', httpStatus: 200, error: 'No response body' },
      { status: 'skipped', httpStatus: null, error: '通道无有效探活令牌' },
    ];

    const stats = aggregateProbeHealthStats(results);
    expect(stats).toEqual({
      successCount: 2,
      failureCount: 6, // 401, 403, 502, 503, timeout, unsupported
      unknownCount: 1, // No response body
      skippedCount: 1, // 通道无有效探活令牌
    });
  });

  it('should handle real-world probe data', () => {
    const results = [
      { status: 'inconclusive', httpStatus: 503, error: '分组 gpt 下模型 gpt-5.4 无可用渠道（distributor）' },
      { status: 'inconclusive', httpStatus: 503, error: 'system disk overloaded' },
      { status: 'inconclusive', httpStatus: 521, error: '<!DOCTYPE html>' },
      { status: 'inconclusive', httpStatus: 502, error: 'unknown provider for model gpt-5.4' },
      { status: 'inconclusive', httpStatus: null, error: 'fetch failed' },
      { status: 'inconclusive', httpStatus: 503, error: 'Service temporarily unavailable' },
      { status: 'inconclusive', httpStatus: 502, error: 'Bad Gateway' },
      { status: 'inconclusive', httpStatus: null, error: 'Timeout after 15000ms' },
      { status: 'supported', httpStatus: 200, error: null },
      { status: 'skipped', httpStatus: 401, error: 'Invalid API key' },
    ];

    const stats = aggregateProbeHealthStats(results);
    expect(stats.successCount).toBe(1);
    expect(stats.failureCount).toBe(9); // All except success
    expect(stats.unknownCount).toBe(0);
    expect(stats.skippedCount).toBe(0);
  });
});

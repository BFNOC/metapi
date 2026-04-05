import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type SiteHealthSignalsModule = typeof import('./siteHealthSignals.js');

let classifySiteHealthFailure: SiteHealthSignalsModule['classifySiteHealthFailure'];
let deriveSiteHealthState: SiteHealthSignalsModule['deriveSiteHealthState'];
let deriveSiteProbePolicy: SiteHealthSignalsModule['deriveSiteProbePolicy'];
let resolveSiteHealthPenaltyMultiplier: SiteHealthSignalsModule['resolveSiteHealthPenaltyMultiplier'];
let dataDir = '';

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'metapi-site-health-signals-'));
  process.env.DATA_DIR = dataDir;
  const module = await import('./siteHealthSignals.js');
  classifySiteHealthFailure = module.classifySiteHealthFailure;
  deriveSiteHealthState = module.deriveSiteHealthState;
  deriveSiteProbePolicy = module.deriveSiteProbePolicy;
  resolveSiteHealthPenaltyMultiplier = module.resolveSiteHealthPenaltyMultiplier;
});

afterAll(() => {
  delete process.env.DATA_DIR;
});

describe('siteHealthSignals', () => {
  it('classifies auth, 429, 5xx, challenge, empty and timeout failures', () => {
    expect(classifySiteHealthFailure({ status: 401, errorText: 'invalid token' })).toBe('auth');
    expect(classifySiteHealthFailure({ status: 429, errorText: 'rate limited' })).toBe('rate_limit_429');
    expect(classifySiteHealthFailure({ status: 503, errorText: 'bad gateway' })).toBe('upstream_5xx');
    expect(classifySiteHealthFailure({ errorText: 'cloudflare managed challenge required' })).toBe('challenge');
    expect(classifySiteHealthFailure({ errorText: 'upstream returned empty content' })).toBe('empty');
    expect(classifySiteHealthFailure({ errorText: 'Timeout after 15000ms' })).toBe('timeout');
  });

  it('applies configured penalty multipliers', () => {
    expect(resolveSiteHealthPenaltyMultiplier('other')).toBe(1);
    expect(resolveSiteHealthPenaltyMultiplier('upstream_5xx')).toBe(1.5);
    expect(resolveSiteHealthPenaltyMultiplier('auth')).toBe(2);
    expect(resolveSiteHealthPenaltyMultiplier('auth', {
      severeFailureMultiplier: 1.8,
      authFailureMultiplier: 2.4,
    })).toBe(2.4);
  });

  it('derives quarantined while breaker is open', () => {
    expect(deriveSiteHealthState({
      runtime: {
        breakerOpen: true,
        penaltyScore: 0.3,
      },
    })).toBe('quarantined');
  });

  it('derives penalized when cooldowns or penalty are still active', () => {
    expect(deriveSiteHealthState({
      runtime: {
        penaltyScore: 0.8,
      },
    })).toBe('penalized');

    expect(deriveSiteHealthState({
      runtime: {
        penaltyScore: 0.1,
      },
      cooldown: {
        activeChannelCooldownCount: 2,
      },
    })).toBe('penalized');
  });

  it('derives recovering after a newer success follows failures', () => {
    expect(deriveSiteHealthState({
      runtime: {
        penaltyScore: 0.2,
        lastFailureAtMs: 1_000,
        lastSuccessAtMs: 2_000,
        recentSuccessStreak: 1,
      },
      nowMs: 2_000,
    })).toBe('recovering');
  });

  it('derives probe policy from site status and probeDisabled', () => {
    expect(deriveSiteProbePolicy({ siteStatus: 'disabled', probeDisabled: false })).toBe('forbid_batch_probe');
    expect(deriveSiteProbePolicy({ siteStatus: 'active', probeDisabled: true })).toBe('manual_only');
    expect(deriveSiteProbePolicy({ siteStatus: 'active', probeDisabled: false })).toBe('allow_recovery_probe');
  });
});

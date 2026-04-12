import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { pickRandomProbePrompt } from '../../shared/probePrompts.js';
import { probeModels } from './modelProbeService.js';
import { getDispatcherForProxyUrl, resolveChannelProxyUrl } from './siteProxy.js';
import { tokenRouter } from './tokenRouter.js';
import { resolveChannelProbeModelName, resolveChannelProbeTokenValue } from './channelProbeService.js';

const CHANNEL_RECOVERY_PROBE_MAX_PER_SWEEP = 2;
const CHANNEL_RECOVERY_PROBE_TIMEOUT_MS = 15_000;
const CHANNEL_RECOVERY_PROBE_MIN_INTERVAL_MS = 5 * 60 * 1000;

type RecoveryProbeCandidate = {
  channelId: number;
  siteId: number;
  siteUrl: string;
  modelName: string;
  apiToken: string;
  extraConfig: string | null;
  site: typeof schema.sites.$inferSelect;
  cooldownUntil: string;
};

let recoveryTimer: ReturnType<typeof setInterval> | null = null;
let recoverySweepRunning = false;
const channelLastProbeAtMs = new Map<number, number>();
const siteProbeHistoryByHour = new Map<number, number[]>();

function pruneSiteProbeHistory(siteId: number, nowMs = Date.now()): number[] {
  const next = (siteProbeHistoryByHour.get(siteId) ?? []).filter((timestamp) => (nowMs - timestamp) < 60 * 60 * 1000);
  if (next.length > 0) {
    siteProbeHistoryByHour.set(siteId, next);
  } else {
    siteProbeHistoryByHour.delete(siteId);
  }
  return next;
}

function canProbeSite(siteId: number, nowMs = Date.now()): boolean {
  return pruneSiteProbeHistory(siteId, nowMs).length < config.channelRecoveryProbeMaxPerSitePerHour;
}

function markProbeAttempt(channelId: number, siteId: number, nowMs = Date.now()): void {
  channelLastProbeAtMs.set(channelId, nowMs);
  const next = pruneSiteProbeHistory(siteId, nowMs);
  next.push(nowMs);
  siteProbeHistoryByHour.set(siteId, next);
}

function shouldRetryChannel(channelId: number, nowMs = Date.now()): boolean {
  const lastProbeAtMs = channelLastProbeAtMs.get(channelId) ?? 0;
  return (nowMs - lastProbeAtMs) >= CHANNEL_RECOVERY_PROBE_MIN_INTERVAL_MS;
}

async function loadCoolingChannelCandidates(nowMs = Date.now()): Promise<RecoveryProbeCandidate[]> {
  const rows = await db.select()
    .from(schema.routeChannels)
    .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .innerJoin(schema.tokenRoutes, eq(schema.routeChannels.routeId, schema.tokenRoutes.id))
    .leftJoin(schema.accountTokens, eq(schema.routeChannels.tokenId, schema.accountTokens.id))
    .all();

  return rows
    .filter((row: any) => row.route_channels.enabled !== false)
    .filter((row: any) => row.accounts.status === 'active')
    .filter((row: any) => row.sites.status === 'active')
    .filter((row: any) => !row.sites.probeDisabled)
    .filter((row: any) => typeof row.route_channels.cooldownUntil === 'string' && row.route_channels.cooldownUntil > new Date(nowMs).toISOString())
    .map((row: any) => {
      const apiToken = resolveChannelProbeTokenValue({
        channel: row.route_channels,
        account: row.accounts,
        token: row.account_tokens,
      });
      const modelName = resolveChannelProbeModelName({
        channel: row.route_channels,
        route: row.token_routes,
      });
      return {
        channelId: row.route_channels.id,
        siteId: row.sites.id,
        siteUrl: row.sites.url,
        modelName: modelName || '',
        apiToken: apiToken || '',
        extraConfig: row.accounts.extraConfig,
        site: row.sites,
        cooldownUntil: row.route_channels.cooldownUntil || '',
      } satisfies RecoveryProbeCandidate;
    })
    .filter((row: any) => row.siteUrl.trim().length > 0)
    .filter((row: any) => row.modelName.trim().length > 0)
    .filter((row: any) => row.apiToken.trim().length > 0)
    .sort((left: any, right: any) => left.cooldownUntil.localeCompare(right.cooldownUntil));
}

export async function runChannelRecoveryProbeSweep(nowMs = Date.now()): Promise<{
  enabled: boolean;
  scanned: number;
  recovered: number;
  skippedByRateLimit: number;
}> {
  if (!config.channelRecoveryProbeEnabled) {
    return {
      enabled: false,
      scanned: 0,
      recovered: 0,
      skippedByRateLimit: 0,
    };
  }

  const candidates = await loadCoolingChannelCandidates(nowMs);
  let scanned = 0;
  let recovered = 0;
  let skippedByRateLimit = 0;

  for (const candidate of candidates) {
    if (scanned >= CHANNEL_RECOVERY_PROBE_MAX_PER_SWEEP) break;
    if (!shouldRetryChannel(candidate.channelId, nowMs)) continue;
    if (!canProbeSite(candidate.siteId, nowMs)) {
      skippedByRateLimit += 1;
      continue;
    }

    markProbeAttempt(candidate.channelId, candidate.siteId, nowMs);
    const proxyUrl = resolveChannelProxyUrl(candidate.site, candidate.extraConfig);
    const dispatcher = proxyUrl ? getDispatcherForProxyUrl(proxyUrl) : undefined;
    const [result] = await probeModels({
      siteUrl: candidate.siteUrl,
      apiToken: candidate.apiToken,
      modelNames: [candidate.modelName],
      prompt: pickRandomProbePrompt(),
      concurrency: 1,
      timeoutMs: CHANNEL_RECOVERY_PROBE_TIMEOUT_MS,
      delayMs: 0,
      dispatcher,
    });
    scanned += 1;

    if (result?.status === 'supported') {
      await tokenRouter.recordProbeSuccess(candidate.channelId, candidate.modelName);
      recovered += 1;
    }
  }

  return {
    enabled: true,
    scanned,
    recovered,
    skippedByRateLimit,
  };
}

export function startChannelRecoveryProbeService(): void {
  if (recoveryTimer || !config.channelRecoveryProbeEnabled) return;

  const intervalMs = Math.max(10_000, Math.trunc(config.channelRecoveryProbeIntervalMs || 0));
  const runOnce = async () => {
    if (recoverySweepRunning || !config.channelRecoveryProbeEnabled) return;
    recoverySweepRunning = true;
    try {
      const result = await runChannelRecoveryProbeSweep();
      if (result.recovered > 0 || result.scanned > 0) {
        console.info(
          `[channel-recovery-probe] scanned=${result.scanned} recovered=${result.recovered} skippedByRateLimit=${result.skippedByRateLimit}`,
        );
      }
    } catch (error) {
      console.warn('[channel-recovery-probe] sweep failed', error);
    } finally {
      recoverySweepRunning = false;
    }
  };

  void runOnce();
  recoveryTimer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  recoveryTimer.unref?.();
}

export function stopChannelRecoveryProbeService(): void {
  if (!recoveryTimer) return;
  clearInterval(recoveryTimer);
  recoveryTimer = null;
}

export function resetChannelRecoveryProbeServiceState(): void {
  stopChannelRecoveryProbeService();
  recoverySweepRunning = false;
  channelLastProbeAtMs.clear();
  siteProbeHistoryByHour.clear();
}

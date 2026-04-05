import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  classifySiteHealthFailureKind,
  getSiteRuntimeHealthSnapshots,
  type SiteHealthFailureKind,
} from './tokenRouter.js';

export type SiteHealthDerivedState = 'active' | 'penalized' | 'quarantined' | 'recovering';
export type SiteHealthProbePolicy = 'forbid_batch_probe' | 'manual_only' | 'allow_recovery_probe';

export type SiteHealthFailureSummary = {
  kind: SiteHealthFailureKind | null;
  message: string | null;
  httpStatus: number | null;
  occurredAt: string | null;
};

export type SiteHealthCooldownSummary = {
  activeChannelCooldownCount: number;
  affectedRouteCount: number;
  earliestCooldownUntil: string | null;
  latestCooldownUntil: string | null;
};

export type SiteHealthStateRow = {
  siteId: number;
  siteName: string;
  siteUrl: string | null;
  platform: string | null;
  siteStatus: string;
  state: SiteHealthDerivedState;
  probePolicy: SiteHealthProbePolicy;
  breakerOpen: boolean;
  penaltyScore: number;
  latencyEmaMs: number | null;
  cooldownSummary: SiteHealthCooldownSummary;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  recentFailureSummary: SiteHealthFailureSummary | null;
  activeModelCount: number;
  unhealthyModelCount: number;
  recentFailureCount: number;
  severeFailureCount: number;
  isPinned: boolean;
  sortOrder: number;
};

type SiteHealthStateInput = {
  runtime?: {
    breakerOpen?: boolean;
    penaltyScore?: number;
    lastFailureAtMs?: number | null;
    lastSuccessAtMs?: number | null;
    recentSuccessStreak?: number;
  };
  cooldown?: {
    activeChannelCooldownCount?: number;
  };
  recentFailures?: {
    topFailureType?: SiteHealthFailureKind | null;
    totalRecentFailures?: number;
    severeFailureCount?: number;
    latestFailureAtMs?: number | null;
  };
  nowMs?: number;
};

type SiteRuntimeAggregate = {
  breakerOpen: boolean;
  penaltyScore: number;
  latencySamples: number[];
  lastFailureAtMs: number | null;
  lastSuccessAtMs: number | null;
  activeModelCount: number;
  unhealthyModelCount: number;
  recentSuccessStreak: number;
};

type SiteRecentFailureAggregate = {
  totalRecentFailures: number;
  severeFailureCount: number;
  latestFailureAtMs: number | null;
  topFailureType: SiteHealthFailureKind | null;
  latestSummary: SiteHealthFailureSummary | null;
};

const SITE_HEALTH_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const SITE_HEALTH_RECOVERING_WINDOW_MS = 45 * 60 * 1000;
const SITE_HEALTH_PENALIZED_PENALTY_THRESHOLD = 0.75;
const SITE_HEALTH_QUARANTINED_PENALTY_THRESHOLD = 2.5;

function toIsoOrNull(timestampMs: number | null | undefined): string | null {
  if (!timestampMs || !Number.isFinite(timestampMs) || timestampMs <= 0) return null;
  return new Date(timestampMs).toISOString();
}

function compareIsoAsc(left: string | null, right: string | null): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return left.localeCompare(right);
}

function rankState(state: SiteHealthDerivedState): number {
  if (state === 'quarantined') return 0;
  if (state === 'penalized') return 1;
  if (state === 'recovering') return 2;
  return 3;
}

function isSevereFailure(kind: SiteHealthFailureKind | null | undefined): boolean {
  return kind === 'challenge'
    || kind === 'empty'
    || kind === 'upstream_5xx'
    || kind === 'quota_exhausted'
    || kind === 'auth';
}

function buildEmptyRuntimeAggregate(): SiteRuntimeAggregate {
  return {
    breakerOpen: false,
    penaltyScore: 0,
    latencySamples: [],
    lastFailureAtMs: null,
    lastSuccessAtMs: null,
    activeModelCount: 0,
    unhealthyModelCount: 0,
    recentSuccessStreak: 0,
  };
}

function buildEmptyRecentFailureAggregate(): SiteRecentFailureAggregate {
  return {
    totalRecentFailures: 0,
    severeFailureCount: 0,
    latestFailureAtMs: null,
    topFailureType: null,
    latestSummary: null,
  };
}

function buildEmptyCooldownSummary(): SiteHealthCooldownSummary {
  return {
    activeChannelCooldownCount: 0,
    affectedRouteCount: 0,
    earliestCooldownUntil: null,
    latestCooldownUntil: null,
  };
}

export function classifySiteHealthFailure(input: {
  status?: number | null;
  errorText?: string | null;
  failureKind?: SiteHealthFailureKind | null;
} = {}): SiteHealthFailureKind {
  const classified = classifySiteHealthFailureKind(input);
  if (classified !== 'other') return classified;
  const errorText = (input.errorText || '').trim();
  if (/\btimeout\b/i.test(errorText) || /timed?\s*out/i.test(errorText) || /time-?out/i.test(errorText)) {
    return 'timeout';
  }
  return classified;
}

export function resolveSiteHealthPenaltyMultiplier(
  kind: SiteHealthFailureKind,
  options: {
    severeFailureMultiplier?: number;
    authFailureMultiplier?: number;
  } = {},
): number {
  const severeFailureMultiplier = Number.isFinite(options.severeFailureMultiplier)
    ? Math.max(1, Number(options.severeFailureMultiplier))
    : 1.5;
  const authFailureMultiplier = Number.isFinite(options.authFailureMultiplier)
    ? Math.max(1, Number(options.authFailureMultiplier))
    : 2;

  if (kind === 'auth' || kind === 'quota_exhausted') {
    return authFailureMultiplier;
  }
  if (kind === 'challenge' || kind === 'empty' || kind === 'upstream_5xx') {
    return severeFailureMultiplier;
  }
  return 1;
}

export function deriveSiteProbePolicy(input: {
  siteStatus?: string | null;
  probeDisabled?: boolean | null;
}): SiteHealthProbePolicy {
  if ((input.siteStatus || '').trim().toLowerCase() === 'disabled') {
    return 'forbid_batch_probe';
  }
  if (input.probeDisabled) {
    return 'manual_only';
  }
  return 'allow_recovery_probe';
}

export function deriveSiteHealthState(input: SiteHealthStateInput): SiteHealthDerivedState {
  const nowMs = input.nowMs ?? Date.now();
  const breakerOpen = !!input.runtime?.breakerOpen;
  const penaltyScore = Math.max(0, Number(input.runtime?.penaltyScore || 0));
  const lastFailureAtMs = input.runtime?.lastFailureAtMs ?? input.recentFailures?.latestFailureAtMs ?? null;
  const lastSuccessAtMs = input.runtime?.lastSuccessAtMs ?? null;
  const recentSuccessStreak = Math.max(0, Math.trunc(input.runtime?.recentSuccessStreak || 0));
  const activeChannelCooldownCount = Math.max(0, Math.trunc(input.cooldown?.activeChannelCooldownCount || 0));
  const severeFailureCount = Math.max(0, Math.trunc(input.recentFailures?.severeFailureCount || 0));
  const totalRecentFailures = Math.max(0, Math.trunc(input.recentFailures?.totalRecentFailures || 0));
  const topFailureType = input.recentFailures?.topFailureType ?? null;
  const recoveredRecently = (
    !!lastSuccessAtMs
    && !!lastFailureAtMs
    && lastSuccessAtMs > lastFailureAtMs
    && (nowMs - lastSuccessAtMs) <= SITE_HEALTH_RECOVERING_WINDOW_MS
    && (recentSuccessStreak > 0 || penaltyScore > 0)
  );

  if (
    breakerOpen
    || (
      severeFailureCount > 0
      && !recoveredRecently
      && lastFailureAtMs != null
      && (
        topFailureType === 'challenge'
        || topFailureType === 'auth'
        || topFailureType === 'quota_exhausted'
        || penaltyScore >= 1.2
      )
    )
    || (
      penaltyScore >= SITE_HEALTH_QUARANTINED_PENALTY_THRESHOLD
      && (lastFailureAtMs ?? 0) >= (lastSuccessAtMs ?? 0)
    )
  ) {
    return 'quarantined';
  }

  if (
    recoveredRecently
    && recentSuccessStreak > 0
    && (penaltyScore > 0.15 || activeChannelCooldownCount > 0)
  ) {
    return 'recovering';
  }

  if (activeChannelCooldownCount > 0 || penaltyScore >= SITE_HEALTH_PENALIZED_PENALTY_THRESHOLD || severeFailureCount > 0 || totalRecentFailures > 1) {
    return 'penalized';
  }

  return 'active';
}

export async function listSiteHealthStates(nowMs = Date.now()): Promise<SiteHealthStateRow[]> {
  const sites = await db.select({
    id: schema.sites.id,
    name: schema.sites.name,
    url: schema.sites.url,
    platform: schema.sites.platform,
    status: schema.sites.status,
    probeDisabled: schema.sites.probeDisabled,
    isPinned: schema.sites.isPinned,
    sortOrder: schema.sites.sortOrder,
  }).from(schema.sites)
    .where(eq(schema.sites.status, 'active'))
    .all();

  if (sites.length === 0) return [];

  const siteIds = sites.map((site) => site.id);
  const runtimeSnapshots = await getSiteRuntimeHealthSnapshots(nowMs);
  const runtimeBySiteId = new Map<number, SiteRuntimeAggregate>();

  for (const snapshot of runtimeSnapshots) {
    if (!siteIds.includes(snapshot.siteId)) continue;
    const aggregate = runtimeBySiteId.get(snapshot.siteId) || buildEmptyRuntimeAggregate();
    aggregate.breakerOpen = aggregate.breakerOpen || snapshot.breakerOpen;
    aggregate.penaltyScore = Math.max(aggregate.penaltyScore, snapshot.penaltyScore);
    aggregate.recentSuccessStreak = Math.max(aggregate.recentSuccessStreak, snapshot.recentSuccessStreak);
    if (snapshot.latencyEmaMs != null && Number.isFinite(snapshot.latencyEmaMs)) {
      aggregate.latencySamples.push(snapshot.latencyEmaMs);
    }
    if (snapshot.lastFailureAtMs != null) {
      aggregate.lastFailureAtMs = Math.max(aggregate.lastFailureAtMs ?? 0, snapshot.lastFailureAtMs);
    }
    if (snapshot.lastSuccessAtMs != null) {
      aggregate.lastSuccessAtMs = Math.max(aggregate.lastSuccessAtMs ?? 0, snapshot.lastSuccessAtMs);
    }
    aggregate.activeModelCount += 1;
    if (snapshot.breakerOpen || snapshot.penaltyScore >= SITE_HEALTH_PENALIZED_PENALTY_THRESHOLD) {
      aggregate.unhealthyModelCount += 1;
    }
    runtimeBySiteId.set(snapshot.siteId, aggregate);
  }

  const recentFailureSince = new Date(nowMs - SITE_HEALTH_LOOKBACK_MS).toISOString();
  const failureRows = await db.select({
    siteId: schema.sites.id,
    errorMessage: schema.proxyLogs.errorMessage,
    httpStatus: schema.proxyLogs.httpStatus,
    createdAt: schema.proxyLogs.createdAt,
  }).from(schema.proxyLogs)
    .innerJoin(schema.accounts, eq(schema.proxyLogs.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(and(
      inArray(schema.sites.id, siteIds),
      gte(schema.proxyLogs.createdAt, recentFailureSince),
      sql<boolean>`coalesce(${schema.proxyLogs.status}, '') <> 'success'`,
    ))
    .orderBy(desc(schema.proxyLogs.createdAt))
    .all();

  const recentFailuresBySiteId = new Map<number, SiteRecentFailureAggregate>();
  for (const row of failureRows) {
    const aggregate = recentFailuresBySiteId.get(row.siteId) || buildEmptyRecentFailureAggregate();
    const kind = classifySiteHealthFailure({
      status: row.httpStatus,
      errorText: row.errorMessage,
    });
    aggregate.totalRecentFailures += 1;
    if (isSevereFailure(kind)) {
      aggregate.severeFailureCount += 1;
    }
    if (!aggregate.topFailureType) {
      aggregate.topFailureType = kind;
    }
    if (!aggregate.latestSummary) {
      aggregate.latestSummary = {
        kind,
        message: (row.errorMessage || '').trim().slice(0, 200) || null,
        httpStatus: row.httpStatus ?? null,
        occurredAt: row.createdAt || null,
      };
    }
    if (row.createdAt) {
      const createdAtMs = Date.parse(row.createdAt);
      if (Number.isFinite(createdAtMs)) {
        aggregate.latestFailureAtMs = Math.max(aggregate.latestFailureAtMs ?? 0, createdAtMs);
      }
    }
    recentFailuresBySiteId.set(row.siteId, aggregate);
  }

  const nowIso = new Date(nowMs).toISOString();
  const cooldownRows = await db.select({
    siteId: schema.accounts.siteId,
    routeId: schema.routeChannels.routeId,
    cooldownUntil: schema.routeChannels.cooldownUntil,
  }).from(schema.routeChannels)
    .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
    .where(and(
      inArray(schema.accounts.siteId, siteIds),
      eq(schema.routeChannels.enabled, true),
      sql<boolean>`${schema.routeChannels.cooldownUntil} is not null and ${schema.routeChannels.cooldownUntil} > ${nowIso}`,
    ))
    .all();

  const cooldownBySiteId = new Map<number, SiteHealthCooldownSummary>();
  for (const row of cooldownRows) {
    const current = cooldownBySiteId.get(row.siteId) || buildEmptyCooldownSummary();
    current.activeChannelCooldownCount += 1;
    current.earliestCooldownUntil = compareIsoAsc(row.cooldownUntil ?? null, current.earliestCooldownUntil) < 0
      ? row.cooldownUntil ?? null
      : current.earliestCooldownUntil;
    current.latestCooldownUntil = compareIsoAsc(current.latestCooldownUntil, row.cooldownUntil ?? null) < 0
      ? row.cooldownUntil ?? null
      : current.latestCooldownUntil;
    const routeIds = (current as SiteHealthCooldownSummary & { __routeIds?: Set<number> }).__routeIds || new Set<number>();
    routeIds.add(row.routeId);
    (current as SiteHealthCooldownSummary & { __routeIds?: Set<number> }).__routeIds = routeIds;
    current.affectedRouteCount = routeIds.size;
    cooldownBySiteId.set(row.siteId, current);
  }

  return sites
    .map((site) => {
      const runtime = runtimeBySiteId.get(site.id) || buildEmptyRuntimeAggregate();
      const recentFailures = recentFailuresBySiteId.get(site.id) || buildEmptyRecentFailureAggregate();
      const cooldown = cooldownBySiteId.get(site.id) || buildEmptyCooldownSummary();
      const state = deriveSiteHealthState({
        runtime: {
          breakerOpen: runtime.breakerOpen,
          penaltyScore: runtime.penaltyScore,
          lastFailureAtMs: runtime.lastFailureAtMs,
          lastSuccessAtMs: runtime.lastSuccessAtMs,
          recentSuccessStreak: runtime.recentSuccessStreak,
        },
        cooldown,
        recentFailures,
        nowMs,
      });
      const latencyEmaMs = runtime.latencySamples.length > 0
        ? Math.round(runtime.latencySamples.reduce((sum, value) => sum + value, 0) / runtime.latencySamples.length)
        : null;

      return {
        siteId: site.id,
        siteName: site.name,
        siteUrl: site.url,
        platform: site.platform,
        siteStatus: site.status,
        state,
        probePolicy: deriveSiteProbePolicy({
          siteStatus: site.status,
          probeDisabled: site.probeDisabled,
        }),
        breakerOpen: runtime.breakerOpen,
        penaltyScore: Number(runtime.penaltyScore.toFixed(3)),
        latencyEmaMs,
        cooldownSummary: cooldown,
        lastSuccessAt: toIsoOrNull(runtime.lastSuccessAtMs),
        lastFailureAt: toIsoOrNull(Math.max(runtime.lastFailureAtMs ?? 0, recentFailures.latestFailureAtMs ?? 0) || null),
        recentFailureSummary: recentFailures.latestSummary,
        activeModelCount: runtime.activeModelCount,
        unhealthyModelCount: runtime.unhealthyModelCount,
        recentFailureCount: recentFailures.totalRecentFailures,
        severeFailureCount: recentFailures.severeFailureCount,
        isPinned: !!site.isPinned,
        sortOrder: Math.max(0, Number(site.sortOrder || 0)),
      } satisfies SiteHealthStateRow;
    })
    .sort((left, right) => {
      if (left.isPinned !== right.isPinned) return left.isPinned ? -1 : 1;
      const leftRank = rankState(left.state);
      const rightRank = rankState(right.state);
      if (leftRank !== rightRank) return leftRank - rightRank;
      if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
      if (left.penaltyScore !== right.penaltyScore) return right.penaltyScore - left.penaltyScore;
      return left.siteName.localeCompare(right.siteName, undefined, { sensitivity: 'base' });
    });
}

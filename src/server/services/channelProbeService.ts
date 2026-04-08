import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { pickRandomProbePrompt } from '../../shared/probePrompts.js';
import { probeModels, type ProbeResult } from './modelProbeService.js';
import { isUsableAccountToken } from './accountTokenService.js';
import { getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import { getDispatcherForProxyUrl, resolveChannelProxyUrl } from './siteProxy.js';

type ChannelProbeJoinedRow = {
  route_channels: typeof schema.routeChannels.$inferSelect;
  accounts: typeof schema.accounts.$inferSelect;
  sites: typeof schema.sites.$inferSelect;
  token_routes: typeof schema.tokenRoutes.$inferSelect;
  account_tokens: typeof schema.accountTokens.$inferSelect | null;
};

export type ChannelProbeCandidate = {
  channelId: number;
  routeId: number;
  priority: number;
  siteId: number;
  siteUrl: string;
  modelName: string;
  apiToken: string;
  extraConfig: string | null;
  site: typeof schema.sites.$inferSelect;
};

export type ChannelProbeEntry = {
  channelId: number;
  routeId: number;
  priority: number;
  candidate: ChannelProbeCandidate | null;
  skipReason: string | null;
};

const DEFAULT_CHANNEL_PROBE_TIMEOUT_MS = 30_000;

export function resolveChannelProbeTokenValue(row: {
  channel: typeof schema.routeChannels.$inferSelect;
  account: typeof schema.accounts.$inferSelect;
  token: typeof schema.accountTokens.$inferSelect | null;
}): string | null {
  if (row.channel.tokenId) {
    if (!row.token || !isUsableAccountToken(row.token)) return null;
    const tokenValue = row.token.token?.trim();
    return tokenValue || null;
  }

  if (getOauthInfoFromAccount(row.account)) {
    const accessToken = row.account.accessToken?.trim();
    return accessToken || null;
  }

  const apiToken = row.account.apiToken?.trim();
  return apiToken || null;
}

export function resolveChannelProbeModelName(row: {
  channel: typeof schema.routeChannels.$inferSelect;
  route: typeof schema.tokenRoutes.$inferSelect;
}): string | null {
  const sourceModel = row.channel.sourceModel?.trim();
  if (sourceModel) return sourceModel;
  const routeModel = row.route.modelPattern?.trim();
  return routeModel || null;
}

function buildChannelProbeEntry(row: ChannelProbeJoinedRow): ChannelProbeEntry {
  const siteUrl = row.sites.url?.trim() || '';
  const modelName = resolveChannelProbeModelName({
    channel: row.route_channels,
    route: row.token_routes,
  });
  const apiToken = resolveChannelProbeTokenValue({
    channel: row.route_channels,
    account: row.accounts,
    token: row.account_tokens,
  });

  let skipReason: string | null = null;
  if (!siteUrl) {
    skipReason = '站点缺少 URL';
  } else if (!modelName) {
    skipReason = '通道缺少可探活模型';
  } else if (!apiToken) {
    skipReason = '通道无有效探活令牌';
  }

  if (skipReason) {
    return {
      channelId: row.route_channels.id,
      routeId: row.route_channels.routeId,
      priority: row.route_channels.priority ?? 0,
      candidate: null,
      skipReason,
    };
  }

  return {
    channelId: row.route_channels.id,
    routeId: row.route_channels.routeId,
    priority: row.route_channels.priority ?? 0,
    candidate: {
      channelId: row.route_channels.id,
      routeId: row.route_channels.routeId,
      priority: row.route_channels.priority ?? 0,
      siteId: row.sites.id,
      siteUrl,
      modelName: modelName!,
      apiToken: apiToken!,
      extraConfig: row.accounts.extraConfig,
      site: row.sites,
    },
    skipReason: null,
  };
}

function toSkippedProbeResult(entry: ChannelProbeEntry): ProbeResult {
  return {
    modelName: entry.candidate?.modelName || '',
    status: 'skipped',
    ttftMs: null,
    httpStatus: null,
    error: entry.skipReason || 'Probe skipped',
    responseText: null,
  };
}

async function loadChannelProbeRows(where: { channelId?: number; routeId?: number; onlyEnabledChannels?: boolean }): Promise<ChannelProbeJoinedRow[]> {
  const channelId = typeof where.channelId === 'number' && where.channelId > 0 ? where.channelId : null;
  const routeId = typeof where.routeId === 'number' && where.routeId > 0 ? where.routeId : null;
  if (!channelId && !routeId) return [];

  const baseQuery = db.select()
    .from(schema.routeChannels)
    .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .innerJoin(schema.tokenRoutes, eq(schema.routeChannels.routeId, schema.tokenRoutes.id))
    .leftJoin(schema.accountTokens, eq(schema.routeChannels.tokenId, schema.accountTokens.id));
  const rows = channelId
    ? await baseQuery.where(eq(schema.routeChannels.id, channelId)).all()
    : await baseQuery.where(eq(schema.routeChannels.routeId, routeId!)).all();

  return rows.filter((row) => !where.onlyEnabledChannels || row.route_channels.enabled !== false);
}

export async function loadChannelProbeEntry(channelId: number): Promise<ChannelProbeEntry | null> {
  const row = (await loadChannelProbeRows({ channelId }))[0];
  if (!row) return null;
  return buildChannelProbeEntry(row);
}

export async function loadChannelProbeCandidate(channelId: number): Promise<ChannelProbeCandidate | null> {
  return (await loadChannelProbeEntry(channelId))?.candidate ?? null;
}

export async function loadRouteChannelProbeEntries(routeId: number): Promise<ChannelProbeEntry[]> {
  const rows = await loadChannelProbeRows({ routeId, onlyEnabledChannels: true });
  return rows
    .map((row) => buildChannelProbeEntry(row))
    .sort((left, right) => {
      if (left.priority === right.priority) return left.channelId - right.channelId;
      return left.priority - right.priority;
    });
}

export async function loadRouteChannelProbeCandidates(routeId: number): Promise<ChannelProbeCandidate[]> {
  const entries = await loadRouteChannelProbeEntries(routeId);
  return entries.flatMap((entry) => entry.candidate ? [entry.candidate] : []);
}

export async function probeChannelEntry(
  entry: ChannelProbeEntry,
  options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<ProbeResult> {
  if (!entry.candidate) {
    return toSkippedProbeResult(entry);
  }

  const proxyUrl = resolveChannelProxyUrl(entry.candidate.site, entry.candidate.extraConfig);
  const dispatcher = proxyUrl ? getDispatcherForProxyUrl(proxyUrl) : undefined;
  const [result] = await probeModels({
    siteUrl: entry.candidate.siteUrl,
    apiToken: entry.candidate.apiToken,
    modelNames: [entry.candidate.modelName],
    prompt: pickRandomProbePrompt(),
    concurrency: 1,
    timeoutMs: options?.timeoutMs ?? DEFAULT_CHANNEL_PROBE_TIMEOUT_MS,
    delayMs: 0,
    signal: options?.signal,
    dispatcher,
  });
  return result ?? {
    modelName: entry.candidate.modelName,
    status: 'inconclusive',
    ttftMs: null,
    httpStatus: null,
    error: 'Probe returned no result',
    responseText: null,
  };
}

export async function probeRouteChannelEntries(
  entries: ChannelProbeEntry[],
  options?: {
    concurrency?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
    onResult?: (event: { channelId: number; result: ProbeResult }) => Promise<void> | void;
  },
): Promise<Array<{ channelId: number; result: ProbeResult }>> {
  const concurrency = Math.max(1, Math.min(10, Math.trunc(options?.concurrency || 5)));
  const queue = [...entries];
  const results: Array<{ channelId: number; result: ProbeResult }> = [];

  const worker = async () => {
    for (;;) {
      if (options?.signal?.aborted) return;
      const next = queue.shift();
      if (!next) return;
      const result = await probeChannelEntry(next, {
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      });
      const event = { channelId: next.channelId, result };
      results.push(event);
      await options?.onResult?.(event);
      if (options?.signal?.aborted) return;
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, () => worker()));
  return results;
}

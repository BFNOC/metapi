import { FastifyInstance } from 'fastify';
import { db, schema } from '../../db/index.js';
import { and, desc, gte, eq, lt } from 'drizzle-orm';
import {
  refreshModelsForAccount,
  refreshModelsAndRebuildRoutes,
  rebuildTokenRoutesFromAvailability,
} from '../../services/modelService.js';
import { buildModelAnalysis } from '../../services/modelAnalysisService.js';
import { fallbackTokenCost, fetchModelPricingCatalog } from '../../services/modelPricingService.js';
import { getUpstreamModelDescriptionsCached } from '../../services/upstreamModelDescriptionService.js';
import { getRunningTaskByDedupeKey, startBackgroundTask } from '../../services/backgroundTaskService.js';
import { parseCheckinRewardAmount } from '../../services/checkinRewardParser.js';
import { estimateRewardWithTodayIncomeFallback } from '../../services/todayIncomeRewardService.js';
import {
  getLocalDayRangeUtc,
  getLocalRangeStartUtc,
  parseStoredUtcDateTime,
  toLocalDayKeyFromStoredUtc,
} from '../../services/localTimeService.js';

function parseBooleanFlag(raw?: string): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

const MODELS_MARKETPLACE_BASE_TTL_MS = 15_000;
const MODELS_MARKETPLACE_PRICING_TTL_MS = 90_000;

type ModelsMarketplaceCacheEntry = {
  expiresAt: number;
  models: any[];
};

const modelsMarketplaceCache = new Map<'base' | 'pricing', ModelsMarketplaceCacheEntry>();

function readModelsMarketplaceCache(includePricing: boolean): any[] | null {
  const key = includePricing ? 'pricing' : 'base';
  const cached = modelsMarketplaceCache.get(key);
  if (!cached) return null;
  if (Date.now() >= cached.expiresAt) {
    modelsMarketplaceCache.delete(key);
    return null;
  }
  return cached.models;
}

function writeModelsMarketplaceCache(includePricing: boolean, models: any[]): void {
  const ttl = includePricing ? MODELS_MARKETPLACE_PRICING_TTL_MS : MODELS_MARKETPLACE_BASE_TTL_MS;
  const key = includePricing ? 'pricing' : 'base';
  modelsMarketplaceCache.set(key, {
    expiresAt: Date.now() + ttl,
    models,
  });
}

export async function statsRoutes(app: FastifyInstance) {
  // Dashboard summary
  app.get('/api/stats/dashboard', async () => {
    const accountRows = db.select().from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(eq(schema.sites.status, 'active'))
      .all();
    const accounts = accountRows.map((row) => row.accounts);
    const totalBalance = accounts.reduce((sum, a) => sum + (a.balance || 0), 0);
    const activeCount = accounts.filter((a) => a.status === 'active').length;

    const { localDay: today, startUtc: todayStartUtc, endUtc: todayEndUtc } = getLocalDayRangeUtc();
    const todayCheckinRows = db.select().from(schema.checkinLogs)
      .innerJoin(schema.accounts, eq(schema.checkinLogs.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(and(
        gte(schema.checkinLogs.createdAt, todayStartUtc),
        lt(schema.checkinLogs.createdAt, todayEndUtc),
        eq(schema.sites.status, 'active'),
      ))
      .all();
    const todayCheckins = todayCheckinRows.map((row) => row.checkin_logs);
    const checkinFailed = todayCheckins.filter((c) => c.status === 'failed').length;
    const checkinSuccess = todayCheckins.length - checkinFailed;
    const rewardByAccount: Record<number, number> = {};
    const successCountByAccount: Record<number, number> = {};
    const parsedRewardCountByAccount: Record<number, number> = {};
    for (const row of todayCheckinRows) {
      const checkin = row.checkin_logs;
      if (checkin.status !== 'success') continue;
      const accountId = row.accounts.id;
      successCountByAccount[accountId] = (successCountByAccount[accountId] || 0) + 1;
      const rewardValue = parseCheckinRewardAmount(checkin.reward) || parseCheckinRewardAmount(checkin.message);
      if (rewardValue <= 0) continue;
      rewardByAccount[accountId] = (rewardByAccount[accountId] || 0) + rewardValue;
      parsedRewardCountByAccount[accountId] = (parsedRewardCountByAccount[accountId] || 0) + 1;
    }

    const nowTs = Date.now();
    const last24hTs = nowTs - 86400000;
    const last7dDate = getLocalRangeStartUtc(7);
    const recentProxyLogs = db.select().from(schema.proxyLogs)
      .leftJoin(schema.accounts, eq(schema.proxyLogs.accountId, schema.accounts.id))
      .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(and(gte(schema.proxyLogs.createdAt, last7dDate), eq(schema.sites.status, 'active')))
      .all()
      .map((row) => row.proxy_logs);
    const allProxyLogs = db.select()
      .from(schema.proxyLogs)
      .leftJoin(schema.accounts, eq(schema.proxyLogs.accountId, schema.accounts.id))
      .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(eq(schema.sites.status, 'active'))
      .all();

    const proxy24hLogs = recentProxyLogs.filter((log) => {
      if (!log.createdAt) return false;
      const ts = parseStoredUtcDateTime(log.createdAt)?.getTime() ?? Number.NaN;
      return Number.isFinite(ts) && ts >= last24hTs;
    });
    const proxySuccess = proxy24hLogs.filter((l) => l.status === 'success').length;
    const proxyFailed = proxy24hLogs.filter((l) => l.status === 'failed').length;
    const totalTokens = proxy24hLogs.reduce((sum, l) => sum + (l.totalTokens || 0), 0);
    const totalUsed = allProxyLogs.reduce((sum, row) => {
      const log = row.proxy_logs;
      const platform = row.sites?.platform || 'new-api';
      const explicitCost = typeof log.estimatedCost === 'number' ? log.estimatedCost : 0;
      if (explicitCost > 0) return sum + explicitCost;
      return sum + fallbackTokenCost(log.totalTokens || 0, platform);
    }, 0);
    const todayProxyLogs = recentProxyLogs.filter((log) => {
      if (!log.createdAt) return false;
      return log.createdAt >= todayStartUtc && log.createdAt < todayEndUtc;
    });
    const todaySpend = todayProxyLogs.reduce((sum, log) => {
      const cost = typeof log.estimatedCost === 'number' ? log.estimatedCost : 0;
      return sum + cost;
    }, 0);
    const todayReward = accounts.reduce((sum, account) => sum + estimateRewardWithTodayIncomeFallback({
      day: today,
      successCount: successCountByAccount[account.id] || 0,
      parsedRewardCount: parsedRewardCountByAccount[account.id] || 0,
      rewardSum: rewardByAccount[account.id] || 0,
      extraConfig: account.extraConfig,
    }), 0);
    const modelAnalysis = buildModelAnalysis(recentProxyLogs, { days: 7 });

    return {
      totalBalance,
      totalUsed: Math.round(totalUsed * 1_000_000) / 1_000_000,
      todaySpend: Math.round(todaySpend * 1_000_000) / 1_000_000,
      todayReward: Math.round(todayReward * 1_000_000) / 1_000_000,
      activeAccounts: activeCount,
      totalAccounts: accounts.length,
      todayCheckin: { success: checkinSuccess, failed: checkinFailed, total: todayCheckins.length },
      proxy24h: { success: proxySuccess, failed: proxyFailed, total: proxy24hLogs.length, totalTokens },
      modelAnalysis,
    };
  });

  // Proxy logs
  app.get<{ Querystring: { limit?: string; offset?: string } }>('/api/stats/proxy-logs', async (request) => {
    const limit = parseInt(request.query.limit || '50', 10);
    const offset = parseInt(request.query.offset || '0', 10);
    const rows = db.select().from(schema.proxyLogs)
      .leftJoin(schema.accounts, eq(schema.proxyLogs.accountId, schema.accounts.id))
      .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .orderBy(desc(schema.proxyLogs.createdAt))
      .limit(limit).offset(offset).all();

    return rows.map((row) => ({
      ...row.proxy_logs,
      username: row.accounts?.username || null,
      siteName: row.sites?.name || null,
      siteUrl: row.sites?.url || null,
    }));
  });

  // Models marketplace - refresh upstream models and aggregate.
  app.get<{ Querystring: { refresh?: string; includePricing?: string } }>('/api/models/marketplace', async (request) => {
    const refreshRequested = parseBooleanFlag(request.query.refresh);
    const includePricing = parseBooleanFlag(request.query.includePricing);

    let refreshQueued = false;
    let refreshReused = false;
    let refreshJobId: string | null = null;

    if (refreshRequested) {
      modelsMarketplaceCache.clear();
      const { task, reused } = startBackgroundTask(
        {
          type: 'model',
          title: '刷新模型广场数据',
          dedupeKey: 'refresh-models-and-rebuild-routes',
          notifyOnFailure: true,
          successMessage: (currentTask) => {
            const rebuild = (currentTask.result as any)?.rebuild;
            if (!rebuild) return '模型广场刷新已完成';
            return `模型广场刷新完成：新增路由 ${rebuild.createdRoutes}，移除旧路由 ${rebuild.removedRoutes ?? 0}，新增通道 ${rebuild.createdChannels}，移除通道 ${rebuild.removedChannels}`;
          },
          failureMessage: (currentTask) => `模型广场刷新失败：${currentTask.error || 'unknown error'}`,
        },
        async () => refreshModelsAndRebuildRoutes(),
      );
      refreshQueued = !reused;
      refreshReused = reused;
      refreshJobId = task.id;
    }
    const runningRefreshTask = getRunningTaskByDedupeKey('refresh-models-and-rebuild-routes');
    if (!refreshJobId && runningRefreshTask) refreshJobId = runningRefreshTask.id;

    if (!refreshRequested) {
      const cachedModels = readModelsMarketplaceCache(includePricing);
      if (cachedModels) {
        return {
          models: cachedModels,
          meta: {
            refreshRequested,
            refreshQueued,
            refreshReused,
            refreshRunning: !!runningRefreshTask,
            refreshJobId,
            includePricing,
            cacheHit: true,
          },
        };
      }
    }

    const availability = db.select().from(schema.tokenModelAvailability)
      .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
      .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .all();
    const accountAvailability = db.select().from(schema.modelAvailability)
      .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          eq(schema.modelAvailability.available, true),
          eq(schema.accounts.status, 'active'),
          eq(schema.sites.status, 'active'),
        ),
      )
      .all();

    const last7d = getLocalRangeStartUtc(7);
    const recentLogs = db.select().from(schema.proxyLogs)
      .where(gte(schema.proxyLogs.createdAt, last7d))
      .all();

    const modelLogStats: Record<string, { success: number; total: number; totalLatency: number }> = {};
    for (const log of recentLogs) {
      const model = log.modelActual || log.modelRequested || '';
      if (!modelLogStats[model]) modelLogStats[model] = { success: 0, total: 0, totalLatency: 0 };
      modelLogStats[model].total++;
      if (log.status === 'success') modelLogStats[model].success++;
      modelLogStats[model].totalLatency += log.latencyMs || 0;
    }

    type ModelMetadataAggregate = {
      description: string | null;
      tags: Set<string>;
      supportedEndpointTypes: Set<string>;
      pricingSources: Array<{
        siteId: number;
        siteName: string;
        accountId: number;
        username: string | null;
        ownerBy: string | null;
        enableGroups: string[];
        groupPricing: Record<string, {
          quotaType: number;
          inputPerMillion?: number;
          outputPerMillion?: number;
          perCallInput?: number;
          perCallOutput?: number;
          perCallTotal?: number;
        }>;
      }>;
    };

    const modelMetadataMap = new Map<string, ModelMetadataAggregate>();
    if (includePricing) {
      const activeAccountRows = db.select().from(schema.accounts)
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(and(eq(schema.accounts.status, 'active'), eq(schema.sites.status, 'active')))
        .all();

      const metadataResults = await Promise.all(activeAccountRows.map(async (row) => {
        const catalog = await fetchModelPricingCatalog({
          site: {
            id: row.sites.id,
            url: row.sites.url,
            platform: row.sites.platform,
            apiKey: row.sites.apiKey,
          },
          account: {
            id: row.accounts.id,
            accessToken: row.accounts.accessToken,
            apiToken: row.accounts.apiToken,
          },
          modelName: '__metadata__',
          totalTokens: 0,
        });

        return {
          account: row.accounts,
          site: row.sites,
          catalog,
        };
      }));

      for (const result of metadataResults) {
        if (!result.catalog) continue;

        for (const model of result.catalog.models) {
          const key = model.modelName.toLowerCase();
          if (!modelMetadataMap.has(key)) {
            modelMetadataMap.set(key, {
              description: null,
              tags: new Set<string>(),
              supportedEndpointTypes: new Set<string>(),
              pricingSources: [],
            });
          }

          const aggregate = modelMetadataMap.get(key)!;
          if (!aggregate.description && model.modelDescription) {
            aggregate.description = model.modelDescription;
          }

          for (const tag of model.tags) aggregate.tags.add(tag);
          for (const endpointType of model.supportedEndpointTypes) {
            aggregate.supportedEndpointTypes.add(endpointType);
          }

          aggregate.pricingSources.push({
            siteId: result.site.id,
            siteName: result.site.name,
            accountId: result.account.id,
            username: result.account.username,
            ownerBy: model.ownerBy,
            enableGroups: model.enableGroups,
            groupPricing: model.groupPricing,
          });
        }
      }
    }

    const modelMap: Record<string, {
      name: string;
      accountsById: Map<number, {
        id: number;
        site: string;
        username: string | null;
        latency: number | null;
        unitCost: number | null;
        balance: number;
        tokens: Array<{ id: number; name: string; isDefault: boolean }>;
      }>;
    }> = {};

    for (const row of availability) {
      const m = row.token_model_availability;
      const t = row.account_tokens;
      const a = row.accounts;
      const s = row.sites;
      if (!m.available || !t.enabled || a.status !== 'active' || s.status !== 'active') continue;

      if (!modelMap[m.modelName]) {
        modelMap[m.modelName] = { name: m.modelName, accountsById: new Map() };
      }

      const existingAccount = modelMap[m.modelName].accountsById.get(a.id);
      if (!existingAccount) {
        modelMap[m.modelName].accountsById.set(a.id, {
          id: a.id,
          site: s.name,
          username: a.username,
          latency: m.latencyMs,
          unitCost: a.unitCost,
          balance: a.balance || 0,
          tokens: [{ id: t.id, name: t.name, isDefault: !!t.isDefault }],
        });
      } else {
        const nextLatency = (() => {
          if (existingAccount.latency == null) return m.latencyMs;
          if (m.latencyMs == null) return existingAccount.latency;
          return Math.min(existingAccount.latency, m.latencyMs);
        })();
        existingAccount.latency = nextLatency;
        if (!existingAccount.tokens.some((token) => token.id === t.id)) {
          existingAccount.tokens.push({ id: t.id, name: t.name, isDefault: !!t.isDefault });
        }
      }
    }

    for (const row of accountAvailability) {
      const m = row.model_availability;
      const a = row.accounts;
      const s = row.sites;
      if (!m.available || a.status !== 'active' || s.status !== 'active') continue;

      if (!modelMap[m.modelName]) {
        modelMap[m.modelName] = { name: m.modelName, accountsById: new Map() };
      }

      const existingAccount = modelMap[m.modelName].accountsById.get(a.id);
      if (!existingAccount) {
        modelMap[m.modelName].accountsById.set(a.id, {
          id: a.id,
          site: s.name,
          username: a.username,
          latency: m.latencyMs,
          unitCost: a.unitCost,
          balance: a.balance || 0,
          tokens: [],
        });
        continue;
      }

      const nextLatency = (() => {
        if (existingAccount.latency == null) return m.latencyMs;
        if (m.latencyMs == null) return existingAccount.latency;
        return Math.min(existingAccount.latency, m.latencyMs);
      })();
      existingAccount.latency = nextLatency;
    }

    let upstreamDescriptionMap = new Map<string, string>();
    if (includePricing) {
      const hasMissingDescription = Object.keys(modelMap).some((modelName) => {
        const metadata = modelMetadataMap.get(modelName.toLowerCase());
        return !metadata?.description;
      });
      if (hasMissingDescription) {
        upstreamDescriptionMap = await getUpstreamModelDescriptionsCached();
      }
    }

    const models = Object.values(modelMap).map((m) => {
      const logStats = modelLogStats[m.name];
      const accounts = Array.from(m.accountsById.values());
      const avgLatency = accounts.reduce((sum, a) => sum + (a.latency || 0), 0) / (accounts.length || 1);
      const metadata = modelMetadataMap.get(m.name.toLowerCase());
      const fallbackDescription = metadata?.description ? null : upstreamDescriptionMap.get(m.name.toLowerCase()) || null;
      return {
        name: m.name,
        accountCount: accounts.length,
        tokenCount: accounts.reduce((sum, account) => sum + account.tokens.length, 0),
        avgLatency: Math.round(avgLatency),
        successRate: logStats ? Math.round((logStats.success / logStats.total) * 1000) / 10 : null,
        description: metadata?.description || fallbackDescription,
        tags: metadata ? Array.from(metadata.tags).sort((a, b) => a.localeCompare(b)) : [],
        supportedEndpointTypes: metadata ? Array.from(metadata.supportedEndpointTypes).sort((a, b) => a.localeCompare(b)) : [],
        pricingSources: metadata?.pricingSources || [],
        accounts,
      };
    });

    models.sort((a, b) => b.accountCount - a.accountCount);
    writeModelsMarketplaceCache(includePricing, models);
    return {
      models,
      meta: {
        refreshRequested,
        refreshQueued,
        refreshReused,
        refreshRunning: !!runningRefreshTask,
        refreshJobId,
        includePricing,
      },
    };
  });

  app.get('/api/models/token-candidates', async () => {
    const resolveTokenGroupLabel = (tokenGroup: string | null, tokenName: string | null): string | null => {
      const explicit = (tokenGroup || '').trim();
      if (explicit) return explicit;

      const name = (tokenName || '').trim();
      if (!name) return null;
      const normalized = name.toLowerCase();
      if (normalized === 'default' || normalized === '默认' || /^default($|[-_\s])/.test(normalized)) {
        return 'default';
      }
      if (/^token-\d+$/.test(normalized)) return null;
      return name;
    };

    const rows = db.select().from(schema.tokenModelAvailability)
      .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
      .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          eq(schema.tokenModelAvailability.available, true),
          eq(schema.accountTokens.enabled, true),
          eq(schema.accounts.status, 'active'),
          eq(schema.sites.status, 'active'),
        ),
      )
      .all();
    const availableModelRows = db.select({
      modelName: schema.modelAvailability.modelName,
      accountId: schema.accounts.id,
      username: schema.accounts.username,
      siteId: schema.sites.id,
      siteName: schema.sites.name,
    })
      .from(schema.modelAvailability)
      .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          eq(schema.modelAvailability.available, true),
          eq(schema.accounts.status, 'active'),
          eq(schema.sites.status, 'active'),
        ),
      )
      .all();

    const result: Record<string, Array<{
      accountId: number;
      tokenId: number;
      tokenName: string;
      isDefault: boolean;
      username: string | null;
      siteId: number;
      siteName: string;
    }>> = {};
    const coveredAccountModelSet = new Set<string>();
    const coveredGroupsByAccountModel = new Map<string, Map<string, string>>();
    const unknownGroupCoverageByAccountModel = new Set<string>();
    const modelsWithoutToken: Record<string, Array<{
      accountId: number;
      username: string | null;
      siteId: number;
      siteName: string;
    }>> = {};
    const modelsMissingTokenGroups: Record<string, Array<{
      accountId: number;
      username: string | null;
      siteId: number;
      siteName: string;
      missingGroups: string[];
      requiredGroups: string[];
      availableGroups: string[];
      groupCoverageUncertain?: boolean;
    }>> = {};
    let hasAnyTokenGroupSignals = false;

    for (const row of rows) {
      const modelName = (row.token_model_availability.modelName || '').trim();
      if (!modelName) continue;
      const accountModelKey = `${row.accounts.id}::${modelName.toLowerCase()}`;
      coveredAccountModelSet.add(accountModelKey);

      const resolvedTokenGroup = resolveTokenGroupLabel(row.account_tokens.tokenGroup, row.account_tokens.name);
      if (resolvedTokenGroup) {
        hasAnyTokenGroupSignals = true;
        if (!coveredGroupsByAccountModel.has(accountModelKey)) {
          coveredGroupsByAccountModel.set(accountModelKey, new Map<string, string>());
        }
        const groupKey = resolvedTokenGroup.toLowerCase();
        if (!coveredGroupsByAccountModel.get(accountModelKey)!.has(groupKey)) {
          coveredGroupsByAccountModel.get(accountModelKey)!.set(groupKey, resolvedTokenGroup);
        }
      } else {
        unknownGroupCoverageByAccountModel.add(accountModelKey);
      }

      if (!result[modelName]) result[modelName] = [];
      if (result[modelName].some((item) => item.tokenId === row.account_tokens.id)) continue;
      result[modelName].push({
        accountId: row.accounts.id,
        tokenId: row.account_tokens.id,
        tokenName: row.account_tokens.name,
        isDefault: !!row.account_tokens.isDefault,
        username: row.accounts.username,
        siteId: row.sites.id,
        siteName: row.sites.name,
      });
    }

    for (const row of availableModelRows) {
      const modelName = (row.modelName || '').trim();
      if (!modelName) continue;
      const coverageKey = `${row.accountId}::${modelName.toLowerCase()}`;
      if (coveredAccountModelSet.has(coverageKey)) continue;
      if (!modelsWithoutToken[modelName]) modelsWithoutToken[modelName] = [];
      if (modelsWithoutToken[modelName].some((item) => item.accountId === row.accountId)) continue;
      modelsWithoutToken[modelName].push({
        accountId: row.accountId,
        username: row.username,
        siteId: row.siteId,
        siteName: row.siteName,
      });
    }

    const accountIdsForGroupHints = new Set(availableModelRows.map((row) => row.accountId));
    const requiredGroupsByAccountModel = new Map<string, Map<string, string>>();
    const hasPotentialGroupHints = hasAnyTokenGroupSignals || unknownGroupCoverageByAccountModel.size > 0;

    if (hasPotentialGroupHints && accountIdsForGroupHints.size > 0) {
      const accountRows = db.select().from(schema.accounts)
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(
          and(
            eq(schema.accounts.status, 'active'),
            eq(schema.sites.status, 'active'),
          ),
        )
        .all();

      const metadataResults = await Promise.all(
        accountRows
          .filter((row) => accountIdsForGroupHints.has(row.accounts.id))
          .map(async (row) => {
            try {
              const catalog = await fetchModelPricingCatalog({
                site: {
                  id: row.sites.id,
                  url: row.sites.url,
                  platform: row.sites.platform,
                  apiKey: row.sites.apiKey,
                },
                account: {
                  id: row.accounts.id,
                  accessToken: row.accounts.accessToken,
                  apiToken: row.accounts.apiToken,
                },
                modelName: '__metadata__',
                totalTokens: 0,
              });
              return { accountId: row.accounts.id, catalog };
            } catch {
              return { accountId: row.accounts.id, catalog: null as Awaited<ReturnType<typeof fetchModelPricingCatalog>> };
            }
          }),
      );

      for (const result of metadataResults) {
        if (!result.catalog) continue;
        for (const model of result.catalog.models) {
          const modelName = (model.modelName || '').trim();
          if (!modelName) continue;
          const groups = new Map<string, string>();
          for (const rawGroup of model.enableGroups || []) {
            const group = String(rawGroup || '').trim();
            if (!group) continue;
            const groupKey = group.toLowerCase();
            if (!groups.has(groupKey)) groups.set(groupKey, group);
          }
          if (groups.size === 0) continue;
          requiredGroupsByAccountModel.set(`${result.accountId}::${modelName.toLowerCase()}`, groups);
        }
      }
    }

    for (const row of availableModelRows) {
      const modelName = (row.modelName || '').trim();
      if (!modelName) continue;
      const accountModelKey = `${row.accountId}::${modelName.toLowerCase()}`;

      const requiredGroups = requiredGroupsByAccountModel.get(accountModelKey);
      if (!requiredGroups || requiredGroups.size === 0) continue;

      const availableGroups = coveredGroupsByAccountModel.get(accountModelKey) || new Map<string, string>();
      const missingGroups = Array.from(requiredGroups.entries())
        .filter(([groupKey]) => !availableGroups.has(groupKey))
        .map(([, label]) => label);
      if (missingGroups.length === 0) continue;

      if (!modelsMissingTokenGroups[modelName]) modelsMissingTokenGroups[modelName] = [];
      if (modelsMissingTokenGroups[modelName].some((item) => item.accountId === row.accountId)) continue;
      const hintRow = {
        accountId: row.accountId,
        username: row.username,
        siteId: row.siteId,
        siteName: row.siteName,
        missingGroups: missingGroups.sort((a, b) => a.localeCompare(b)),
        requiredGroups: Array.from(requiredGroups.values()).sort((a, b) => a.localeCompare(b)),
        availableGroups: Array.from(availableGroups.values()).sort((a, b) => a.localeCompare(b)),
      } as {
        accountId: number;
        username: string | null;
        siteId: number;
        siteName: string;
        missingGroups: string[];
        requiredGroups: string[];
        availableGroups: string[];
        groupCoverageUncertain?: boolean;
      };
      if (unknownGroupCoverageByAccountModel.has(accountModelKey)) {
        hintRow.groupCoverageUncertain = true;
      }
      modelsMissingTokenGroups[modelName].push(hintRow);
    }

    const endpointTypesByModel: Record<string, string[]> = {};
    const cachedPricing = readModelsMarketplaceCache(true);
    const cachedBase = cachedPricing || readModelsMarketplaceCache(false);
    if (cachedBase) {
      for (const model of cachedBase) {
        if (Array.isArray(model.supportedEndpointTypes) && model.supportedEndpointTypes.length > 0) {
          endpointTypesByModel[model.name] = model.supportedEndpointTypes;
        }
      }
    }

    return {
      models: result,
      modelsWithoutToken,
      modelsMissingTokenGroups,
      endpointTypesByModel,
    };
  });

  // Refresh models for one account and rebuild routes.
  app.post<{ Params: { accountId: string } }>('/api/models/check/:accountId', async (request) => {
    const accountId = Number.parseInt(request.params.accountId, 10);
    if (Number.isNaN(accountId)) {
      return { success: false, error: 'Invalid account id' };
    }

    const refresh = await refreshModelsForAccount(accountId);
    const rebuild = rebuildTokenRoutesFromAvailability();
    return { success: true, refresh, rebuild };
  });

  // Site distribution – per-site aggregate data
  app.get('/api/stats/site-distribution', async () => {
    const accounts = db.select().from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(eq(schema.sites.status, 'active'))
      .all();

    const proxyLogs = db.select().from(schema.proxyLogs)
      .leftJoin(schema.accounts, eq(schema.proxyLogs.accountId, schema.accounts.id))
      .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(eq(schema.sites.status, 'active'))
      .all();

    // Build spend per site from proxy logs
    const spendBySiteId: Record<number, number> = {};
    for (const row of proxyLogs) {
      const siteId = row.sites?.id;
      if (siteId == null) continue;
      const log = row.proxy_logs;
      const platform = row.sites?.platform || 'new-api';
      const explicitCost = typeof log.estimatedCost === 'number' ? log.estimatedCost : 0;
      const cost = explicitCost > 0 ? explicitCost : fallbackTokenCost(log.totalTokens || 0, platform);
      spendBySiteId[siteId] = (spendBySiteId[siteId] || 0) + cost;
    }

    // Aggregate accounts by site
    const siteMap: Record<number, {
      siteName: string;
      platform: string;
      totalBalance: number;
      accountCount: number;
    }> = {};

    for (const row of accounts) {
      const site = row.sites;
      const acct = row.accounts;
      if (!siteMap[site.id]) {
        siteMap[site.id] = { siteName: site.name, platform: site.platform, totalBalance: 0, accountCount: 0 };
      }
      siteMap[site.id].totalBalance += acct.balance || 0;
      siteMap[site.id].accountCount++;
    }

    const distribution = Object.entries(siteMap).map(([id, info]) => ({
      siteId: Number(id),
      siteName: info.siteName,
      platform: info.platform,
      totalBalance: Math.round(info.totalBalance * 1_000_000) / 1_000_000,
      totalSpend: Math.round((spendBySiteId[Number(id)] || 0) * 1_000_000) / 1_000_000,
      accountCount: info.accountCount,
    }));

    return { distribution };
  });

  // Site trend – daily spend/calls broken down by site
  app.get<{ Querystring: { days?: string } }>('/api/stats/site-trend', async (request) => {
    const days = Math.max(1, parseInt(request.query.days || '7', 10));
    const sinceDate = getLocalRangeStartUtc(days);

    const rows = db.select().from(schema.proxyLogs)
      .leftJoin(schema.accounts, eq(schema.proxyLogs.accountId, schema.accounts.id))
      .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(and(gte(schema.proxyLogs.createdAt, sinceDate), eq(schema.sites.status, 'active')))
      .all();

    // Group by date + site name
    const dayMap: Record<string, Record<string, { spend: number; calls: number }>> = {};

    for (const row of rows) {
      const log = row.proxy_logs;
      const siteName = row.sites?.name || 'unknown';
      const platform = row.sites?.platform || 'new-api';
      const date = toLocalDayKeyFromStoredUtc(log.createdAt);
      if (!date) continue;

      if (!dayMap[date]) dayMap[date] = {};
      if (!dayMap[date][siteName]) dayMap[date][siteName] = { spend: 0, calls: 0 };

      const explicitCost = typeof log.estimatedCost === 'number' ? log.estimatedCost : 0;
      const cost = explicitCost > 0 ? explicitCost : fallbackTokenCost(log.totalTokens || 0, platform);
      dayMap[date][siteName].spend += cost;
      dayMap[date][siteName].calls++;
    }

    // Round spend values and sort by date
    const trend = Object.entries(dayMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, sites]) => {
        const rounded: Record<string, { spend: number; calls: number }> = {};
        for (const [name, stats] of Object.entries(sites)) {
          rounded[name] = {
            spend: Math.round(stats.spend * 1_000_000) / 1_000_000,
            calls: stats.calls,
          };
        }
        return { date, sites: rounded };
      });

    return { trend };
  });

  // Model stats by site
  app.get<{ Querystring: { siteId?: string; days?: string } }>('/api/stats/model-by-site', async (request) => {
    const siteId = request.query.siteId ? parseInt(request.query.siteId, 10) : null;
    const days = Math.max(1, parseInt(request.query.days || '7', 10));
    const sinceDate = getLocalRangeStartUtc(days);

    // Get account IDs belonging to the site (if filtered)
    let accountIds: Set<number> | null = null;
    if (siteId != null && !Number.isNaN(siteId)) {
      const siteAccounts = db.select().from(schema.accounts)
        .where(eq(schema.accounts.siteId, siteId)).all();
      accountIds = new Set(siteAccounts.map((a) => a.id));
    }

    const rows = db.select().from(schema.proxyLogs)
      .leftJoin(schema.accounts, eq(schema.proxyLogs.accountId, schema.accounts.id))
      .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(and(gte(schema.proxyLogs.createdAt, sinceDate), eq(schema.sites.status, 'active')))
      .all();

    const modelMap: Record<string, { calls: number; spend: number; tokens: number }> = {};

    for (const row of rows) {
      const log = row.proxy_logs;
      // Filter by site if siteId is specified
      if (accountIds != null && (log.accountId == null || !accountIds.has(log.accountId))) continue;

      const model = log.modelActual || log.modelRequested || 'unknown';
      const platform = row.sites?.platform || 'new-api';

      if (!modelMap[model]) modelMap[model] = { calls: 0, spend: 0, tokens: 0 };
      modelMap[model].calls++;
      modelMap[model].tokens += log.totalTokens || 0;

      const explicitCost = typeof log.estimatedCost === 'number' ? log.estimatedCost : 0;
      const cost = explicitCost > 0 ? explicitCost : fallbackTokenCost(log.totalTokens || 0, platform);
      modelMap[model].spend += cost;
    }

    const models = Object.entries(modelMap)
      .map(([model, stats]) => ({
        model,
        calls: stats.calls,
        spend: Math.round(stats.spend * 1_000_000) / 1_000_000,
        tokens: stats.tokens,
      }))
      .sort((a, b) => b.calls - a.calls);

    return { models };
  });
}

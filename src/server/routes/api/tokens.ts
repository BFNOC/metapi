import { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { requireInsertedRowId } from '../../db/insertHelpers.js';
import * as routeRefreshWorkflow from '../../services/routeRefreshWorkflow.js';
import {
  ACCOUNT_TOKEN_VALUE_STATUS_READY,
  isUsableAccountToken,
} from '../../services/accountTokenService.js';
import {
  getCredentialModeFromExtraConfig,
  hasOauthProvider,
  supportsDirectAccountRoutingConnection,
} from '../../services/accountExtraConfig.js';
import {
  DEFAULT_ROUTE_ROUTING_STRATEGY,
  normalizeRouteRoutingStrategy,
  type RouteRoutingStrategy,
} from '../../services/routeRoutingStrategy.js';
import {
  clearSiteModelRuntimeHealthForChannels,
  invalidateTokenRouterCache,
  matchesModelPattern,
  tokenRouter,
  resetSiteRuntimeHealthForSite,
} from '../../services/tokenRouter.js';
import { startBackgroundTask } from '../../services/backgroundTaskService.js';
import {
  clearRouteDecisionSnapshot,
  clearRouteDecisionSnapshots,
  parseRouteDecisionSnapshot,
  saveRouteDecisionSnapshots,
} from '../../services/routeDecisionSnapshotStore.js';
import {
  applyChannelPriorityUpdates,
  clearDependentExplicitGroupSnapshotsBySourceRouteIds,
} from '../../services/channelPriorityHelper.js';
import {
  loadChannelProbeEntry,
  loadRouteChannelProbeEntries,
  probeChannelEntry,
  probeRouteChannelEntries,
} from '../../services/channelProbeService.js';
import { deriveProbeHealthStatus } from '../../../shared/probeHealthClassifier.runtime.js';
import { normalizeTokenRouteMode, type RouteMode } from '../../../shared/tokenRouteContract.js';

function isExactModelPattern(modelPattern: string): boolean {
  const normalized = modelPattern.trim();
  if (!normalized) return false;
  if (normalized.toLowerCase().startsWith('re:')) return false;
  return !/[\*\?]/.test(normalized);
}

type RouteRow = typeof schema.tokenRoutes.$inferSelect & {
  routeMode: RouteMode;
  sourceRouteIds: number[];
};

function normalizeRouteMode(routeMode: unknown): RouteMode {
  return normalizeTokenRouteMode(routeMode);
}

function isExplicitGroupRoute(route: Pick<RouteRow, 'routeMode'> | Pick<typeof schema.tokenRoutes.$inferSelect, 'routeMode'>): boolean {
  return normalizeRouteMode(route.routeMode) === 'explicit_group';
}

function normalizeSourceRouteIdsInput(input: unknown): number[] {
  const rawValues = Array.isArray(input) ? input : [];
  const normalized: number[] = [];
  for (const raw of rawValues) {
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const routeId = Math.trunc(value);
    if (routeId <= 0 || normalized.includes(routeId)) continue;
    normalized.push(routeId);
    if (normalized.length >= 500) break;
  }
  return normalized;
}

async function loadRouteSourceIdsMap(routeIds: number[]): Promise<Map<number, number[]>> {
  const normalizedRouteIds = Array.from(new Set(routeIds.filter((routeId) => Number.isFinite(routeId) && routeId > 0)));
  if (normalizedRouteIds.length === 0) return new Map();

  const rows = await db.select().from(schema.routeGroupSources)
    .where(inArray(schema.routeGroupSources.groupRouteId, normalizedRouteIds))
    .all();
  const sourceRouteIdsByRouteId = new Map<number, number[]>();
  for (const row of rows) {
    if (!sourceRouteIdsByRouteId.has(row.groupRouteId)) {
      sourceRouteIdsByRouteId.set(row.groupRouteId, []);
    }
    sourceRouteIdsByRouteId.get(row.groupRouteId)!.push(row.sourceRouteId);
  }
  for (const [routeId, sourceRouteIds] of sourceRouteIdsByRouteId.entries()) {
    sourceRouteIdsByRouteId.set(routeId, Array.from(new Set(sourceRouteIds)));
  }
  return sourceRouteIdsByRouteId;
}

function decorateRoutesWithSources(
  routes: Array<typeof schema.tokenRoutes.$inferSelect>,
  sourceRouteIdsByRouteId: Map<number, number[]>,
): RouteRow[] {
  return routes.map((route) => ({
    ...route,
    routeMode: normalizeRouteMode(route.routeMode),
    sourceRouteIds: sourceRouteIdsByRouteId.get(route.id) ?? [],
  }));
}

async function listRoutesWithSources(): Promise<RouteRow[]> {
  const routes = await db.select().from(schema.tokenRoutes).all();
  const sourceRouteIdsByRouteId = await loadRouteSourceIdsMap(routes.map((route: any) => route.id));
  return decorateRoutesWithSources(routes, sourceRouteIdsByRouteId);
}

async function getRouteWithSources(routeId: number): Promise<RouteRow | null> {
  const route = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, routeId)).get();
  if (!route) return null;
  const sourceRouteIdsByRouteId = await loadRouteSourceIdsMap([routeId]);
  return decorateRoutesWithSources([route], sourceRouteIdsByRouteId)[0] ?? null;
}

async function validateExplicitGroupSourceRoutes(sourceRouteIds: number[], currentRouteId?: number): Promise<{ ok: true } | { ok: false; message: string }> {
  if (sourceRouteIds.length === 0) {
    return { ok: false, message: '显式群组至少需要选择一个来源模型' };
  }

  const routes = await db.select().from(schema.tokenRoutes)
    .where(inArray(schema.tokenRoutes.id, sourceRouteIds))
    .all();
  if (routes.length !== sourceRouteIds.length) {
    return { ok: false, message: '来源模型中存在不存在的路由' };
  }

  for (const route of routes) {
    if (currentRouteId && route.id === currentRouteId) {
      return { ok: false, message: '显式群组不能引用自身作为来源模型' };
    }
    if (normalizeRouteMode(route.routeMode) === 'explicit_group') {
      return { ok: false, message: '显式群组只能选择精确模型路由作为来源模型' };
    }
    if (!isExactModelPattern(route.modelPattern)) {
      return { ok: false, message: '显式群组只能选择精确模型路由作为来源模型' };
    }
  }

  return { ok: true };
}

async function replaceRouteSourceRouteIds(routeId: number, sourceRouteIds: number[]): Promise<void> {
  await db.delete(schema.routeGroupSources).where(eq(schema.routeGroupSources.groupRouteId, routeId)).run();
  if (sourceRouteIds.length === 0) return;
  await db.insert(schema.routeGroupSources).values(
    sourceRouteIds.map((sourceRouteId) => ({
      groupRouteId: routeId,
      sourceRouteId,
    })),
  ).run();
}

async function syncExplicitGroupSourceRouteStrategies(input: {
  groupRouteId: number;
  sourceRouteIds: number[];
  targetStrategy: RouteRoutingStrategy;
  previousStrategy?: RouteRoutingStrategy | null;
}): Promise<number[]> {
  const normalizedSourceRouteIds = Array.from(new Set(
    input.sourceRouteIds.filter((routeId): routeId is number => Number.isFinite(routeId) && routeId > 0),
  ));
  if (normalizedSourceRouteIds.length === 0) return [];

  const [sourceRoutes, sourceGroupRows] = await Promise.all([
    db.select().from(schema.tokenRoutes)
      .where(inArray(schema.tokenRoutes.id, normalizedSourceRouteIds))
      .all(),
    db.select({
      groupRouteId: schema.routeGroupSources.groupRouteId,
      sourceRouteId: schema.routeGroupSources.sourceRouteId,
    }).from(schema.routeGroupSources)
      .where(inArray(schema.routeGroupSources.sourceRouteId, normalizedSourceRouteIds))
      .all(),
  ]);

  const otherGroupRefsBySourceRouteId = new Map<number, Set<number>>();
  for (const row of sourceGroupRows) {
    if (row.groupRouteId === input.groupRouteId) continue;
    if (!otherGroupRefsBySourceRouteId.has(row.sourceRouteId)) {
      otherGroupRefsBySourceRouteId.set(row.sourceRouteId, new Set());
    }
    otherGroupRefsBySourceRouteId.get(row.sourceRouteId)!.add(row.groupRouteId);
  }

  const previousStrategy = input.previousStrategy
    ? normalizeRouteRoutingStrategy(input.previousStrategy)
    : null;
  const updatableRouteIds: number[] = [];
  for (const route of sourceRoutes) {
    if (normalizeRouteMode(route.routeMode) === 'explicit_group') continue;
    if (!isExactModelPattern(route.modelPattern)) continue;
    if ((otherGroupRefsBySourceRouteId.get(route.id)?.size || 0) > 0) continue;

    const currentStrategy = normalizeRouteRoutingStrategy(route.routingStrategy);
    const shouldSync = (
      currentStrategy === DEFAULT_ROUTE_ROUTING_STRATEGY
      || currentStrategy === input.targetStrategy
      || (previousStrategy !== null && currentStrategy === previousStrategy)
    );
    if (!shouldSync) continue;
    if (currentStrategy === input.targetStrategy) continue;
    updatableRouteIds.push(route.id);
  }

  if (updatableRouteIds.length === 0) return [];

  await db.update(schema.tokenRoutes).set({
    routingStrategy: input.targetStrategy,
    updatedAt: new Date().toISOString(),
  }).where(inArray(schema.tokenRoutes.id, updatableRouteIds)).run();

  return updatableRouteIds;
}

async function resolveCooldownClearRouteIds(route: RouteRow): Promise<number[]> {
  if (!isExplicitGroupRoute(route)) {
    return [route.id];
  }

  const sourceRouteIds = Array.from(new Set(
    route.sourceRouteIds.filter((routeId): routeId is number => Number.isFinite(routeId) && routeId > 0),
  ));
  if (sourceRouteIds.length === 0) return [];

  const sourceRoutes = await db.select({
    id: schema.tokenRoutes.id,
    modelPattern: schema.tokenRoutes.modelPattern,
    routeMode: schema.tokenRoutes.routeMode,
    enabled: schema.tokenRoutes.enabled,
  }).from(schema.tokenRoutes)
    .where(inArray(schema.tokenRoutes.id, sourceRouteIds))
    .all();

  return sourceRoutes
    .filter((sourceRoute: any) => (
      sourceRoute.enabled
      && normalizeRouteMode(sourceRoute.routeMode) !== 'explicit_group'
      && isExactModelPattern(sourceRoute.modelPattern)
    ))
    .map((sourceRoute: any) => sourceRoute.id);
}

async function getDefaultTokenId(accountId: number): Promise<number | null> {
  const token = await db.select().from(schema.accountTokens)
    .where(and(
      eq(schema.accountTokens.accountId, accountId),
      eq(schema.accountTokens.enabled, true),
      eq(schema.accountTokens.isDefault, true),
      eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
    ))
    .get();
  return isUsableAccountToken(token ?? null) ? token!.id : null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.trunc(value) > 0;
}

function validateOptionalBooleanField(value: unknown, fieldName: string): { ok: true } | { ok: false; message: string } {
  if (value === undefined || typeof value === 'boolean') return { ok: true };
  return { ok: false, message: `${fieldName} 必须是布尔值` };
}

function validateOptionalDisplayName(value: unknown): { ok: true } | { ok: false; message: string } {
  if (value === undefined || value === null || typeof value === 'string') return { ok: true };
  return { ok: false, message: 'displayName 必须是字符串或 null' };
}

function validateOptionalSourceRouteIds(value: unknown): { ok: true } | { ok: false; message: string } {
  if (value === undefined) return { ok: true };
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    return { ok: false, message: 'sourceRouteIds 必须是 number[]' };
  }
  return { ok: true };
}

async function getAccountRoutingContext(accountId: number): Promise<typeof schema.accounts.$inferSelect | null> {
  return await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get() ?? null;
}

type RouteChannelBindingResolution =
  | {
    ok: true;
    account: typeof schema.accounts.$inferSelect;
    storedTokenId: number | null;
    effectiveTokenId: number | null;
  }
  | {
    ok: false;
    message: string;
  };

async function resolveRouteChannelBinding(input: {
  accountId: number;
  rawTokenId: unknown;
  allowImplicitDefault: boolean;
}): Promise<RouteChannelBindingResolution> {
  const account = await getAccountRoutingContext(input.accountId);
  if (!account) {
    return { ok: false, message: `账号 ${input.accountId} 不存在` };
  }
  const supportsDirectRouting = supportsDirectAccountRoutingConnection(account);
  const prefersDirectPrincipal = hasOauthProvider(account.extraConfig) || getCredentialModeFromExtraConfig(account.extraConfig) === 'apikey';
  const resolveDefaultTokenFallback = async (): Promise<RouteChannelBindingResolution> => {
    const defaultTokenId = await getDefaultTokenId(input.accountId);
    if (defaultTokenId === null) {
      if (prefersDirectPrincipal) {
        return { ok: false, message: '当前账号主凭证不可用' };
      }
      return { ok: false, message: `账号 ${input.accountId} 没有可用的默认令牌` };
    }
    return {
      ok: true,
      account,
      storedTokenId: null,
      effectiveTokenId: defaultTokenId,
    };
  };

  if (input.rawTokenId === undefined) {
    if (supportsDirectRouting) {
      return {
        ok: true,
        account,
        storedTokenId: null,
        effectiveTokenId: null,
      };
    }
    if (prefersDirectPrincipal) {
      return { ok: false, message: '当前账号主凭证不可用' };
    }
    if (!input.allowImplicitDefault) {
      return { ok: false, message: '当前账号不支持绑定账号主凭证' };
    }
    return await resolveDefaultTokenFallback();
  }

  if (input.rawTokenId === null) {
    if (prefersDirectPrincipal) {
      if (!supportsDirectRouting) {
        return { ok: false, message: '当前账号主凭证不可用' };
      }
      return {
        ok: true,
        account,
        storedTokenId: null,
        effectiveTokenId: null,
      };
    }
    return { ok: false, message: '当前账号不支持绑定账号主凭证' };
  }

  if (input.rawTokenId === 0) {
    if (supportsDirectRouting) {
      return { ok: false, message: '当前账号请使用账号主凭证，不能跟随默认令牌' };
    }
    return await resolveDefaultTokenFallback();
  }

  if (typeof input.rawTokenId !== 'number' || !Number.isFinite(input.rawTokenId) || input.rawTokenId <= 0) {
    return { ok: false, message: 'tokenId 必须是正整数、0、null 或省略' };
  }

  const requestedTokenId = Math.trunc(input.rawTokenId);
  if (!await checkTokenBelongsToAccount(requestedTokenId, input.accountId)) {
    return { ok: false, message: `令牌 ${requestedTokenId} 不属于账号 ${input.accountId}` };
  }

  return {
    ok: true,
    account,
    storedTokenId: requestedTokenId,
    effectiveTokenId: requestedTokenId,
  };
}

function canonicalModelAlias(modelName: string): string {
  const normalized = modelName.trim().toLowerCase();
  if (!normalized) return '';
  const slashIndex = normalized.lastIndexOf('/');
  if (slashIndex >= 0 && slashIndex < normalized.length - 1) {
    return normalized.slice(slashIndex + 1);
  }
  return normalized;
}

function isModelAliasEquivalent(left: string, right: string): boolean {
  const a = canonicalModelAlias(left);
  const b = canonicalModelAlias(right);
  return !!a && !!b && a === b;
}

async function tokenSupportsModel(tokenId: number, modelName: string): Promise<boolean> {
  const rows = await db.select().from(schema.tokenModelAvailability)
    .where(
      and(
        eq(schema.tokenModelAvailability.tokenId, tokenId),
        eq(schema.tokenModelAvailability.available, true),
      ),
    )
    .all();
  return rows.some((row: any) => {
    const availableModelName = row.modelName?.trim();
    if (!availableModelName) return false;
    return availableModelName === modelName || isModelAliasEquivalent(availableModelName, modelName);
  });
}

async function accountSupportsModel(accountId: number, modelName: string): Promise<boolean> {
  const rows = await db.select().from(schema.modelAvailability)
    .where(
      and(
        eq(schema.modelAvailability.accountId, accountId),
        eq(schema.modelAvailability.available, true),
      ),
    )
    .all();
  return rows.some((row: any) => {
    const availableModelName = row.modelName?.trim();
    if (!availableModelName) return false;
    return availableModelName === modelName || isModelAliasEquivalent(availableModelName, modelName);
  });
}

async function checkTokenBelongsToAccount(tokenId: number, accountId: number): Promise<boolean> {
  const row = await db.select().from(schema.accountTokens)
    .where(and(eq(schema.accountTokens.id, tokenId), eq(schema.accountTokens.accountId, accountId)))
    .get();
  return isUsableAccountToken(row ?? null);
}

async function getPatternTokenCandidates(modelPattern: string): Promise<Array<{ tokenId: number; accountId: number; sourceModel: string }>> {
  const rows = await db.select().from(schema.tokenModelAvailability)
    .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(
      and(
        eq(schema.tokenModelAvailability.available, true),
        eq(schema.accountTokens.enabled, true),
        eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
        eq(schema.accounts.status, 'active'),
        eq(schema.sites.status, 'active'),
      ),
    )
    .all();

  const result: Array<{ tokenId: number; accountId: number; sourceModel: string }> = [];
  for (const row of rows) {
    if (!isUsableAccountToken(row.account_tokens)) continue;
    const modelName = row.token_model_availability.modelName?.trim();
    if (!modelName) continue;
    if (!matchesModelPattern(modelName, modelPattern)) continue;
    result.push({
      tokenId: row.account_tokens.id,
      accountId: row.accounts.id,
      sourceModel: modelName,
    });
  }

  return result;
}

async function getMatchedExactRouteChannelCandidates(modelPattern: string): Promise<Array<{
  tokenId: number | null;
  accountId: number;
  sourceModel: string;
  priority: number;
  weight: number;
  enabled: boolean;
  manualOverride: boolean;
}>> {
  const matchedRoutes = (await db.select().from(schema.tokenRoutes)
    .where(eq(schema.tokenRoutes.enabled, true))
    .all())
    .filter((route: any) => isExactModelPattern(route.modelPattern) && matchesModelPattern(route.modelPattern, modelPattern));

  if (matchedRoutes.length === 0) return [];
  const routeMap = new Map<number, typeof matchedRoutes[number]>();
  for (const route of matchedRoutes) routeMap.set(route.id, route);

  const channels = await db.select().from(schema.routeChannels)
    .where(inArray(schema.routeChannels.routeId, matchedRoutes.map((route: any) => route.id)))
    .all();

  return channels.map((channel: any) => ({
    tokenId: channel.tokenId ?? null,
    accountId: channel.accountId,
    sourceModel: (channel.sourceModel || routeMap.get(channel.routeId)?.modelPattern || '').trim(),
    priority: channel.priority ?? 0,
    weight: channel.weight ?? 10,
    enabled: !!channel.enabled,
    manualOverride: !!channel.manualOverride,
  })).filter((candidate: any) => candidate.sourceModel.length > 0);
}

async function populateRouteChannelsByModelPattern(routeId: number, modelPattern: string): Promise<number> {
  const routeCandidates = await getMatchedExactRouteChannelCandidates(modelPattern);
  const availabilityCandidates = (await getPatternTokenCandidates(modelPattern)).map((candidate) => ({
    tokenId: candidate.tokenId,
    accountId: candidate.accountId,
    sourceModel: candidate.sourceModel,
    priority: 0,
    weight: 10,
    enabled: true,
    manualOverride: false,
  }));
  const candidates = [...routeCandidates, ...availabilityCandidates];
  if (candidates.length === 0) return 0;

  const existingChannels = await db.select().from(schema.routeChannels)
    .where(eq(schema.routeChannels.routeId, routeId))
    .all();
  const existingPairs = new Set<string>(
    existingChannels
      .map((channel: any) => {
        const tokenId = typeof channel.tokenId === 'number' && Number.isFinite(channel.tokenId) ? channel.tokenId : 0;
        const sourceModel = (channel.sourceModel || '').trim().toLowerCase();
        return `${channel.accountId}::${tokenId}::${sourceModel}`;
      }),
  );

  let created = 0;
  for (const candidate of candidates) {
    const tokenId = typeof candidate.tokenId === 'number' && Number.isFinite(candidate.tokenId) ? candidate.tokenId : 0;
    const pairKey = `${candidate.accountId}::${tokenId}::${candidate.sourceModel.trim().toLowerCase()}`;
    if (existingPairs.has(pairKey)) continue;
    await db.insert(schema.routeChannels).values({
      routeId,
      accountId: candidate.accountId,
      tokenId: candidate.tokenId,
      sourceModel: candidate.sourceModel,
      priority: candidate.priority,
      weight: candidate.weight,
      enabled: candidate.enabled,
      manualOverride: candidate.manualOverride,
    }).run();
    existingPairs.add(pairKey);
    created += 1;
  }

  return created;
}

async function rebuildAutomaticRouteChannelsByModelPattern(routeId: number, modelPattern: string): Promise<{
  removedChannels: number;
  createdChannels: number;
}> {
  const removableChannels = await db.select().from(schema.routeChannels)
    .where(
      and(
        eq(schema.routeChannels.routeId, routeId),
        eq(schema.routeChannels.manualOverride, false),
      ),
    )
    .all();

  for (const channel of removableChannels) {
    await db.delete(schema.routeChannels).where(eq(schema.routeChannels.id, channel.id)).run();
  }

  const createdChannels = await populateRouteChannelsByModelPattern(routeId, modelPattern);
  return {
    removedChannels: removableChannels.length,
    createdChannels,
  };
}

type BatchChannelPriorityUpdate = {
  id: number;
  priority: number;
};

type BatchRouteDecisionModels = {
  models: string[];
  refreshPricingCatalog?: boolean;
  persistSnapshots?: boolean;
};

type BatchRouteDecisionRouteModels = {
  items: Array<{
    routeId: number;
    model: string;
  }>;
  refreshPricingCatalog?: boolean;
  persistSnapshots?: boolean;
};

type BatchRouteWideDecisionRouteIds = {
  routeIds: number[];
  refreshPricingCatalog?: boolean;
  persistSnapshots?: boolean;
};

type ProbeRankingStatus = 'supported' | 'unsupported' | 'inconclusive' | 'skipped';

type ProbeRankingPayloadItem = {
  channelId: number;
  ttftMs: number | null;
  status: ProbeRankingStatus;
  httpStatus: number | null;
  error?: string | null;
};

function parseBatchChannelUpdates(input: unknown): { ok: true; updates: BatchChannelPriorityUpdate[] } | { ok: false; message: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, message: '请求体必须是对象' };
  }

  const updates = (input as { updates?: unknown }).updates;
  if (!Array.isArray(updates) || updates.length === 0) {
    return { ok: false, message: 'updates 必须是非空数组' };
  }

  const normalized: BatchChannelPriorityUpdate[] = [];
  for (let index = 0; index < updates.length; index += 1) {
    const item = updates[index];
    if (!item || typeof item !== 'object') {
      return { ok: false, message: `updates[${index}] 必须是对象` };
    }

    const { id, priority } = item as { id?: unknown; priority?: unknown };
    if (typeof id !== 'number' || !Number.isFinite(id)) {
      return { ok: false, message: `updates[${index}].id 必须是有限数字` };
    }
    if (typeof priority !== 'number' || !Number.isFinite(priority)) {
      return { ok: false, message: `updates[${index}].priority 必须是有限数字` };
    }

    const normalizedId = Math.trunc(id);
    if (normalizedId <= 0) {
      return { ok: false, message: `updates[${index}].id 必须大于 0` };
    }

    normalized.push({
      id: normalizedId,
      priority: Math.max(0, Math.trunc(priority)),
    });
  }

  return { ok: true, updates: normalized };
}

function parseApplyProbeRankingInput(
  input: unknown,
): { ok: true; ranking: ProbeRankingPayloadItem[] } | { ok: false; message: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, message: '请求体必须是对象' };
  }

  const ranking = (input as { ranking?: unknown }).ranking;
  if (!Array.isArray(ranking) || ranking.length === 0) {
    return { ok: false, message: 'ranking 必须是非空数组' };
  }

  const normalized: ProbeRankingPayloadItem[] = [];
  const seenIds = new Set<number>();
  for (let index = 0; index < ranking.length; index += 1) {
    const item = ranking[index];
    if (!item || typeof item !== 'object') {
      return { ok: false, message: `ranking[${index}] 必须是对象` };
    }

    const channelIdRaw = (item as { channelId?: unknown }).channelId;
    const ttftMsRaw = (item as { ttftMs?: unknown }).ttftMs;
    const statusRaw = (item as { status?: unknown }).status;
    const httpStatusRaw = (item as { httpStatus?: unknown }).httpStatus;
    const errorRaw = (item as { error?: unknown }).error;
    if (typeof channelIdRaw !== 'number' || !Number.isFinite(channelIdRaw)) {
      return { ok: false, message: `ranking[${index}].channelId 必须是有限数字` };
    }
    if (
      ttftMsRaw !== null
      && (typeof ttftMsRaw !== 'number' || !Number.isFinite(ttftMsRaw))
    ) {
      return { ok: false, message: `ranking[${index}].ttftMs 必须是数字或 null` };
    }
    if (
      statusRaw !== 'supported'
      && statusRaw !== 'unsupported'
      && statusRaw !== 'inconclusive'
      && statusRaw !== 'skipped'
    ) {
      return { ok: false, message: `ranking[${index}].status 非法` };
    }
    if (
      httpStatusRaw !== null
      && (typeof httpStatusRaw !== 'number' || !Number.isFinite(httpStatusRaw))
    ) {
      return { ok: false, message: `ranking[${index}].httpStatus 必须是数字或 null` };
    }
    if (
      errorRaw !== undefined
      && errorRaw !== null
      && typeof errorRaw !== 'string'
    ) {
      return { ok: false, message: `ranking[${index}].error 必须是字符串或 null` };
    }

    const channelId = Math.trunc(channelIdRaw);
    if (channelId <= 0) {
      return { ok: false, message: `ranking[${index}].channelId 必须大于 0` };
    }
    if (seenIds.has(channelId)) {
      return { ok: false, message: `ranking[${index}].channelId 重复` };
    }
    seenIds.add(channelId);

    normalized.push({
      channelId,
      ttftMs: ttftMsRaw === null ? null : Math.max(0, Math.trunc(ttftMsRaw)),
      status: statusRaw,
      httpStatus: httpStatusRaw === null ? null : Math.trunc(httpStatusRaw),
      error: typeof errorRaw === 'string' ? errorRaw : null,
    });
  }

  return { ok: true, ranking: normalized };
}

function sortChannelsByCurrentPriority(channels: Array<typeof schema.routeChannels.$inferSelect>) {
  return [...channels].sort((left, right) => {
    const leftPriority = left.priority ?? 0;
    const rightPriority = right.priority ?? 0;
    if (leftPriority === rightPriority) return left.id - right.id;
    return leftPriority - rightPriority;
  });
}

type ProbeRankingUpdate = { id: number; priority: number; weight: number; };

function buildProbeRankingUpdates(
  channels: Array<typeof schema.routeChannels.$inferSelect>,
  ranking: ProbeRankingPayloadItem[],
): ProbeRankingUpdate[] {
  const rankingByChannelId = new Map(ranking.map((item) => [item.channelId, item]));
  const healthy: Array<{ channel: typeof schema.routeChannels.$inferSelect; item: ProbeRankingPayloadItem }> = [];
  const uncertain: Array<typeof schema.routeChannels.$inferSelect> = [];
  const unhealthy: Array<typeof schema.routeChannels.$inferSelect> = [];

  for (const channel of sortChannelsByCurrentPriority(channels)) {
    const item = rankingByChannelId.get(channel.id);
    if (!item) { uncertain.push(channel); continue; }
    const health = deriveProbeHealthStatus(item.status, item.httpStatus, item.error || null);
    if (health === 'failure') {
      unhealthy.push(channel);
    } else if (item.status === 'supported') {
      healthy.push({ channel, item });
    } else {
      uncertain.push(channel);
    }
  }

  const healthyUpdates: ProbeRankingUpdate[] = healthy.map(({ channel, item }) => ({
    id: channel.id, priority: channel.priority ?? 0, weight: ttftToWeight(item.ttftMs),
  }));
  const uncertainUpdates: ProbeRankingUpdate[] = uncertain.map((channel) => ({
    id: channel.id, priority: channel.priority ?? 0, weight: channel.weight ?? 10,
  }));
  const maxExistingPriority = Math.max(0, ...channels.map((channel) => channel.priority ?? 0));
  const sinkPriority = maxExistingPriority + 1;
  const unhealthyUpdates: ProbeRankingUpdate[] = unhealthy.map((channel) => ({
    id: channel.id, priority: sinkPriority, weight: channel.weight ?? 10,
  }));
  return [...healthyUpdates, ...uncertainUpdates, ...unhealthyUpdates];
}

function ttftToWeight(ttftMs: number | null): number {
  if (ttftMs == null) return 100;
  if (ttftMs < 1000) return 200;
  if (ttftMs < 3000) return 100;
  return 30;
}

function parseBatchRouteDecisionModels(
  input: unknown,
): { ok: true; models: string[]; refreshPricingCatalog: boolean; persistSnapshots: boolean } | { ok: false; message: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, message: '请求体必须是对象' };
  }

  const models = (input as BatchRouteDecisionModels).models;
  if (!Array.isArray(models) || models.length === 0) {
    return { ok: false, message: 'models 必须是非空数组' };
  }

  const dedupe = new Set<string>();
  const normalized: string[] = [];
  for (const raw of models) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed || dedupe.has(trimmed)) continue;
    dedupe.add(trimmed);
    normalized.push(trimmed);
    if (normalized.length >= 500) break;
  }

  if (normalized.length === 0) {
    return { ok: false, message: 'models 中没有有效模型名称' };
  }

  return {
    ok: true,
    models: normalized,
    refreshPricingCatalog: (input as { refreshPricingCatalog?: unknown }).refreshPricingCatalog === true,
    persistSnapshots: (input as { persistSnapshots?: unknown }).persistSnapshots === true,
  };
}

function parseBatchRouteDecisionRouteModels(
  input: unknown,
): { ok: true; items: Array<{ routeId: number; model: string }>; refreshPricingCatalog: boolean; persistSnapshots: boolean } | { ok: false; message: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, message: '请求体必须是对象' };
  }

  const items = (input as BatchRouteDecisionRouteModels).items;
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, message: 'items 必须是非空数组' };
  }

  const dedupe = new Set<string>();
  const normalized: Array<{ routeId: number; model: string }> = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const routeIdRaw = (item as { routeId?: unknown }).routeId;
    const modelRaw = (item as { model?: unknown }).model;
    if (typeof routeIdRaw !== 'number' || !Number.isFinite(routeIdRaw)) continue;
    if (typeof modelRaw !== 'string') continue;

    const routeId = Math.trunc(routeIdRaw);
    const model = modelRaw.trim();
    if (routeId <= 0 || !model) continue;

    const key = `${routeId}::${model}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    normalized.push({ routeId, model });
    if (normalized.length >= 500) break;
  }

  if (normalized.length === 0) {
    return { ok: false, message: 'items 中没有有效 routeId/model' };
  }

  return {
    ok: true,
    items: normalized,
    refreshPricingCatalog: (input as { refreshPricingCatalog?: unknown }).refreshPricingCatalog === true,
    persistSnapshots: (input as { persistSnapshots?: unknown }).persistSnapshots === true,
  };
}

function parseBatchRouteWideDecisionRouteIds(
  input: unknown,
): { ok: true; routeIds: number[]; refreshPricingCatalog: boolean; persistSnapshots: boolean } | { ok: false; message: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, message: '请求体必须是对象' };
  }

  const routeIds = (input as BatchRouteWideDecisionRouteIds).routeIds;
  if (!Array.isArray(routeIds) || routeIds.length === 0) {
    return { ok: false, message: 'routeIds 必须是非空数组' };
  }

  const dedupe = new Set<number>();
  const normalized: number[] = [];
  for (const raw of routeIds) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const routeId = Math.trunc(raw);
    if (routeId <= 0 || dedupe.has(routeId)) continue;
    dedupe.add(routeId);
    normalized.push(routeId);
    if (normalized.length >= 500) break;
  }

  if (normalized.length === 0) {
    return { ok: false, message: 'routeIds 中没有有效 routeId' };
  }

  return {
    ok: true,
    routeIds: normalized,
    refreshPricingCatalog: (input as { refreshPricingCatalog?: unknown }).refreshPricingCatalog === true,
    persistSnapshots: (input as { persistSnapshots?: unknown }).persistSnapshots === true,
  };
}

type RouteChannelSummary = {
  channelCount: number;
  enabledChannelCount: number;
  siteNames: Set<string>;
};

async function fetchChannelsForRouteRows(routes: RouteRow[]): Promise<Map<number, any[]>> {
  if (routes.length === 0) return new Map();

  const explicitSourceRouteIds = Array.from(new Set(routes
    .filter((route) => isExplicitGroupRoute(route))
    .flatMap((route) => route.sourceRouteIds)));
  const explicitSourceRoutes = explicitSourceRouteIds.length > 0
    ? (await db.select({
      id: schema.tokenRoutes.id,
      modelPattern: schema.tokenRoutes.modelPattern,
      routeMode: schema.tokenRoutes.routeMode,
      enabled: schema.tokenRoutes.enabled,
    }).from(schema.tokenRoutes)
      .where(inArray(schema.tokenRoutes.id, explicitSourceRouteIds))
      .all())
    : [];
  const enabledExplicitSourceRouteIds = explicitSourceRoutes
    .filter((route: any) => route.enabled && !isExplicitGroupRoute(route) && isExactModelPattern(route.modelPattern))
    .map((route: any) => route.id);
  const actualRouteIds = Array.from(new Set([
    ...routes.filter((route) => !isExplicitGroupRoute(route)).map((route) => route.id),
    ...enabledExplicitSourceRouteIds,
  ]));
  if (actualRouteIds.length === 0) {
    return new Map(routes.map((route) => [route.id, []]));
  }

  const actualRouteById = new Map<number, { modelPattern: string; routeMode: string | null }>();
  for (const route of routes.filter((item) => !isExplicitGroupRoute(item))) {
    actualRouteById.set(route.id, { modelPattern: route.modelPattern, routeMode: route.routeMode ?? null });
  }
  for (const route of explicitSourceRoutes) {
    actualRouteById.set(route.id, { modelPattern: route.modelPattern, routeMode: route.routeMode ?? null });
  }

  const channelRows = await db.select().from(schema.routeChannels)
    .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .leftJoin(schema.accountTokens, eq(schema.routeChannels.tokenId, schema.accountTokens.id))
    .where(inArray(schema.routeChannels.routeId, actualRouteIds))
    .all();

  const channelsByActualRouteId = new Map<number, any[]>();

  for (const row of channelRows) {
    const routeId = row.route_channels.routeId;
    const actualRoute = actualRouteById.get(routeId);
    const fallbackSourceModel = actualRoute && !isExplicitGroupRoute(actualRoute) && isExactModelPattern(actualRoute.modelPattern)
      ? actualRoute.modelPattern
      : null;
    const resolvedSourceModel = (row.route_channels.sourceModel || fallbackSourceModel || '').trim();
    if (!channelsByActualRouteId.has(routeId)) channelsByActualRouteId.set(routeId, []);
    channelsByActualRouteId.get(routeId)!.push({
      ...row.route_channels,
      sourceModel: resolvedSourceModel || null,
      account: row.accounts,
      site: row.sites,
      token: row.account_tokens
        ? {
          id: row.account_tokens.id,
          name: row.account_tokens.name,
          accountId: row.account_tokens.accountId,
          enabled: row.account_tokens.enabled,
          isDefault: row.account_tokens.isDefault,
        }
        : null,
    });
  }

  const channelsByRoute = new Map<number, any[]>();
  for (const route of routes) {
    if (isExplicitGroupRoute(route)) {
      channelsByRoute.set(route.id, route.sourceRouteIds.flatMap((sourceRouteId) => channelsByActualRouteId.get(sourceRouteId) || []));
      continue;
    }
    channelsByRoute.set(route.id, channelsByActualRouteId.get(route.id) || []);
  }

  return channelsByRoute;
}

async function fetchChannelsForRoutes(routeIds: number[]): Promise<Map<number, any[]>> {
  if (routeIds.length === 0) return new Map();
  return await fetchChannelsForRouteRows(await listRoutesWithSources()).then((channelsByRoute) => {
    const filtered = new Map<number, any[]>();
    for (const routeId of routeIds) {
      filtered.set(routeId, channelsByRoute.get(routeId) || []);
    }
    return filtered;
  });
}

async function buildRouteChannelSummaryMap(routes: RouteRow[]): Promise<Map<number, RouteChannelSummary>> {
  const channelsByRoute = await fetchChannelsForRouteRows(routes);
  const summaryByRoute = new Map<number, RouteChannelSummary>();
  for (const route of routes) {
    const channels = channelsByRoute.get(route.id) || [];
    const siteNames = new Set<string>();
    let enabledChannelCount = 0;
    for (const channel of channels) {
      if (channel.enabled) enabledChannelCount += 1;
      if (channel.site?.name) siteNames.add(channel.site.name);
    }
    summaryByRoute.set(route.id, {
      channelCount: channels.length,
      enabledChannelCount,
      siteNames,
    });
  }
  return summaryByRoute;
}

export async function tokensRoutes(app: FastifyInstance) {
  // List routes with basic info only (lightweight for selectors)
  app.get('/api/routes/lite', async () => {
    return (await listRoutesWithSources()).map((route) => ({
      id: route.id,
      modelPattern: route.modelPattern,
      displayName: route.displayName,
      displayIcon: route.displayIcon,
      routeMode: route.routeMode,
      sourceRouteIds: route.sourceRouteIds,
      routingStrategy: route.routingStrategy,
      enabled: route.enabled,
    }));
  });

  // Route summary (no channel details) for first-screen rendering
  app.get('/api/routes/summary', async () => {
    const routes = await listRoutesWithSources();
    if (routes.length === 0) return [];
    const aggByRoute = await buildRouteChannelSummaryMap(routes);

    return routes.map((route) => {
      const agg = aggByRoute.get(route.id);
      return {
        id: route.id,
        modelPattern: route.modelPattern,
        displayName: route.displayName ?? null,
        displayIcon: route.displayIcon ?? null,
        routeMode: route.routeMode,
        sourceRouteIds: route.sourceRouteIds,
        modelMapping: route.modelMapping ?? null,
        routingStrategy: route.routingStrategy ?? 'weighted',
        enabled: route.enabled,
        channelCount: agg?.channelCount ?? 0,
        enabledChannelCount: agg?.enabledChannelCount ?? 0,
        siteNames: agg ? Array.from(agg.siteNames) : [],
        decisionSnapshot: parseRouteDecisionSnapshot(route.decisionSnapshot),
        decisionRefreshedAt: route.decisionRefreshedAt ?? null,
      };
    });
  });

  // Get channels for a single route (on-demand loading)
  app.get<{ Params: { id: string } }>('/api/routes/:id/channels', async (request, reply) => {
    const routeId = parseInt(request.params.id, 10);
    const route = await getRouteWithSources(routeId);
    if (!route) {
      return reply.code(404).send({ success: false, message: '路由不存在' });
    }
    const channelsByRoute = await fetchChannelsForRouteRows([route]);
    return channelsByRoute.get(routeId) || [];
  });

  // Batch add channels to a route
  app.post<{ Params: { id: string }; Body: { channels: Array<{ accountId: number; tokenId?: number | null; sourceModel?: string }> } }>('/api/routes/:id/channels/batch', async (request, reply) => {
    const routeId = parseInt(request.params.id, 10);
    const body = request.body;

    const route = await getRouteWithSources(routeId);
    if (!route) {
      return reply.code(404).send({ success: false, message: '路由不存在' });
    }
    if (isExplicitGroupRoute(route)) {
      return reply.code(400).send({ success: false, message: '显式群组不支持直接维护通道' });
    }

    if (!body?.channels || !Array.isArray(body.channels) || body.channels.length === 0) {
      return reply.code(400).send({ success: false, message: 'channels 必须是非空数组' });
    }
    for (const item of body.channels) {
      if (!isPositiveInteger(item?.accountId)) {
        return reply.code(400).send({ success: false, message: 'channels[].accountId 必须是大于 0 的数字' });
      }
    }

    const existingChannels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, routeId))
      .all();
    const existingPairs = new Set<string>(
      existingChannels.map((channel: any) => {
        const tokenId = typeof channel.tokenId === 'number' && Number.isFinite(channel.tokenId) ? channel.tokenId : 0;
        const sourceModel = (channel.sourceModel || '').trim().toLowerCase();
        return `${channel.accountId}::${tokenId}::${sourceModel}`;
      }),
    );

    let created = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const item of body.channels) {
      const sourceModel = typeof item.sourceModel === 'string'
        ? item.sourceModel.trim()
        : (isExactModelPattern(route.modelPattern) ? route.modelPattern.trim() : '');
      const binding = await resolveRouteChannelBinding({
        accountId: item.accountId,
        rawTokenId: item.tokenId,
        allowImplicitDefault: true,
      });
      if (!binding.ok) {
        errors.push(binding.message);
        continue;
      }

      if (isExactModelPattern(route.modelPattern)) {
        if (binding.effectiveTokenId) {
          if (!await tokenSupportsModel(binding.effectiveTokenId, route.modelPattern)) {
            errors.push(`令牌 ${binding.effectiveTokenId} 不支持模型 ${route.modelPattern}`);
            continue;
          }
        } else if (!await accountSupportsModel(binding.account.id, route.modelPattern)) {
          errors.push(`账号 ${binding.account.id} 的主凭证不支持模型 ${route.modelPattern}`);
          continue;
        }
      }

      const tokenIdForKey = typeof binding.storedTokenId === 'number' && Number.isFinite(binding.storedTokenId) ? binding.storedTokenId : 0;
      const pairKey = `${item.accountId}::${tokenIdForKey}::${sourceModel.toLowerCase()}`;
      if (existingPairs.has(pairKey)) {
        skipped += 1;
        continue;
      }

      try {
        await db.insert(schema.routeChannels).values({
          routeId,
          accountId: item.accountId,
          tokenId: binding.storedTokenId,
          sourceModel: sourceModel || null,
          priority: 0,
          weight: 10,
          manualOverride: true,
        }).run();
        existingPairs.add(pairKey);
        created += 1;
      } catch (e: any) {
        errors.push(e.message || `添加通道失败: accountId=${item.accountId}`);
      }
    }

    if (created > 0) {
      await clearRouteDecisionSnapshot(routeId);
      await clearDependentExplicitGroupSnapshotsBySourceRouteIds([routeId]);
      invalidateTokenRouterCache();
    }

    return { success: true, created, skipped, errors };
  });

  // List all routes
  app.get('/api/routes', async () => {
    const routes = await listRoutesWithSources();
    if (routes.length === 0) return [];

    const channelsByRoute = await fetchChannelsForRouteRows(routes);

    return routes.map((route) => ({
      ...route,
      decisionSnapshot: parseRouteDecisionSnapshot(route.decisionSnapshot),
      decisionRefreshedAt: route.decisionRefreshedAt ?? null,
      channels: channelsByRoute.get(route.id) || [],
    }));
  });

  app.get<{ Querystring: { model?: string } }>('/api/routes/decision', async (request, reply) => {
    const model = (request.query.model || '').trim();
    if (!model) {
      return reply.code(400).send({ success: false, message: 'model 不能为空' });
    }

    const decision = await tokenRouter.explainSelection(model);
    return { success: true, decision };
  });

  app.post<{ Body: BatchRouteDecisionModels }>('/api/routes/decision/batch', async (request, reply) => {
    const parsed = parseBatchRouteDecisionModels(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({ success: false, message: parsed.message });
    }

    const decisions: Record<string, Awaited<ReturnType<typeof tokenRouter.explainSelection>>> = {};
    const routes = parsed.persistSnapshots
      ? await db.select({
        id: schema.tokenRoutes.id,
        modelPattern: schema.tokenRoutes.modelPattern,
      }).from(schema.tokenRoutes).all()
      : [];
    const refreshedKeys = parsed.refreshPricingCatalog ? new Set<string>() : undefined;
    for (const model of parsed.models) {
      if (parsed.refreshPricingCatalog) {
        await tokenRouter.refreshPricingReferenceCosts(model, { refreshedKeys });
      }
      decisions[model] = await tokenRouter.explainSelection(model);
    }

    if (parsed.persistSnapshots) {
      const snapshotWrites: Array<{ routeId: number; snapshot: unknown }> = [];
      for (const model of parsed.models) {
        const decision = decisions[model];
        for (const route of routes) {
          if (!isExactModelPattern(route.modelPattern)) continue;
          if (!matchesModelPattern(model, route.modelPattern)) continue;
          snapshotWrites.push({ routeId: route.id, snapshot: decision });
        }
      }
      await saveRouteDecisionSnapshots(snapshotWrites);
    }

    return { success: true, decisions };
  });

  app.post<{ Body: BatchRouteDecisionRouteModels }>('/api/routes/decision/by-route/batch', async (request, reply) => {
    const parsed = parseBatchRouteDecisionRouteModels(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({ success: false, message: parsed.message });
    }

    const decisions: Record<string, Record<string, Awaited<ReturnType<typeof tokenRouter.explainSelectionForRoute>>>> = {};
    const refreshedKeys = parsed.refreshPricingCatalog ? new Set<string>() : undefined;
    for (const item of parsed.items) {
      const routeKey = String(item.routeId);
      if (!decisions[routeKey]) decisions[routeKey] = {};
      if (parsed.refreshPricingCatalog) {
        await tokenRouter.refreshPricingReferenceCostsForRoute(item.routeId, item.model, { refreshedKeys });
      }
      decisions[routeKey][item.model] = await tokenRouter.explainSelectionForRoute(item.routeId, item.model);
    }

    if (parsed.persistSnapshots) {
      await saveRouteDecisionSnapshots(parsed.items.map((item) => ({
        routeId: item.routeId,
        snapshot: decisions[String(item.routeId)]?.[item.model] ?? null,
      })));
    }

    return { success: true, decisions };
  });

  app.post<{ Body: BatchRouteWideDecisionRouteIds }>('/api/routes/decision/route-wide/batch', async (request, reply) => {
    const parsed = parseBatchRouteWideDecisionRouteIds(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({ success: false, message: parsed.message });
    }

    const decisions: Record<string, Awaited<ReturnType<typeof tokenRouter.explainSelectionRouteWide>>> = {};
    const refreshedKeys = parsed.refreshPricingCatalog ? new Set<string>() : undefined;
    for (const routeId of parsed.routeIds) {
      if (parsed.refreshPricingCatalog) {
        await tokenRouter.refreshRouteWidePricingReferenceCosts(routeId, { refreshedKeys });
      }
      decisions[String(routeId)] = await tokenRouter.explainSelectionRouteWide(routeId);
    }

    if (parsed.persistSnapshots) {
      await saveRouteDecisionSnapshots(parsed.routeIds.map((routeId) => ({
        routeId,
        snapshot: decisions[String(routeId)] ?? null,
      })));
    }

    return { success: true, decisions };
  });

  // Create a route
  app.post<{ Body: { routeMode?: string; modelPattern?: string; displayName?: string; displayIcon?: string; modelMapping?: string; routingStrategy?: string; enabled?: boolean; sourceRouteIds?: number[] } }>('/api/routes', async (request, reply) => {
    const body = request.body;
    const displayNameValidation = validateOptionalDisplayName(body.displayName);
    if (!displayNameValidation.ok) {
      return reply.code(400).send({ success: false, message: displayNameValidation.message });
    }
    const sourceRouteIdsValidation = validateOptionalSourceRouteIds(body.sourceRouteIds);
    if (!sourceRouteIdsValidation.ok) {
      return reply.code(400).send({ success: false, message: sourceRouteIdsValidation.message });
    }
    const enabledValidation = validateOptionalBooleanField(body.enabled, 'enabled');
    if (!enabledValidation.ok) {
      return reply.code(400).send({ success: false, message: enabledValidation.message });
    }
    const routeMode = normalizeRouteMode(body.routeMode);
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    const sourceRouteIds = normalizeSourceRouteIdsInput(body.sourceRouteIds);
    const normalizedRoutingStrategy = normalizeRouteRoutingStrategy(body.routingStrategy);
    const modelPattern = routeMode === 'explicit_group'
      ? displayName
      : (typeof body.modelPattern === 'string' ? body.modelPattern.trim() : '');

    if (routeMode === 'explicit_group') {
      if (!displayName) {
        return reply.code(400).send({ success: false, message: '显式群组必须填写对外模型名' });
      }
      const validation = await validateExplicitGroupSourceRoutes(sourceRouteIds);
      if (!validation.ok) {
        return reply.code(400).send({ success: false, message: validation.message });
      }
    } else if (!modelPattern) {
      return reply.code(400).send({ success: false, message: '模型匹配不能为空' });
    }

    const insertedRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern,
      displayName: displayName || body.displayName,
      displayIcon: body.displayIcon,
      routeMode,
      modelMapping: body.modelMapping,
      routingStrategy: normalizedRoutingStrategy,
      enabled: body.enabled ?? true,
    }).run();
    const routeId = requireInsertedRowId(insertedRoute, '创建路由失败');
    const route = await getRouteWithSources(routeId);
    if (!route) {
      return { success: false, message: '创建路由失败' };
    }

    if (routeMode === 'explicit_group') {
      await replaceRouteSourceRouteIds(route.id, sourceRouteIds);
      const syncedRouteIds = await syncExplicitGroupSourceRouteStrategies({
        groupRouteId: route.id,
        sourceRouteIds,
        targetStrategy: normalizedRoutingStrategy,
      });
      if (syncedRouteIds.length > 0) {
        await clearRouteDecisionSnapshots(syncedRouteIds);
        await clearDependentExplicitGroupSnapshotsBySourceRouteIds(syncedRouteIds);
      }
    } else {
      await populateRouteChannelsByModelPattern(route.id, modelPattern);
    }
    invalidateTokenRouterCache();
    return await getRouteWithSources(routeId);
  });

  // Update a route
  app.put<{ Params: { id: string }; Body: any }>('/api/routes/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const body = request.body as Record<string, unknown>;
    const existingRoute = await getRouteWithSources(id);
    if (!existingRoute) {
      return reply.code(404).send({ success: false, message: '路由不存在' });
    }
    const displayNameValidation = validateOptionalDisplayName(body.displayName);
    if (!displayNameValidation.ok) {
      return reply.code(400).send({ success: false, message: displayNameValidation.message });
    }
    const sourceRouteIdsValidation = validateOptionalSourceRouteIds(body.sourceRouteIds);
    if (!sourceRouteIdsValidation.ok) {
      return reply.code(400).send({ success: false, message: sourceRouteIdsValidation.message });
    }
    const enabledValidation = validateOptionalBooleanField(body.enabled, 'enabled');
    if (!enabledValidation.ok) {
      return reply.code(400).send({ success: false, message: enabledValidation.message });
    }
    const routeMode = normalizeRouteMode(body.routeMode ?? existingRoute.routeMode);
    if (routeMode !== existingRoute.routeMode) {
      return reply.code(400).send({ success: false, message: '暂不支持在不同群组模式之间直接切换' });
    }

    const updates: Record<string, unknown> = {};
    let nextModelPattern = existingRoute.modelPattern;
    let nextDisplayName = existingRoute.displayName ?? '';
    let nextSourceRouteIds = existingRoute.sourceRouteIds;
    const previousRoutingStrategy = normalizeRouteRoutingStrategy(existingRoute.routingStrategy);
    let nextRoutingStrategy = previousRoutingStrategy;

    if (body.displayName !== undefined) {
      nextDisplayName = String(body.displayName || '').trim();
      updates.displayName = nextDisplayName || null;
    }
    if (body.displayIcon !== undefined) updates.displayIcon = body.displayIcon;
    if (routeMode === 'explicit_group') {
      nextModelPattern = nextDisplayName;
      updates.modelPattern = nextModelPattern;
      if (body.sourceRouteIds !== undefined) {
        nextSourceRouteIds = normalizeSourceRouteIdsInput(body.sourceRouteIds);
      }
      if (!nextDisplayName) {
        return reply.code(400).send({ success: false, message: '显式群组必须填写对外模型名' });
      }
      const validation = await validateExplicitGroupSourceRoutes(nextSourceRouteIds, id);
      if (!validation.ok) {
        return reply.code(400).send({ success: false, message: validation.message });
      }
    } else if (body.modelPattern !== undefined) {
      nextModelPattern = String(body.modelPattern);
      updates.modelPattern = nextModelPattern;
    }
    if (body.modelMapping !== undefined) updates.modelMapping = body.modelMapping;
    if (body.routingStrategy !== undefined) {
      nextRoutingStrategy = normalizeRouteRoutingStrategy(body.routingStrategy);
      updates.routingStrategy = nextRoutingStrategy;
    }
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    if (body.routeMode !== undefined) updates.routeMode = routeMode;
    updates.updatedAt = new Date().toISOString();

    await db.update(schema.tokenRoutes).set(updates).where(eq(schema.tokenRoutes.id, id)).run();
    if (routeMode === 'explicit_group' && body.sourceRouteIds !== undefined) {
      await replaceRouteSourceRouteIds(id, nextSourceRouteIds);
    }
    const shouldSyncExplicitGroupSources = (
      routeMode === 'explicit_group'
      && (body.routingStrategy !== undefined || body.sourceRouteIds !== undefined)
    );
    let syncedSourceRouteIds: number[] = [];
    if (shouldSyncExplicitGroupSources) {
      syncedSourceRouteIds = await syncExplicitGroupSourceRouteStrategies({
        groupRouteId: id,
        sourceRouteIds: nextSourceRouteIds,
        targetStrategy: nextRoutingStrategy,
        previousStrategy: previousRoutingStrategy,
      });
    }
    const modelPatternChanged = nextModelPattern !== existingRoute.modelPattern;
    const routeBehaviorChanged = modelPatternChanged
      || (routeMode === 'explicit_group' && body.sourceRouteIds !== undefined)
      || body.modelMapping !== undefined
      || body.routingStrategy !== undefined
      || body.enabled !== undefined;
    if (routeMode === 'pattern' && modelPatternChanged) {
      await rebuildAutomaticRouteChannelsByModelPattern(id, nextModelPattern);
    }
    if (routeBehaviorChanged) {
      await clearRouteDecisionSnapshot(id);
      await clearDependentExplicitGroupSnapshotsBySourceRouteIds([id]);
    }
    if (syncedSourceRouteIds.length > 0) {
      await clearRouteDecisionSnapshots(syncedSourceRouteIds);
      await clearDependentExplicitGroupSnapshotsBySourceRouteIds(syncedSourceRouteIds);
    }
    invalidateTokenRouterCache();
    return await getRouteWithSources(id);
  });

  // Delete a route
  app.delete<{ Params: { id: string } }>('/api/routes/:id', async (request) => {
    const id = parseInt(request.params.id, 10);
    await clearDependentExplicitGroupSnapshotsBySourceRouteIds([id]);
    await db.delete(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, id)).run();
    invalidateTokenRouterCache();
    return { success: true };
  });


  // Batch update routes (enable/disable)
  app.post<{ Body: { ids: number[]; action: 'enable' | 'disable' } }>('/api/routes/batch', async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ success: false, message: '请求体必须是对象' });
    }
    const action = body.action;
    if (action !== 'enable' && action !== 'disable') {
      return reply.code(400).send({ success: false, message: 'action 必须是 enable 或 disable' });
    }
    const rawIds = body.ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return reply.code(400).send({ success: false, message: 'ids 必须是非空数组' });
    }
    const dedupe = new Set<number>();
    const ids: number[] = [];
    for (const raw of rawIds) {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
      const id = Math.trunc(raw);
      if (id <= 0 || dedupe.has(id)) continue;
      dedupe.add(id);
      ids.push(id);
      if (ids.length >= 500) break;
    }
    if (ids.length === 0) {
      return reply.code(400).send({ success: false, message: 'ids 中没有有效的路由 ID' });
    }

    const enabled = action === 'enable';
    const now = new Date().toISOString();
    const updateResult = await db.update(schema.tokenRoutes)
      .set({ enabled, updatedAt: now })
      .where(inArray(schema.tokenRoutes.id, ids))
      .run();

    await clearRouteDecisionSnapshots(ids);
    await clearDependentExplicitGroupSnapshotsBySourceRouteIds(ids);
    invalidateTokenRouterCache();

    return { success: true, updatedCount: Number(updateResult?.changes || 0) };
  });
  // Add a channel to a route
  app.post<{ Params: { id: string }; Body: { accountId: number; tokenId?: number | null; sourceModel?: string; priority?: number; weight?: number } }>('/api/routes/:id/channels', async (request, reply) => {
    const routeId = parseInt(request.params.id, 10);
    const body = request.body;

    const route = await getRouteWithSources(routeId);
    if (!route) {
      return reply.code(404).send({ success: false, message: '路由不存在' });
    }
    if (isExplicitGroupRoute(route)) {
      return reply.code(400).send({ success: false, message: '显式群组不支持直接维护通道' });
    }
    if (!isPositiveInteger(body.accountId)) {
      return reply.code(400).send({ success: false, message: 'accountId 必须是大于 0 的数字' });
    }
    const sourceModel = typeof body.sourceModel === 'string'
      ? body.sourceModel.trim()
      : (isExactModelPattern(route.modelPattern) ? route.modelPattern.trim() : '');
    const binding = await resolveRouteChannelBinding({
      accountId: body.accountId,
      rawTokenId: body.tokenId,
      allowImplicitDefault: true,
    });
    if (!binding.ok) {
      return reply.code(400).send({ success: false, message: binding.message });
    }

    if (isExactModelPattern(route.modelPattern)) {
      if (binding.effectiveTokenId) {
        if (!await tokenSupportsModel(binding.effectiveTokenId, route.modelPattern)) {
          return reply.code(400).send({ success: false, message: '该令牌不支持当前模型' });
        }
      } else if (!await accountSupportsModel(binding.account.id, route.modelPattern)) {
        return reply.code(400).send({ success: false, message: '该账号主凭证不支持当前模型' });
      }
    }

    const duplicate = (await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, routeId))
      .all())
      .some((channel: any) =>
        channel.accountId === body.accountId
        && (channel.tokenId ?? null) === (binding.storedTokenId ?? null)
        && (channel.sourceModel || '').trim().toLowerCase() === sourceModel.toLowerCase(),
      );
    if (duplicate) {
      return reply.code(400).send({ success: false, message: '该来源模型的通道已存在' });
    }

    const insertedChannel = await db.insert(schema.routeChannels).values({
      routeId,
      accountId: body.accountId,
      tokenId: binding.storedTokenId,
      sourceModel: sourceModel || null,
      priority: typeof body.priority === 'number' && Number.isFinite(body.priority) ? Math.max(0, Math.trunc(body.priority)) : 0,
      weight: typeof body.weight === 'number' && Number.isFinite(body.weight) ? Math.max(0, Math.min(1000, Math.trunc(body.weight))) : 10,
    }).run();
    const channelId = requireInsertedRowId(insertedChannel, '创建通道失败');
    const created = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, channelId)).get();
    if (!created) {
      return reply.code(500).send({ success: false, message: '创建通道失败' });
    }
    await clearRouteDecisionSnapshot(routeId);
    await clearDependentExplicitGroupSnapshotsBySourceRouteIds([routeId]);
    invalidateTokenRouterCache();
    return created;
  });

  // Batch update channel priorities
  app.put<{ Body: { updates: Array<{ id: number; priority: number }> } }>('/api/channels/batch', async (request, reply) => {
    const parsed = parseBatchChannelUpdates(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({ success: false, message: parsed.message });
    }

    const channelIds = Array.from(new Set(parsed.updates.map((update) => update.id)));
    const existingChannels = await db.select().from(schema.routeChannels)
      .where(inArray(schema.routeChannels.id, channelIds))
      .all();
    if (existingChannels.length !== channelIds.length) {
      const existingIds = new Set(existingChannels.map((channel: any) => channel.id));
      const missingId = channelIds.find((id) => !existingIds.has(id));
      return reply.code(404).send({ success: false, message: `通道不存在: ${missingId}` });
    }

    const existingChannelById = new Map<number, typeof existingChannels[number]>(
      existingChannels.map((channel: any) => [channel.id, channel]),
    );
    const updatesByRouteId = new Map<number, Array<{ id: number; priority: number }>>();
    for (const update of parsed.updates) {
      const routeId = existingChannelById.get(update.id)?.routeId;
      if (!routeId) continue;
      if (!updatesByRouteId.has(routeId)) updatesByRouteId.set(routeId, []);
      updatesByRouteId.get(routeId)!.push(update);
    }

    const updatedChannels: Array<typeof schema.routeChannels.$inferSelect> = [];
    for (const [routeId, updates] of updatesByRouteId.entries()) {
      const routeChannels = existingChannels.filter((channel: any) => channel.routeId === routeId);
      const result = await applyChannelPriorityUpdates({ existingChannels: routeChannels, updates });
      updatedChannels.push(...result);
    }
    return { success: true, channels: updatedChannels };
  });

  app.post<{ Params: { channelId: string } }>('/api/channels/:channelId/probe', async (request, reply) => {
    const channelId = parseInt(request.params.channelId, 10);
    if (!Number.isFinite(channelId) || channelId <= 0) {
      return reply.code(400).send({ success: false, message: '无效的通道 ID' });
    }

    const entry = await loadChannelProbeEntry(channelId);
    if (!entry) {
      return reply.code(404).send({ success: false, message: '通道不存在' });
    }

    const result = await probeChannelEntry(entry);
    if (result.status === 'supported' && entry.candidate) {
      await tokenRouter.recordProbeSuccess(entry.channelId, entry.candidate.modelName);
    }
    return { success: true, result };
  });

  app.post<{ Params: { routeId: string }; Body?: { timeoutMs?: number; concurrency?: number } }>(
    '/api/routes/:routeId/channels/probe',
    async (request, reply) => {
    const routeId = parseInt(request.params.routeId, 10);
    if (!Number.isFinite(routeId) || routeId <= 0) {
      return reply.code(400).send({ success: false, message: '无效的路由 ID' });
    }

    const route = await getRouteWithSources(routeId);
    if (!route) {
      return reply.code(404).send({ success: false, message: '路由不存在' });
    }
    if (isExplicitGroupRoute(route)) {
      return reply.code(400).send({ success: false, message: '显式群组不支持批量探活排序' });
    }

    const entries = await loadRouteChannelProbeEntries(routeId);
    if (entries.length === 0) {
      return reply.code(400).send({ success: false, message: '该路由暂无可探活通道' });
    }

    const probeController = new AbortController();
    request.raw.on('close', () => probeController.abort());
    const timeoutMs = Math.max(5_000, Math.min(60_000, Number(request.body?.timeoutMs || 30_000)));
    const concurrency = Math.max(1, Math.min(10, Math.trunc(Number(request.body?.concurrency || 5))));

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    reply.raw.flushHeaders?.();
    reply.raw.write(`data: ${JSON.stringify({ type: 'start', totalCount: entries.length })}\n\n`);

    await probeRouteChannelEntries(entries, {
      concurrency,
      signal: probeController.signal,
      timeoutMs,
      onResult: async ({ channelId, result }) => {
        if (result.status === 'supported') {
          await tokenRouter.recordProbeSuccess(channelId, result.modelName || null);
        }
        if (probeController.signal.aborted) return;
        reply.raw.write(`data: ${JSON.stringify({
          type: 'result',
          channelId,
          status: result.status,
          ttftMs: result.ttftMs,
          httpStatus: result.httpStatus,
          error: result.error,
        })}\n\n`);
      },
    });

    if (!probeController.signal.aborted) {
      reply.raw.write('data: [DONE]\n\n');
    }
    reply.raw.end();
    return reply;
    },
  );

  app.post<{ Params: { routeId: string }; Body: { ranking?: ProbeRankingPayloadItem[] } }>(
    '/api/routes/:routeId/channels/apply-probe-ranking',
    async (request, reply) => {
      const routeId = parseInt(request.params.routeId, 10);
      if (!Number.isFinite(routeId) || routeId <= 0) {
        return reply.code(400).send({ success: false, message: '无效的路由 ID' });
      }

      const route = await getRouteWithSources(routeId);
      if (!route) {
        return reply.code(404).send({ success: false, message: '路由不存在' });
      }
      if (isExplicitGroupRoute(route)) {
        return reply.code(400).send({ success: false, message: '显式群组不支持探活排序' });
      }

      const parsed = parseApplyProbeRankingInput(request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ success: false, message: parsed.message });
      }

      const enabledChannels = await db.select().from(schema.routeChannels)
        .where(and(
          eq(schema.routeChannels.routeId, routeId),
          eq(schema.routeChannels.enabled, true),
        ))
        .all();
      if (enabledChannels.length === 0) {
        return reply.code(400).send({ success: false, message: '该路由暂无可排序通道' });
      }

      const enabledChannelIds = enabledChannels.map((channel: any) => Number(channel.id));
      const enabledChannelIdSet = new Set<number>(enabledChannelIds);
      const submittedChannelIds: number[] = parsed.ranking.map((item) => item.channelId);
      const submittedChannelIdSet = new Set<number>(submittedChannelIds);

      const foreignChannelId = submittedChannelIds.find((channelId) => !enabledChannelIdSet.has(channelId));
      if (foreignChannelId) {
        return reply.code(400).send({ success: false, message: `通道 ${foreignChannelId} 不属于该路由` });
      }
      if (submittedChannelIdSet.size !== enabledChannelIdSet.size) {
        return reply.code(400).send({ success: false, message: '通道列表已变更，请重新探活' });
      }
      for (const channelId of enabledChannelIdSet) {
        if (!submittedChannelIdSet.has(channelId)) {
          return reply.code(400).send({ success: false, message: '通道列表已变更，请重新探活' });
        }
      }

      const updates = buildProbeRankingUpdates(enabledChannels, parsed.ranking);
      const result = await applyChannelPriorityUpdates({ existingChannels: enabledChannels, updates });
      return {
        success: true,
        updatedCount: result.length,
      };
    },
  );

  // Update a channel
  app.put<{ Params: { channelId: string }; Body: any }>('/api/channels/:channelId', async (request, reply) => {
    const channelId = parseInt(request.params.channelId, 10);
    const body = request.body as Record<string, unknown>;

    const channel = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, channelId)).get();
    if (!channel) {
      return reply.code(404).send({ success: false, message: '通道不存在' });
    }

    const route = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, channel.routeId)).get();
    if (!route) {
      return reply.code(404).send({ success: false, message: '路由不存在' });
    }
    const enabledValidation = validateOptionalBooleanField(body.enabled, 'enabled');
    if (!enabledValidation.ok) {
      return reply.code(400).send({ success: false, message: enabledValidation.message });
    }

    const binding = body.tokenId === undefined
      ? null
      : await resolveRouteChannelBinding({
        accountId: channel.accountId,
        rawTokenId: body.tokenId,
        allowImplicitDefault: true,
      });
    if (binding && !binding.ok) {
      return reply.code(400).send({ success: false, message: binding.message });
    }

    const nextTokenId = binding ? binding.effectiveTokenId : channel.tokenId;

    // Only validate model support when the token is actually being changed
    const tokenChanged = body.tokenId !== undefined && nextTokenId !== channel.tokenId;
    if (tokenChanged && isExactModelPattern(route.modelPattern)) {
      if (nextTokenId) {
        if (!await tokenSupportsModel(nextTokenId, route.modelPattern)) {
          return reply.code(400).send({ success: false, message: '该令牌不支持当前模型' });
        }
      } else if (binding?.ok && !await accountSupportsModel(binding.account.id, route.modelPattern)) {
        return reply.code(400).send({ success: false, message: '该账号主凭证不支持当前模型' });
      }
    }

    const updates: Record<string, unknown> = { manualOverride: true };
    if (body.sourceModel !== undefined) {
      if (body.sourceModel === null) updates.sourceModel = null;
      else updates.sourceModel = String(body.sourceModel).trim() || null;
    }

    if (body.priority !== undefined) {
      if (typeof body.priority !== 'number' || !Number.isFinite(body.priority)) {
        return reply.code(400).send({ success: false, message: 'priority 必须是有限数字' });
      }
      updates.priority = Math.max(0, Math.trunc(body.priority));
    }
    if (body.weight !== undefined) {
      if (typeof body.weight !== 'number' || !Number.isFinite(body.weight)) {
        return reply.code(400).send({ success: false, message: 'weight 必须是有限数字' });
      }
      updates.weight = Math.max(0, Math.min(1000, Math.trunc(body.weight)));
    }
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    if (body.tokenId !== undefined) {
      updates.tokenId = binding?.storedTokenId ?? null;
    }

    await db.update(schema.routeChannels).set(updates).where(eq(schema.routeChannels.id, channelId)).run();
    await clearRouteDecisionSnapshot(channel.routeId);
    await clearDependentExplicitGroupSnapshotsBySourceRouteIds([channel.routeId]);
    invalidateTokenRouterCache();
    return await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, channelId)).get();
  });

  // Delete a channel
  app.delete<{ Params: { channelId: string } }>('/api/channels/:channelId', async (request) => {
    const channelId = parseInt(request.params.channelId, 10);
    const channel = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, channelId)).get();
    await db.delete(schema.routeChannels).where(eq(schema.routeChannels.id, channelId)).run();
    if (channel) {
      await clearRouteDecisionSnapshot(channel.routeId);
      await clearDependentExplicitGroupSnapshotsBySourceRouteIds([channel.routeId]);
    }
    invalidateTokenRouterCache();
    return { success: true };
  });

  // Reset cooldown for a single channel
  app.post<{ Params: { channelId: string } }>('/api/channels/:channelId/reset-cooldown', async (request, reply) => {
    const channelId = parseInt(request.params.channelId, 10);
    if (!Number.isFinite(channelId) || channelId <= 0) {
      return reply.code(400).send({ success: false, message: '无效的通道 ID' });
    }

    const channel = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, channelId)).get();
    if (!channel) {
      return reply.code(404).send({ success: false, message: '通道不存在' });
    }

    await db.update(schema.routeChannels).set({
      cooldownUntil: null,
      cooldownLevel: 0,
      consecutiveFailCount: 0,
      lastFailAt: null,
    }).where(eq(schema.routeChannels.id, channelId)).run();

    await clearRouteDecisionSnapshot(channel.routeId);
    await clearDependentExplicitGroupSnapshotsBySourceRouteIds([channel.routeId]);
    invalidateTokenRouterCache();

    return { success: true, message: `已清除通道 ${channelId} 的冷却状态` };
  });

  app.post<{ Params: { id: string } }>('/api/routes/:id/cooldown/clear', async (request, reply) => {
    const routeId = parseInt(request.params.id, 10);
    if (!Number.isFinite(routeId) || routeId <= 0) {
      return reply.code(400).send({ success: false, message: '无效的路由 ID' });
    }

    const route = await getRouteWithSources(routeId);
    if (!route) {
      return reply.code(404).send({ success: false, message: '路由不存在' });
    }

    const actualRouteIds = await resolveCooldownClearRouteIds(route);
    const channelRows = actualRouteIds.length > 0
      ? await db.select({
        id: schema.routeChannels.id,
        routeId: schema.routeChannels.routeId,
        siteId: schema.accounts.siteId,
        sourceModel: schema.routeChannels.sourceModel,
        routeModelPattern: schema.tokenRoutes.modelPattern,
      }).from(schema.routeChannels)
        .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
        .innerJoin(schema.tokenRoutes, eq(schema.routeChannels.routeId, schema.tokenRoutes.id))
        .where(inArray(schema.routeChannels.routeId, actualRouteIds))
        .all()
      : [];

    const channelIds = channelRows.map((row: any) => row.id);
    if (channelIds.length > 0) {
      await db.update(schema.routeChannels).set({
        cooldownUntil: null,
        cooldownLevel: 0,
        consecutiveFailCount: 0,
        lastFailAt: null,
      }).where(inArray(schema.routeChannels.id, channelIds)).run();

      await clearSiteModelRuntimeHealthForChannels(channelRows);
    }

    const affectedRouteIds: number[] = Array.from(new Set(
      channelRows
        .map((row: any) => row.routeId)
        .filter((id: any): id is number => Number.isFinite(id) && id > 0),
    ));
    await clearRouteDecisionSnapshot(route.id);
    if (affectedRouteIds.length > 0) {
      await clearRouteDecisionSnapshots(affectedRouteIds);
      await clearDependentExplicitGroupSnapshotsBySourceRouteIds(affectedRouteIds);
    }
    invalidateTokenRouterCache();

    return { success: true, clearedChannels: channelIds.length, message: '已清除路由冷却状态' };
  });

  // Reset all channel priorities for a route to 0 (weight-based scheduling)
  app.post<{ Params: { id: string } }>('/api/routes/:id/channels/reset-priority', async (request, reply) => {
    const routeId = parseInt(request.params.id, 10);
    if (!Number.isFinite(routeId) || routeId <= 0) {
      return reply.code(400).send({ success: false, message: '无效的路由 ID' });
    }

    const route = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, routeId)).get();
    if (!route) {
      return reply.code(404).send({ success: false, message: '路由不存在' });
    }

    // Set-based update: reset all channels under this route to priority 0
    const result = await db.update(schema.routeChannels)
      .set({ priority: 0 })
      .where(eq(schema.routeChannels.routeId, routeId))
      .run();

    await clearRouteDecisionSnapshot(routeId);
    await clearDependentExplicitGroupSnapshotsBySourceRouteIds([routeId]);
    invalidateTokenRouterCache();

    return { success: true, updatedCount: result.changes ?? 0 };
  });

  // Rebuild routes/channels from model availability.
  app.post<{ Body?: { refreshModels?: boolean; wait?: boolean } }>('/api/routes/rebuild', async (request, reply) => {
    const body = (request.body || {}) as { refreshModels?: boolean };
    if (body.refreshModels === false) {
      const rebuild = await routeRefreshWorkflow.rebuildRoutesOnly();
      return { success: true, rebuild };
    }

    if ((request.body as { wait?: boolean } | undefined)?.wait) {
      const result = await routeRefreshWorkflow.refreshModelsAndRebuildRoutes();
      return { success: true, ...result };
    }

    const { task, reused } = startBackgroundTask(
      {
        type: 'route',
        title: '刷新模型并重建路由',
        dedupeKey: 'refresh-models-and-rebuild-routes',
        notifyOnFailure: true,
        successMessage: (currentTask) => {
          const rebuild = (currentTask.result as any)?.rebuild;
          if (!rebuild) return '刷新模型并重建路由已完成';
          return `刷新模型并重建路由完成：新增路由 ${rebuild.createdRoutes}，移除旧路由 ${rebuild.removedRoutes ?? 0}，新增通道 ${rebuild.createdChannels}，移除通道 ${rebuild.removedChannels}`;
        },
        failureMessage: (currentTask) => `刷新模型并重建路由失败：${currentTask.error || 'unknown error'}`,
      },
      async () => routeRefreshWorkflow.refreshModelsAndRebuildRoutes(),
    );

    return reply.code(202).send({
      success: true,
      queued: true,
      reused,
      jobId: task.id,
      status: task.status,
      message: reused
        ? '路由重建任务执行中，请稍后查看程序日志'
        : '已开始路由重建，请稍后查看程序日志',
    });
  });

  // Reset runtime health penalties for a specific site
  app.post<{ Params: { siteId: string } }>('/api/sites/:siteId/reset-health', async (request, reply) => {
    const siteId = parseInt(request.params.siteId, 10);
    if (!Number.isFinite(siteId) || siteId <= 0) {
      return reply.code(400).send({ success: false, message: '无效的站点 ID' });
    }

    const site = await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).get();
    if (!site) {
      return reply.code(404).send({ success: false, message: '站点不存在' });
    }

    await resetSiteRuntimeHealthForSite(siteId);

    // Clear decision snapshots for routes that use this site so the UI reflects the reset
    const affectedRows = await db.select({ routeId: schema.routeChannels.routeId })
      .from(schema.routeChannels)
      .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
      .where(eq(schema.accounts.siteId, siteId))
      .all();
    const affectedRouteIds: number[] = Array.from(new Set(affectedRows.map((r: { routeId: number }) => r.routeId)));
    if (affectedRouteIds.length > 0) {
      await clearRouteDecisionSnapshots(affectedRouteIds);
      // Also clear snapshots for explicit_group routes that source from affected routes
      await clearDependentExplicitGroupSnapshotsBySourceRouteIds(affectedRouteIds);
    }
    invalidateTokenRouterCache();

    return { success: true, message: `已清除站点「${site.name || siteId}」的运行时健康惩罚及通道冷却` };
  });
}

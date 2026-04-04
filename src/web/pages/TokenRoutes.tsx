import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { arrayMove } from '@dnd-kit/sortable';
import type { DragEndEvent } from '@dnd-kit/core';
import { api } from '../api.js';
import { BrandGlyph, getBrand, InlineBrandIcon, type BrandInfo } from '../components/BrandIcon.js';
import { useToast } from '../components/Toast.js';
import ModernSelect from '../components/ModernSelect.js';
import { MobileCard, MobileField } from '../components/MobileCard.js';
import ResponsiveFilterPanel from '../components/ResponsiveFilterPanel.js';
import { useIsMobile } from '../components/useIsMobile.js';
import { tr } from '../i18n.js';
import {
  buildRouteModelCandidatesIndex,
  type DirectAccountCandidatesByModelName,
  type RouteCandidateView,
  type RouteModelCandidatesByModelName,
} from './helpers/routeModelCandidatesIndex.js';
import { getInitialVisibleCount, getNextVisibleCount } from './helpers/progressiveRender.js';
import {
  buildRouteMissingTokenIndex,
  normalizeMissingTokenModels,
  type MissingTokenModelsByName,
  type RouteMissingTokenHint,
} from './helpers/routeMissingTokenHints.js';
import {
  buildChannelFingerprint,
  clearAllRouteProbeSnapshots,
  isSnapshotStale,
  loadRouteProbeSnapshots,
  removeRouteProbeSnapshot,
  saveRouteProbeSnapshot,
} from './helpers/routeProbeSnapshotStore.js';
import { buildVisibleRouteList } from './helpers/routeListVisibility.js';
import { buildZeroChannelPlaceholderRoutes } from './helpers/zeroChannelRoutes.js';
import {
  getRouteRoutingStrategyLabel,
  normalizeRouteRoutingStrategyValue,
} from './token-routes/routingStrategy.js';

import type {
  ChannelProbeResult,
  RouteSortBy,
  RouteSortDir,
  GroupFilter,
  RouteSummaryRow,
  RouteProbeSession,
  RouteProbeSnapshot,
  RouteRoutingStrategy,
  RouteMode,
  RouteDecision,
  RouteIconOption,
  MissingTokenRouteSiteActionItem,
  MissingTokenGroupRouteSiteActionItem,
  GroupRouteItem,
} from './token-routes/types.js';
import {
  AUTO_ROUTE_DECISION_LIMIT,
  ROUTE_RENDER_CHUNK,
  isExactModelPattern,
  isExplicitGroupRoute,
  isRouteExactModel,
  matchesModelPattern,
  normalizeRouteMode,
  resolveRouteTitle,
  resolveRouteBrand,
  resolveRouteIcon,
  toBrandIconValue,
  normalizeRouteDisplayIconValue,
  inferEndpointTypesFromPlatform,
  getModelPatternError,
} from './token-routes/utils.js';
import { useRouteChannels } from './token-routes/useRouteChannels.js';
import RouteFilterBar, { type EnabledFilter } from './token-routes/RouteFilterBar.js';
import ManualRoutePanel from './token-routes/ManualRoutePanel.js';
import RouteCard from './token-routes/RouteCard.js';
import AddChannelModal from './token-routes/AddChannelModal.js';

const EMPTY_ROUTE_CANDIDATE_VIEW: RouteCandidateView = {
  routeCandidates: [],
  accountOptions: [],
  tokenOptionsByAccountId: {},
  directBindingOptionsByAccountId: {},
};
const EMPTY_MISSING_ITEMS: MissingTokenRouteSiteActionItem[] = [];
const EMPTY_MISSING_GROUP_ITEMS: MissingTokenGroupRouteSiteActionItem[] = [];
const ROUTE_ICON_OPTIONS: RouteIconOption[] = [
  { value: '', label: '自动品牌图标', description: '按模型匹配规则自动识别品牌', iconText: '✦' },
];

type RouteEditorForm = {
  routeMode: RouteMode;
  displayName: string;
  displayIcon: string;
  modelPattern: string;
  sourceRouteIds: number[];
  advancedOpen: boolean;
};

const EMPTY_ROUTE_FORM: RouteEditorForm = {
  routeMode: 'explicit_group',
  displayName: '',
  displayIcon: '',
  modelPattern: '',
  sourceRouteIds: [],
  advancedOpen: false,
};

function getRouteRoutingStrategySuccessMessage(value: RouteRoutingStrategy): string {
  if (value === 'round_robin') return '已切换为轮询策略';
  if (value === 'stable_first') return '已切换为稳定优先策略';
  return '已切换为权重随机策略';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isRouteProbeable(route: Pick<RouteSummaryRow, 'routeMode' | 'kind' | 'readOnly' | 'isVirtual'> | null | undefined): boolean {
  if (!route) return false;
  return !isExplicitGroupRoute(route) && route.kind !== 'zero_channel' && route.readOnly !== true && route.isVirtual !== true;
}

export default function TokenRoutes() {
  const navigate = useNavigate();
  const [routeSummaries, setRouteSummaries] = useState<RouteSummaryRow[]>([]);
  const [modelCandidates, setModelCandidates] = useState<RouteModelCandidatesByModelName>({});
  const [directAccountCandidates, setDirectAccountCandidates] = useState<DirectAccountCandidatesByModelName>({});
  const [missingTokenModelsByName, setMissingTokenModelsByName] = useState<MissingTokenModelsByName>({});
  const [missingTokenGroupModelsByName, setMissingTokenGroupModelsByName] = useState<MissingTokenModelsByName>({});
  const [endpointTypesByModel, setEndpointTypesByModel] = useState<Record<string, string[]>>({});

  const [search, setSearch] = useState('');
  const [activeBrand, setActiveBrand] = useState<string | null>(null);
  const [activeSite, setActiveSite] = useState<string | null>(null);
  const [activeEndpointType, setActiveEndpointType] = useState<string | null>(null);
  const [activeGroupFilter, setActiveGroupFilter] = useState<GroupFilter>(null);
  const [enabledFilter, setEnabledFilter] = useState<EnabledFilter>('all');
  const [filterCollapsed, setFilterCollapsed] = useState(true);
  const [showFilters, setShowFilters] = useState(false);
  const [showZeroChannelRoutes, setShowZeroChannelRoutes] = useState(false);
  const [sortBy, setSortBy] = useState<RouteSortBy>('channelCount');
  const [sortDir, setSortDir] = useState<RouteSortDir>('desc');

  const [showManual, setShowManual] = useState(false);
  const [form, setForm] = useState<RouteEditorForm>(EMPTY_ROUTE_FORM);
  const [editingRouteId, setEditingRouteId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [batchUpdatingRoutes, setBatchUpdatingRoutes] = useState(false);
  const [batchSelectMode, setBatchSelectMode] = useState(false);
  const [selectedRouteIds, setSelectedRouteIds] = useState<Set<number>>(new Set());


  const [updatingChannel, setUpdatingChannel] = useState<Record<number, boolean>>({});
  const [savingPriorityByRoute, setSavingPriorityByRoute] = useState<Record<number, boolean>>({});
  const [resettingPriorityByRoute, setResettingPriorityByRoute] = useState<Record<number, boolean>>({});
  const [clearingCooldownByRoute, setClearingCooldownByRoute] = useState<Record<number, boolean>>({});
  const [updatingRoutingStrategyByRoute, setUpdatingRoutingStrategyByRoute] = useState<Record<number, boolean>>({});
  const [probingChannelIds, setProbingChannelIds] = useState<Set<number>>(new Set());
  const [channelProbeResults, setChannelProbeResults] = useState<Record<number, ChannelProbeResult>>({});
  const [routeProbeSessions, setRouteProbeSessions] = useState<Record<number, RouteProbeSession>>({});
  const [routeProbeSnapshots, setRouteProbeSnapshots] = useState<Record<number, RouteProbeSnapshot>>({});

  const [decisionByRoute, setDecisionByRoute] = useState<Record<number, RouteDecision | null>>({});
  const [loadingDecision, setLoadingDecision] = useState(false);
  const [decisionAutoSkipped, setDecisionAutoSkipped] = useState(false);
  const [visibleRouteCount, setVisibleRouteCount] = useState(ROUTE_RENDER_CHUNK);
  const [expandedSourceGroupMap, setExpandedSourceGroupMap] = useState<Record<string, boolean>>({});
  const [expandedRouteIds, setExpandedRouteIds] = useState<number[]>([]);
  const [addChannelModalRouteId, setAddChannelModalRouteId] = useState<number | null>(null);
  const isMobile = useIsMobile();

  const {
    channelsByRouteId,
    loadingChannelsByRouteId,
    loadChannels,
    invalidateChannels,
    setChannels,
  } = useRouteChannels();

  const toast = useToast();
  const routeProbeSessionsRef = useRef(routeProbeSessions);
  routeProbeSessionsRef.current = routeProbeSessions;

  const candidatesLoadedRef = useRef(false);
  const candidatesPromiseRef = useRef<Promise<void> | null>(null);
  const candidatesVersionRef = useRef(0);
  const candidatesSeqRef = useRef(0);

  const clearChannelProbeResultsByIds = useCallback((channelIds: number[]) => {
    if (channelIds.length === 0) return;
    const channelIdSet = new Set(channelIds);
    setChannelProbeResults((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const channelId of channelIdSet) {
        if (!(channelId in next)) continue;
        delete next[channelId];
        changed = true;
      }
      return changed ? next : prev;
    });
    setProbingChannelIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const channelId of channelIdSet) {
        if (!next.delete(channelId)) continue;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, []);

  const clearRouteProbeSession = useCallback((routeId: number, options?: { abort?: boolean }) => {
    const currentSession = routeProbeSessionsRef.current[routeId];
    if (options?.abort !== false) {
      currentSession?.controller.abort();
    }
    setRouteProbeSessions((prev) => {
      if (!prev[routeId]) return prev;
      const next = { ...prev };
      delete next[routeId];
      return next;
    });
  }, []);

  const clearAllRouteProbeSessions = useCallback(() => {
    for (const session of Object.values(routeProbeSessionsRef.current)) {
      session.controller.abort();
    }
    setRouteProbeSessions({});
  }, []);

  const clearPersistedRouteProbeSnapshot = useCallback((routeId: number) => {
    removeRouteProbeSnapshot(routeId);
    setRouteProbeSnapshots((prev) => {
      if (!(routeId in prev)) return prev;
      const next = { ...prev };
      delete next[routeId];
      return next;
    });
  }, []);

  const clearPersistedRouteProbeSnapshots = useCallback(() => {
    clearAllRouteProbeSnapshots();
    setRouteProbeSnapshots({});
  }, []);

  const invalidateProbeStateForRoute = useCallback((routeId: number, options?: { clearChannelProbeResults?: boolean }) => {
    clearRouteProbeSession(routeId);
    clearPersistedRouteProbeSnapshot(routeId);
    if (options?.clearChannelProbeResults) {
      const channelIds = (channelsByRouteId[routeId] || []).map((channel) => channel.id);
      clearChannelProbeResultsByIds(channelIds);
    }
  }, [channelsByRouteId, clearChannelProbeResultsByIds, clearPersistedRouteProbeSnapshot, clearRouteProbeSession]);

  const refreshRouteDecisionForRoute = useCallback(async (routeId: number) => {
    const route = routeSummaries.find((item) => item.id === routeId);
    if (!route) return;
    if (isRouteExactModel(route)) {
      const decisionRes = await api.getRouteDecision(route.modelPattern);
      setDecisionByRoute((prev) => ({
        ...prev,
        [routeId]: (decisionRes?.decision || null) as RouteDecision | null,
      }));
      return;
    }
    const decisionRes = await api.getRouteWideDecisionsBatch([routeId], { persistSnapshots: true });
    setDecisionByRoute((prev) => ({
      ...prev,
      [routeId]: (decisionRes?.decisions?.[String(routeId)] || null) as RouteDecision | null,
    }));
  }, [routeSummaries]);

  const findRouteIdByChannelId = useCallback((channelId: number): number | null => {
    for (const [routeIdText, channels] of Object.entries(channelsByRouteId)) {
      if (channels?.some((channel) => channel.id === channelId)) {
        return Number(routeIdText);
      }
    }
    return null;
  }, [channelsByRouteId]);

  const loadRouteDecisions = async (
    routeRows: RouteSummaryRow[],
    options?: { force?: boolean; refreshPricingCatalog?: boolean; persistSnapshots?: boolean },
  ) => {
    const rows = routeRows || [];
    const exactRoutes = rows.filter((route) => isRouteExactModel(route));
    const wildcardRouteIds = rows
      .filter((route) => !isRouteExactModel(route))
      .map((route) => route.id);

    const requestedModels = Array.from(new Set<string>(exactRoutes.map((route) => route.modelPattern)));

    const defaultState: Record<number, RouteDecision | null> = {};
    for (const route of rows) defaultState[route.id] = null;

    if (requestedModels.length === 0 && wildcardRouteIds.length === 0) {
      setDecisionByRoute(defaultState);
      setDecisionAutoSkipped(false);
      return;
    }

    const totalDecisionRequests = requestedModels.length + wildcardRouteIds.length;
    if (!options?.force && totalDecisionRequests > AUTO_ROUTE_DECISION_LIMIT) {
      setDecisionByRoute(defaultState);
      setDecisionAutoSkipped(true);
      return;
    }

    setLoadingDecision(true);
    try {
      setDecisionAutoSkipped(false);
      const decisionRequestOptions = options?.refreshPricingCatalog
        ? {
          refreshPricingCatalog: true as const,
          ...(options?.persistSnapshots ? { persistSnapshots: true as const } : {}),
        }
        : options?.persistSnapshots
          ? { persistSnapshots: true as const }
          : undefined;
      const [exactRes, wildcardRes] = await Promise.all([
        requestedModels.length > 0
          ? api.getRouteDecisionsBatch(requestedModels, decisionRequestOptions)
          : Promise.resolve({ decisions: {} }),
        wildcardRouteIds.length > 0
          ? api.getRouteWideDecisionsBatch(wildcardRouteIds, decisionRequestOptions)
          : Promise.resolve({ decisions: {} }),
      ]);

      const decisionMap = (exactRes?.decisions || {}) as Record<string, RouteDecision | null>;
      const wildcardDecisionMap = (wildcardRes?.decisions || {}) as Record<string, RouteDecision | null>;
      const next = { ...defaultState };
      for (const route of exactRoutes) {
        next[route.id] = decisionMap[route.modelPattern] || null;
      }
      for (const routeId of wildcardRouteIds) {
        next[routeId] = wildcardDecisionMap[String(routeId)] || null;
      }

      setDecisionByRoute(next);
    } catch {
      setDecisionByRoute(defaultState);
      setDecisionAutoSkipped(false);
    } finally {
      setLoadingDecision(false);
    }
  };

  const loadCandidates = (force?: boolean) => {
    if (candidatesLoadedRef.current && !force) return;
    if (candidatesPromiseRef.current && !force) return;
    const seq = ++candidatesSeqRef.current;
    candidatesLoadedRef.current = true;
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        const candidateRows = await api.getModelTokenCandidates();
        if (candidatesSeqRef.current !== seq) return; // stale
        startTransition(() => {
          setModelCandidates((candidateRows?.models || {}) as RouteModelCandidatesByModelName);
          setDirectAccountCandidates((candidateRows?.directAccountsByModel || {}) as DirectAccountCandidatesByModelName);
          setMissingTokenModelsByName(
            normalizeMissingTokenModels((candidateRows?.modelsWithoutToken || {}) as MissingTokenModelsByName),
          );
          setMissingTokenGroupModelsByName(
            normalizeMissingTokenModels((candidateRows?.modelsMissingTokenGroups || {}) as MissingTokenModelsByName),
          );
          setEndpointTypesByModel(candidateRows?.endpointTypesByModel || {});
        });
        candidatesVersionRef.current = Date.now();
      } catch {
        if (candidatesSeqRef.current === seq) candidatesLoadedRef.current = false;
      } finally {
        if (candidatesPromiseRef.current === promise) {
          candidatesPromiseRef.current = null;
        }
      }
    })();
    candidatesPromiseRef.current = promise;
  };

  const load = async () => {
    const summaryRows = await api.getRoutesSummary();

    const summaries = (summaryRows || []) as RouteSummaryRow[];
    setRouteSummaries(summaries);
    const routeIdSet = new Set(summaries.map((route) => route.id));
    setRouteProbeSessions((prev) => {
      let changed = false;
      const next: Record<number, RouteProbeSession> = {};
      for (const [routeIdText, session] of Object.entries(prev)) {
        const routeId = Number(routeIdText);
        if (!routeIdSet.has(routeId)) {
          session.controller.abort();
          changed = true;
          continue;
        }
        next[routeId] = session;
      }
      return changed ? next : prev;
    });
    const decisionPlaceholder: Record<number, RouteDecision | null> = {};
    for (const route of summaries) {
      decisionPlaceholder[route.id] = route.decisionSnapshot || null;
    }
    setDecisionByRoute(decisionPlaceholder);

    const hasMissingSnapshots = summaries.some(
      (route) => !route.decisionSnapshot && route.kind !== 'zero_channel' && route.readOnly !== true && route.isVirtual !== true,
    );
    setDecisionAutoSkipped(hasMissingSnapshots);

    // Auto-backfill missing snapshots in background
    if (hasMissingSnapshots) {
      loadRouteDecisions(summaries, { force: true, persistSnapshots: true }).catch(() => {});
    }

    // Silently refresh candidates in the background if already loaded
    if (candidatesLoadedRef.current) {
      loadCandidates(true);
    }
  };

  useEffect(() => {
    setRouteProbeSnapshots(loadRouteProbeSnapshots());
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await load();
      } catch {
        toast.error('加载路由配置失败');
      }
      // Preload candidates in background after first paint
      const scheduleIdle = typeof requestIdleCallback === 'function' ? requestIdleCallback : (cb: () => void) => setTimeout(cb, 0);
      scheduleIdle(() => loadCandidates());
    })();
  }, []);

  useEffect(() => () => {
    for (const session of Object.values(routeProbeSessionsRef.current)) {
      session.controller.abort();
    }
  }, []);

  useEffect(() => {
    if (expandedRouteIds.length === 0) return;
    const staleRouteIds: number[] = [];
    for (const routeId of expandedRouteIds) {
      const snapshot = routeProbeSnapshots[routeId];
      const channels = channelsByRouteId[routeId];
      if (!snapshot || !channels) continue;
      if (isSnapshotStale(snapshot, channels)) {
        staleRouteIds.push(routeId);
      }
    }
    if (staleRouteIds.length === 0) return;
    for (const routeId of staleRouteIds) {
      removeRouteProbeSnapshot(routeId);
    }
    setRouteProbeSnapshots((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const routeId of staleRouteIds) {
        if (!(routeId in next)) continue;
        delete next[routeId];
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [channelsByRouteId, expandedRouteIds]);

  const handleRebuild = async () => {
    try {
      setRebuilding(true);
      clearAllRouteProbeSessions();
      clearPersistedRouteProbeSnapshots();
      const res = await api.rebuildRoutes(true);
      if (res?.queued) {
        toast.info(res.message || '已开始重建路由，请稍后查看日志');
        invalidateChannels();
        await load();
        return;
      }
      const createdRoutes = res?.rebuild?.createdRoutes ?? 0;
      const createdChannels = res?.rebuild?.createdChannels ?? 0;
      toast.success(`自动重建完成（新增 ${createdRoutes} 条路由 / ${createdChannels} 个通道）`);
      invalidateChannels();
      await load();
    } catch (e: any) {
      toast.error(e.message || '重建路由失败');
    } finally {
      setRebuilding(false);
    }
  };

  const handleRefreshRouteDecisions = async () => {
    try {
      await loadRouteDecisions(routeSummaries, { force: true, refreshPricingCatalog: true, persistSnapshots: true });
      toast.success('路由选择概率已刷新');
    } catch {
      toast.error('刷新路由选择概率失败');
    }
  };

  const exactRouteCount = useMemo(
    () => buildVisibleRouteList(routeSummaries, isExactModelPattern, matchesModelPattern)
      .filter((route) => isRouteExactModel(route)).length,
    [routeSummaries],
  );

  const zeroChannelPlaceholderRoutes = useMemo(
    () => buildZeroChannelPlaceholderRoutes(routeSummaries, missingTokenModelsByName, missingTokenGroupModelsByName),
    [routeSummaries, missingTokenModelsByName, missingTokenGroupModelsByName],
  );

  const visibleRouteRows = useMemo(
    () => (showZeroChannelRoutes ? [...routeSummaries, ...zeroChannelPlaceholderRoutes] : routeSummaries),
    [routeSummaries, showZeroChannelRoutes, zeroChannelPlaceholderRoutes],
  );

  const canSaveRoute = useMemo(() => {
    if (saving) return false;
    if (form.routeMode === 'explicit_group') {
      return !!form.displayName.trim() && form.sourceRouteIds.length > 0;
    }
    return !!form.modelPattern.trim() && !getModelPatternError(form.modelPattern);
  }, [form.displayName, form.modelPattern, form.routeMode, form.sourceRouteIds.length, saving]);

  const previewModelSamples = useMemo(() => {
    if (!showManual) return [];
    const names = new Set<string>();
    for (const modelName of Object.keys(modelCandidates || {})) {
      const normalized = modelName.trim();
      if (normalized) names.add(normalized);
    }
    for (const route of routeSummaries) {
      if (!isRouteExactModel(route)) continue;
      const normalized = route.modelPattern.trim();
      if (normalized) names.add(normalized);
    }
    return Array.from(names)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .slice(0, 800);
  }, [showManual, modelCandidates, routeSummaries]);

  const exactSourceRouteOptions = useMemo(
    () => routeSummaries.filter((route) => isRouteExactModel(route)),
    [routeSummaries],
  );

  const resetRouteForm = () => {
    setForm(EMPTY_ROUTE_FORM);
    setEditingRouteId(null);
  };

  const handleAddRoute = async () => {
    const trimmedDisplayName = form.displayName.trim() ? form.displayName.trim() : undefined;
    const trimmedDisplayIcon = form.displayIcon.trim() ? form.displayIcon.trim() : undefined;
    const trimmedModelPattern = form.modelPattern.trim();
    const routeMode = normalizeRouteMode(form.routeMode);
    if (routeMode === 'explicit_group') {
      if (!trimmedDisplayName) {
        toast.error('请填写对外模型名');
        return;
      }
      if (form.sourceRouteIds.length === 0) {
        toast.error('请至少选择一个来源模型');
        return;
      }
    } else {
      if (!trimmedModelPattern) return;
      const modelPatternError = getModelPatternError(form.modelPattern);
      if (modelPatternError) {
        toast.error(modelPatternError);
        return;
      }
    }

    setSaving(true);
    try {
      if (editingRouteId) {
        const currentRoute = routeSummaries.find((route) => route.id === editingRouteId) || null;
        const modelPatternChanged = routeMode === 'pattern' && !!currentRoute && currentRoute.modelPattern !== trimmedModelPattern;
        await api.updateRoute(editingRouteId, {
          routeMode,
          ...(routeMode === 'pattern' ? { modelPattern: trimmedModelPattern } : {}),
          displayName: trimmedDisplayName,
          displayIcon: trimmedDisplayIcon,
          ...(routeMode === 'explicit_group' ? { sourceRouteIds: form.sourceRouteIds } : {}),
        });
        toast.success(routeMode === 'pattern' && modelPatternChanged ? tr('群组已更新并重新匹配通道') : tr('群组已更新'));
      } else {
        await api.addRoute({
          routeMode,
          ...(routeMode === 'pattern' ? { modelPattern: trimmedModelPattern } : {}),
          displayName: trimmedDisplayName,
          displayIcon: trimmedDisplayIcon,
          ...(routeMode === 'explicit_group' ? { sourceRouteIds: form.sourceRouteIds } : {}),
        });
        toast.success(tr('群组已创建'));
      }
      if (editingRouteId) {
        invalidateProbeStateForRoute(editingRouteId);
      }
      setShowManual(false);
      resetRouteForm();
      await load();
    } catch (e: any) {
      toast.error(e.message || (editingRouteId ? tr('更新群组失败') : tr('创建群组失败')));
    } finally {
      setSaving(false);
    }
  };

  const handleEditRoute = (route: RouteSummaryRow) => {
    loadCandidates();
    setEditingRouteId(route.id);
    const routeMode = normalizeRouteMode(route.routeMode);
    setForm({
      routeMode,
      modelPattern: route.modelPattern || '',
      displayName: route.displayName || '',
      displayIcon: normalizeRouteDisplayIconValue(route.displayIcon),
      sourceRouteIds: routeMode === 'explicit_group' ? [...(route.sourceRouteIds || [])] : [],
      advancedOpen: routeMode === 'pattern',
    });
    setShowManual(true);
  };

  const handleCancelEditRoute = () => {
    resetRouteForm();
    setShowManual(false);
  };

  const handleDeleteRoute = async (routeId: number) => {
    try {
      await api.deleteRoute(routeId);
      invalidateProbeStateForRoute(routeId, { clearChannelProbeResults: true });
      toast.success('路由已删除');
      await load();
    } catch (e: any) {
      toast.error(e.message || '删除路由失败');
    }
  };

  const handleToggleRouteEnabled = async (route: RouteSummaryRow) => {
    const newEnabled = !route.enabled;
    setRouteSummaries((prev) =>
      prev.map((item) => (item.id === route.id ? { ...item, enabled: newEnabled } : item)),
    );
    try {
      await api.updateRoute(route.id, { enabled: newEnabled });
      invalidateProbeStateForRoute(route.id);
      toast.success(newEnabled ? '路由已启用' : '路由已禁用');
    } catch (e: any) {
      setRouteSummaries((prev) =>
        prev.map((item) => (item.id === route.id ? { ...item, enabled: route.enabled } : item)),
      );
      toast.error(e.message || '切换路由状态失败');
    }
  };

  const handleRoutingStrategyChange = async (route: RouteSummaryRow, routingStrategy: RouteRoutingStrategy) => {
    const currentStrategy = normalizeRouteRoutingStrategyValue(route.routingStrategy);
    if (routingStrategy === currentStrategy) return;

    setUpdatingRoutingStrategyByRoute((prev) => ({ ...prev, [route.id]: true }));
    setRouteSummaries((prev) => prev.map((item) => (
      item.id === route.id
        ? { ...item, routingStrategy }
        : item
    )));
    try {
      await api.updateRoute(route.id, { routingStrategy });
      toast.success(getRouteRoutingStrategySuccessMessage(routingStrategy));
    } catch (e: any) {
      setRouteSummaries((prev) => prev.map((item) => (
        item.id === route.id
          ? { ...item, routingStrategy: currentStrategy }
          : item
      )));
      toast.error(e.message || '更新路由策略失败');
      return;
    } finally {
      setUpdatingRoutingStrategyByRoute((prev) => ({ ...prev, [route.id]: false }));
    }

    try {
      await load();
    } catch (e: any) {
      toast.error(e?.message || '路由策略已保存，但刷新列表失败');
    }
  };

  // Stable derived value: only changes when route patterns change (not on enabled toggle)
  const routePatternsKey = visibleRouteRows.map((r) => `${r.id}:${r.modelPattern}:${r.routeMode || 'pattern'}`).join(',');
  const routePatterns = useMemo(
    () => visibleRouteRows.map((r) => ({ id: r.id, modelPattern: r.modelPattern, routeMode: r.routeMode })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routePatternsKey],
  );

  const routeBrandById = useMemo(() => {
    const next = new Map<number, BrandInfo | null>();
    for (const route of visibleRouteRows) {
      next.set(route.id, resolveRouteBrand(route));
    }
    return next;
  }, [visibleRouteRows]);

  const listVisibleRoutes = useMemo(
    () => buildVisibleRouteList(visibleRouteRows, isExactModelPattern, matchesModelPattern),
    [visibleRouteRows],
  );

  const brandList = useMemo(() => {
    const grouped = new Map<string, { count: number; brand: BrandInfo }>();
    let otherCount = 0;

    for (const route of listVisibleRoutes) {
      const brand = routeBrandById.get(route.id) || null;
      if (!brand) {
        otherCount++;
        continue;
      }

      const existing = grouped.get(brand.name);
      if (existing) {
        existing.count++;
      } else {
        grouped.set(brand.name, { count: 1, brand });
      }
    }

    return {
      list: [...grouped.entries()].sort((a, b) => {
        if (a[1].count === b[1].count) return a[0].localeCompare(b[0]);
        return b[1].count - a[1].count;
      }) as [string, { count: number; brand: BrandInfo }][],
      otherCount,
    };
  }, [listVisibleRoutes, routeBrandById]);

  const siteList = useMemo(() => {
    const grouped = new Map<string, { count: number; siteId: number }>();

    for (const route of listVisibleRoutes) {
      const seenSites = new Set<string>();
      for (const siteName of route.siteNames || []) {
        if (!siteName || seenSites.has(siteName)) continue;
        seenSites.add(siteName);

        const existing = grouped.get(siteName);
        if (existing) {
          existing.count++;
        } else {
          grouped.set(siteName, { count: 1, siteId: 0 });
        }
      }
    }

    return [...grouped.entries()].sort((a, b) => {
      if (a[1].count === b[1].count) return a[0].localeCompare(b[0]);
      return b[1].count - a[1].count;
    }) as [string, { count: number; siteId: number }][];
  }, [listVisibleRoutes]);

  const routeEndpointTypesByRouteId = useMemo(() => {
    const index: Record<number, Set<string>> = {};
    const entries = Object.entries(endpointTypesByModel || {});
    for (const route of routePatterns) {
      const pattern = (route.modelPattern || '').trim();
      if (!pattern) {
        index[route.id] = new Set<string>();
        continue;
      }
      const endpointTypes = new Set<string>();
      for (const [modelName, rawTypes] of entries) {
        if (!matchesModelPattern(modelName, pattern)) continue;
        for (const rawType of Array.isArray(rawTypes) ? rawTypes : []) {
          const endpointType = String(rawType || '').trim();
          if (!endpointType) continue;
          endpointTypes.add(endpointType);
        }
      }
      // Fallback: infer from siteNames isn't possible without platform info,
      // but we'll keep endpoint types from model availability
      index[route.id] = endpointTypes;
    }
    return index;
  }, [routePatterns, endpointTypesByModel]);

  const endpointTypeList = useMemo(() => {
    const grouped = new Map<string, number>();
    for (const route of listVisibleRoutes) {
      const endpointTypes = routeEndpointTypesByRouteId[route.id] || new Set<string>();
      for (const endpointType of endpointTypes) {
        grouped.set(endpointType, (grouped.get(endpointType) || 0) + 1);
      }
    }
    return [...grouped.entries()].sort((a, b) => {
      if (a[1] === b[1]) return a[0].localeCompare(b[0], undefined, { sensitivity: 'base' });
      return b[1] - a[1];
    }) as [string, number][];
  }, [listVisibleRoutes, routeEndpointTypesByRouteId]);

  const sourceEndpointTypesByRouteId = useMemo(() => {
    if (!showManual) return {};
    const next: Record<number, string[]> = {};
    for (const route of exactSourceRouteOptions) {
      next[route.id] = Array.from(routeEndpointTypesByRouteId[route.id] || new Set<string>())
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    }
    return next;
  }, [showManual, exactSourceRouteOptions, routeEndpointTypesByRouteId]);

  const routeBrandIconCandidates = useMemo(() => {
    if (!showManual) return [];
    const byIcon = new Map<string, BrandInfo>();

    for (const route of visibleRouteRows) {
      const brand = resolveRouteBrand(route);
      if (brand) byIcon.set(brand.icon, brand);
    }

    for (const modelName of Object.keys(modelCandidates || {})) {
      const brand = getBrand(modelName);
      if (brand) byIcon.set(brand.icon, brand);
    }

    return Array.from(byIcon.values())
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }, [showManual, visibleRouteRows, modelCandidates]);

  const routeIconSelectOptions = useMemo<RouteIconOption[]>(() => ([
    ...ROUTE_ICON_OPTIONS,
    ...routeBrandIconCandidates.map((brand) => ({
      value: toBrandIconValue(brand.icon),
      label: brand.name,
      description: `${brand.name} 品牌图标`,
      iconNode: <BrandGlyph brand={brand} size={14} fallbackText={brand.name} />,
    })),
  ]), [routeBrandIconCandidates]);

  const groupRouteList = useMemo<GroupRouteItem[]>(() => (
    listVisibleRoutes
      .filter((route) => !isRouteExactModel(route))
      .map((route) => ({
        id: route.id,
        title: resolveRouteTitle(route),
        icon: resolveRouteIcon(route),
        brand: routeBrandById.get(route.id) || null,
        modelPattern: route.modelPattern,
        channelCount: route.channelCount,
        sourceRouteCount: Array.isArray(route.sourceRouteIds) ? route.sourceRouteIds.length : 0,
      }))
      .sort((a, b) => {
        if (a.channelCount === b.channelCount) return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
        return b.channelCount - a.channelCount;
      })
  ), [listVisibleRoutes, routeBrandById]);

  const activeGroupRoute = useMemo(() => {
    if (typeof activeGroupFilter !== 'number') return null;
    return listVisibleRoutes.find((route) => route.id === activeGroupFilter) || null;
  }, [activeGroupFilter, listVisibleRoutes]);

  const sortedRoutes = useMemo(() => (
    [...listVisibleRoutes].sort((a, b) => {
      if (sortBy === 'channelCount') {
        const countCmp = a.channelCount - b.channelCount;
        if (countCmp !== 0) return sortDir === 'asc' ? countCmp : -countCmp;
      }

      const nameCmp = a.modelPattern.localeCompare(b.modelPattern, undefined, { sensitivity: 'base' });
      return sortDir === 'asc' ? nameCmp : -nameCmp;
    })
  ), [listVisibleRoutes, sortBy, sortDir]);

  // Shared base filter: all filters EXCEPT enabledFilter
  const baseFilteredRoutes = useMemo(() => {
    let list = sortedRoutes;

    if (activeGroupFilter === '__all__') {
      list = list.filter((route) => !isRouteExactModel(route));
    } else if (typeof activeGroupFilter === 'number') {
      list = list.filter((route) => route.id === activeGroupFilter);
    }

    if (activeBrand) {
      if (activeBrand === '__other__') {
        list = list.filter((route) => !(routeBrandById.get(route.id) || null));
      } else {
        list = list.filter((route) => (routeBrandById.get(route.id)?.name || '') === activeBrand);
      }
    }

    if (activeSite) {
      list = list.filter((route) => route.siteNames?.includes(activeSite));
    }

    if (activeEndpointType) {
      list = list.filter((route) =>
        (routeEndpointTypesByRouteId[route.id] || new Set<string>()).has(activeEndpointType),
      );
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((route) => {
        const modelPattern = route.modelPattern.toLowerCase();
        const displayName = (route.displayName || '').toLowerCase();
        const title = resolveRouteTitle(route).toLowerCase();
        return modelPattern.includes(q) || displayName.includes(q) || title.includes(q);
      });
    }

    return list;
  }, [sortedRoutes, activeGroupFilter, activeBrand, activeSite, activeEndpointType, search, routeBrandById, routeEndpointTypesByRouteId]);

  const enabledCounts = useMemo(() => {
    let enabled = 0;
    let disabled = 0;
    for (const route of baseFilteredRoutes) {
      if (route.kind === 'zero_channel' || route.readOnly === true || route.isVirtual === true) continue;
      if (route.enabled) enabled++;
      else disabled++;
    }
    return { enabled, disabled };
  }, [baseFilteredRoutes]);

  const filteredRoutes = useMemo(() => {
    if (enabledFilter === 'all') return baseFilteredRoutes;
    return baseFilteredRoutes.filter((route) => {
      if (route.kind === 'zero_channel' || route.readOnly === true || route.isVirtual === true) return false;
      return enabledFilter === 'enabled' ? route.enabled : !route.enabled;
    });
  }, [baseFilteredRoutes, enabledFilter]);

  const selectableRouteIds = useMemo(() => {
    return new Set(
      filteredRoutes
        .filter((route) => route.kind !== 'zero_channel' && route.readOnly !== true && route.isVirtual !== true)
        .map((route) => route.id),
    );
  }, [filteredRoutes]);

  const toggleBatchSelectMode = () => {
    setBatchSelectMode((prev) => {
      if (prev) setSelectedRouteIds(new Set());
      return !prev;
    });
  };

  const toggleRouteSelection = (routeId: number) => {
    setSelectedRouteIds((prev) => {
      const next = new Set(prev);
      if (next.has(routeId)) next.delete(routeId);
      else next.add(routeId);
      return next;
    });
  };

  const selectAllRoutes = () => {
    setSelectedRouteIds(new Set(selectableRouteIds));
  };

  const deselectAllRoutes = () => {
    setSelectedRouteIds(new Set());
  };

  const handleBatchUpdateRoutes = async (action: 'enable' | 'disable') => {
    const ids = Array.from(selectedRouteIds).filter((id) => selectableRouteIds.has(id));
    if (ids.length === 0) {
      toast.info('请先选择要操作的路由');
      return;
    }
    const actionLabel = action === 'disable' ? '禁用' : '启用';
    const confirmed = window.confirm(`确认批量${actionLabel} ${ids.length} 条路由？`);
    if (!confirmed) return;

    setBatchUpdatingRoutes(true);
    try {
      await api.batchUpdateRoutes({ ids, action });
      clearAllRouteProbeSessions();
      clearPersistedRouteProbeSnapshots();
      toast.success(`已批量${actionLabel} ${ids.length} 条路由`);
      setSelectedRouteIds(new Set());
      setBatchSelectMode(false);
      await load();
    } catch (e: any) {
      toast.error(e.message || `批量${actionLabel}路由失败`);
    } finally {
      setBatchUpdatingRoutes(false);
    }
  };

  useEffect(() => {
    setVisibleRouteCount(getInitialVisibleCount(filteredRoutes.length, ROUTE_RENDER_CHUNK));
  }, [filteredRoutes.length]);

  const handleLoadMoreRoutes = useCallback(() => {
    setVisibleRouteCount((current) => getNextVisibleCount(current, filteredRoutes.length, ROUTE_RENDER_CHUNK));
  }, [filteredRoutes.length]);

  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);

  const shouldShowLoadMore = filteredRoutes.length > 0 && visibleRouteCount < filteredRoutes.length;

  useEffect(() => {
    const el = loadMoreSentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) handleLoadMoreRoutes(); },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [handleLoadMoreRoutes, shouldShowLoadMore]);

  const visibleRoutes = useMemo(
    () => filteredRoutes.slice(0, visibleRouteCount),
    [filteredRoutes, visibleRouteCount],
  );

  // Lazy per-route candidate index — only computes for routes actually accessed
  const candidateIndexCacheRef = useRef<{ key: string; cache: Map<number, RouteCandidateView> }>({ key: '', cache: new Map() });
  const candidateIndexCacheKey = `${routePatternsKey}|${Object.keys(modelCandidates).length}|${Object.keys(directAccountCandidates).length}|${candidatesVersionRef.current}`;
  if (candidateIndexCacheRef.current.key !== candidateIndexCacheKey) {
    candidateIndexCacheRef.current = { key: candidateIndexCacheKey, cache: new Map() };
  }

  const getRouteCandidateView = (routeId: number): RouteCandidateView => {
    const cache = candidateIndexCacheRef.current.cache;
    const cached = cache.get(routeId);
    if (cached) return cached;
    const route = routePatterns.find((r) => r.id === routeId);
    if (!route) return EMPTY_ROUTE_CANDIDATE_VIEW;
    const index = buildRouteModelCandidatesIndex([route], modelCandidates, directAccountCandidates, matchesModelPattern);
    const view = index[routeId] || EMPTY_ROUTE_CANDIDATE_VIEW;
    cache.set(routeId, view);
    return view;
  };

  // Lazy per-route missing token index
  const missingTokenCacheRef = useRef<{ key: string; cache: Map<number, RouteMissingTokenHint[]> }>({ key: '', cache: new Map() });
  const missingTokenCacheKey = `${routePatternsKey}|${Object.keys(missingTokenModelsByName).length}|${candidatesVersionRef.current}`;
  if (missingTokenCacheRef.current.key !== missingTokenCacheKey) {
    missingTokenCacheRef.current = { key: missingTokenCacheKey, cache: new Map() };
  }

  const getRouteMissingTokenHints = (routeId: number): RouteMissingTokenHint[] => {
    const cache = missingTokenCacheRef.current.cache;
    const cached = cache.get(routeId);
    if (cached) return cached;
    const route = routePatterns.find((r) => r.id === routeId);
    if (!route) return [];
    const index = buildRouteMissingTokenIndex([route], missingTokenModelsByName, matchesModelPattern);
    const hints = index[routeId] || [];
    cache.set(routeId, hints);
    return hints;
  };

  // Lazy per-route missing token group index
  const missingTokenGroupCacheRef = useRef<{ key: string; cache: Map<number, RouteMissingTokenHint[]> }>({ key: '', cache: new Map() });
  const missingTokenGroupCacheKey = `${routePatternsKey}|${Object.keys(missingTokenGroupModelsByName).length}|${candidatesVersionRef.current}`;
  if (missingTokenGroupCacheRef.current.key !== missingTokenGroupCacheKey) {
    missingTokenGroupCacheRef.current = { key: missingTokenGroupCacheKey, cache: new Map() };
  }

  const getRouteMissingTokenGroupHints = (routeId: number): RouteMissingTokenHint[] => {
    const cache = missingTokenGroupCacheRef.current.cache;
    const cached = cache.get(routeId);
    if (cached) return cached;
    const route = routePatterns.find((r) => r.id === routeId);
    if (!route) return [];
    const index = buildRouteMissingTokenIndex([route], missingTokenGroupModelsByName, matchesModelPattern);
    const hints = index[routeId] || [];
    cache.set(routeId, hints);
    return hints;
  };

  const routeById = useMemo(
    () => new Map(visibleRouteRows.map((route) => [route.id, route])),
    [visibleRouteRows],
  );

  const handleCreateTokenForMissingAccount = (accountId: number, modelName: string) => {
    if (!Number.isFinite(accountId) || accountId <= 0) return;
    const params = new URLSearchParams();
    params.set('create', '1');
    params.set('accountId', String(accountId));
    params.set('model', modelName);
    params.set('from', 'routes');
    navigate(`/tokens?${params.toString()}`);
  };

  const handleProbeChannel = async (channelId: number) => {
    setProbingChannelIds((prev) => {
      const next = new Set(prev);
      next.add(channelId);
      return next;
    });
    try {
      const res = await api.probeChannel(channelId);
      const result = res.result as ChannelProbeResult;
      setChannelProbeResults((prev) => ({ ...prev, [channelId]: result }));
      if (result.status === 'supported') {
        const routeId = findRouteIdByChannelId(channelId);
        if (routeId != null) {
          await Promise.allSettled([
            loadChannels(routeId, true),
            refreshRouteDecisionForRoute(routeId),
          ]);
        }
        toast.success(`探活成功${result.ttftMs != null ? ` — TTFT ${Math.round(result.ttftMs)}ms` : ''}`);
      } else {
        const detail = result.httpStatus != null
          ? `HTTP ${result.httpStatus}`
          : (result.error || result.status);
        toast.info(`探活结果: ${detail}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '探活失败');
    } finally {
      setProbingChannelIds((prev) => {
        const next = new Set(prev);
        next.delete(channelId);
        return next;
      });
    }
  };

  const handleProbeRouteChannels = async (routeId: number) => {
    const route = routeSummaries.find((item) => item.id === routeId);
    if (!isRouteProbeable(route)) return;

    const snapshotChannels = [...(channelsByRouteId[routeId] || [])];
    clearRouteProbeSession(routeId);
    clearPersistedRouteProbeSnapshot(routeId);
    const controller = new AbortController();
    let snapshotExpectedCount = 0;
    let snapshotCompletedCount = 0;
    let snapshotResults: Record<number, ChannelProbeResult> = {};
    const nextSession: RouteProbeSession = {
      controller,
      expectedCount: 0,
      completedCount: 0,
      done: false,
      results: {},
    };
    setRouteProbeSessions((prev) => ({ ...prev, [routeId]: nextSession }));

    try {
      await api.probeRouteChannelsStream(routeId, (raw) => {
        if (!raw || typeof raw !== 'object') return;
        const event = raw as Record<string, unknown>;
        if (event.type === 'start') {
          const totalCount = typeof event.totalCount === 'number' && Number.isFinite(event.totalCount)
            ? Math.max(0, Math.trunc(event.totalCount))
            : 0;
          snapshotExpectedCount = totalCount;
          setRouteProbeSessions((prev) => {
            const current = prev[routeId];
            if (!current || current.controller !== controller) return prev;
            return {
              ...prev,
              [routeId]: {
                ...current,
                expectedCount: totalCount,
              },
            };
          });
          return;
        }
        if (event.type !== 'result' || typeof event.channelId !== 'number') return;
        const result: ChannelProbeResult = {
          channelId: Math.trunc(event.channelId),
          status: (event.status as ChannelProbeResult['status']) || 'inconclusive',
          ttftMs: typeof event.ttftMs === 'number' && Number.isFinite(event.ttftMs) ? event.ttftMs : null,
          httpStatus: typeof event.httpStatus === 'number' && Number.isFinite(event.httpStatus) ? Math.trunc(event.httpStatus) : null,
          error: typeof event.error === 'string' ? event.error : null,
        };
        snapshotCompletedCount += 1;
        snapshotResults = { ...snapshotResults, [result.channelId]: result };
        setRouteProbeSessions((prev) => {
          const current = prev[routeId];
          if (!current || current.controller !== controller) return prev;
          return {
            ...prev,
            [routeId]: {
              ...current,
              completedCount: snapshotCompletedCount,
              results: snapshotResults,
            },
          };
        });
      }, controller.signal);

      setRouteProbeSessions((prev) => {
        const current = prev[routeId];
        if (!current || current.controller !== controller) return prev;
        return {
          ...prev,
          [routeId]: {
            ...current,
            expectedCount: snapshotExpectedCount,
            completedCount: snapshotCompletedCount,
            done: true,
            results: snapshotResults,
          },
        };
      });
      if (routeProbeSessionsRef.current[routeId]?.controller !== controller) {
        return;
      }
      const snapshot: RouteProbeSnapshot = {
        probedAt: new Date().toISOString(),
        channelFingerprint: buildChannelFingerprint(snapshotChannels),
        expectedCount: snapshotExpectedCount,
        completedCount: snapshotCompletedCount,
        results: { ...snapshotResults },
      };
      saveRouteProbeSnapshot(routeId, snapshot);
      setRouteProbeSnapshots((prev) => ({ ...prev, [routeId]: snapshot }));
      toast.success('批量探活完成');
    } catch (e) {
      if (controller.signal.aborted) return;
      toast.error(e instanceof Error ? e.message : '批量探活失败');
    }
  };

  const handleApplyProbeRanking = async (routeId: number) => {
    const session = routeProbeSessionsRef.current[routeId];
    if (!session || !session.done || session.completedCount !== session.expectedCount || session.expectedCount <= 0) {
      return;
    }

    const ranking = Object.values(session.results).map((result) => ({
      channelId: result.channelId,
      ttftMs: result.ttftMs,
      status: result.status,
      httpStatus: result.httpStatus,
      error: result.error,
    }));

    try {
      await api.applyProbeRanking(routeId, ranking);
      clearRouteProbeSession(routeId, { abort: false });
      clearPersistedRouteProbeSnapshot(routeId);
      toast.success('已应用探活排序');
      await loadChannels(routeId, true);
      await refreshRouteDecisionForRoute(routeId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '排序失败');
    }
  };

  const handleClearRouteProbeSession = (routeId: number) => {
    clearRouteProbeSession(routeId, { abort: false });
    clearPersistedRouteProbeSnapshot(routeId);
  };

  const handleDeleteChannel = async (channelId: number, routeId: number) => {
    const dismissedKey = 'metapi:channel-delete-warning-dismissed';
    const dismissed = localStorage.getItem(dismissedKey) === 'true';
    if (!dismissed) {
      const dontAskAgain = { checked: false };
      const confirmed = await new Promise<boolean>((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:9999;display:flex;align-items:center;justify-content:center';
        const dialog = document.createElement('div');
        dialog.style.cssText = 'background:var(--color-bg-card,#fff);border-radius:12px;padding:24px;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.2)';
        dialog.innerHTML = `
          <div style="font-weight:600;font-size:15px;margin-bottom:12px">确认移除通道</div>
          <div style="font-size:13px;color:var(--color-text-secondary);line-height:1.6;margin-bottom:16px">
            移除的通道会在定时模型刷新时被自动重建恢复。<br/>如果只是想临时停用通道，建议使用<b>禁用开关</b>。
          </div>
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--color-text-muted);margin-bottom:16px;cursor:pointer">
            <input type="checkbox" id="__ch_del_dismiss" /> 以后不再提示
          </label>
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button id="__ch_del_cancel" class="btn btn-ghost" style="padding:6px 16px">取消</button>
            <button id="__ch_del_confirm" class="btn btn-danger" style="padding:6px 16px">确认移除</button>
          </div>
        `;
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        dialog.querySelector('#__ch_del_cancel')!.addEventListener('click', () => { document.body.removeChild(overlay); resolve(false); });
        dialog.querySelector('#__ch_del_confirm')!.addEventListener('click', () => {
          dontAskAgain.checked = (dialog.querySelector('#__ch_del_dismiss') as HTMLInputElement).checked;
          document.body.removeChild(overlay);
          resolve(true);
        });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) { document.body.removeChild(overlay); resolve(false); } });
      });
      if (!confirmed) return;
      if (dontAskAgain.checked) localStorage.setItem(dismissedKey, 'true');
    }
    try {
      await api.deleteChannel(channelId);
      invalidateProbeStateForRoute(routeId, { clearChannelProbeResults: true });
      toast.success('通道已移除');
      await loadChannels(routeId, true);
      setRouteSummaries((prev) =>
        prev.map((r) => r.id === routeId ? { ...r, channelCount: Math.max(0, r.channelCount - 1) } : r),
      );
    } catch (e: any) {
      toast.error(e.message || '移除通道失败');
    }
  };

  const handleToggleChannelEnabled = async (channelId: number, routeId: number, enabled: boolean) => {
    if (updatingChannel[channelId]) return;
    setUpdatingChannel((prev) => ({ ...prev, [channelId]: true }));
    try {
      await api.updateChannel(channelId, { enabled });
      invalidateProbeStateForRoute(routeId);
      toast.success(enabled ? '通道已启用' : '通道已禁用');
      await loadChannels(routeId, true);
    } catch (e: any) {
      toast.error(e.message || '更新通道状态失败');
    } finally {
      setUpdatingChannel((prev) => ({ ...prev, [channelId]: false }));
    }
  };

  const handleChannelSettingsSave = async (routeId: number, channelId: number, accountId: number, updates: { tokenId?: number | null; priority?: number; weight?: number }) => {
    if (updatingChannel[channelId]) return; // Concurrent protection
    const { tokenId, priority, weight } = updates;

    // Validate tokenId if it was changed to a specific token
    if (tokenId !== undefined && tokenId !== null && tokenId > 0) {
      const tokenOptions = getRouteCandidateView(routeId).tokenOptionsByAccountId[accountId] || [];
      if (tokenOptions.length > 0 && !tokenOptions.some((token) => token.id === tokenId)) {
        toast.error('该令牌不支持当前模型');
        return;
      }
    }

    // Build payload with only provided fields (strict !== undefined check to preserve null)
    const payload: Record<string, unknown> = {};
    if (tokenId !== undefined) payload.tokenId = tokenId;
    if (priority !== undefined) payload.priority = priority;
    if (weight !== undefined) payload.weight = weight;

    if (Object.keys(payload).length === 0) return;

    setUpdatingChannel((prev) => ({ ...prev, [channelId]: true }));
    try {
      await api.updateChannel(channelId, payload);
      invalidateProbeStateForRoute(routeId);
      toast.success('通道配置已更新');
      await loadChannels(routeId, true);
    } catch (e: any) {
      toast.error(e.message || '更新通道失败');
    } finally {
      setUpdatingChannel((prev) => ({ ...prev, [channelId]: false }));
    }
  };

  const handleChannelDragEnd = async (routeId: number, event: DragEndEvent) => {
    if (savingPriorityByRoute[routeId]) return;

    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const channels = channelsByRouteId[routeId] || [];
    const oldIndex = channels.findIndex((channel) => channel.id === Number(active.id));
    const newIndex = channels.findIndex((channel) => channel.id === Number(over.id));

    if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;

    const previousChannels = [...channels];
    const reordered = arrayMove(channels, oldIndex, newIndex).map((channel, index) => ({
      ...channel,
      priority: index,
    }));

    setChannels(routeId, reordered);
    setSavingPriorityByRoute((prev) => ({ ...prev, [routeId]: true }));

    try {
      await api.batchUpdateChannels(
        reordered.map((channel) => ({
          id: channel.id,
          priority: channel.priority,
        })),
      );
      invalidateProbeStateForRoute(routeId);

      const route = routeSummaries.find((r) => r.id === routeId);
      if (route && isRouteExactModel(route)) {
        try {
          const res = await api.getRouteDecision(route.modelPattern);
          setDecisionByRoute((prev) => ({
            ...prev,
            [routeId]: (res?.decision || null) as RouteDecision | null,
          }));
        } catch {
          // ignore route decision refresh failures after reorder
        }
      }
    } catch (e: any) {
      setChannels(routeId, previousChannels);
      toast.error(e.message || '保存通道优先级失败，已回滚');
    } finally {
      setSavingPriorityByRoute((prev) => ({ ...prev, [routeId]: false }));
    }
  };

  const handleResetPriority = async (routeId: number) => {
    if (resettingPriorityByRoute[routeId]) return;
    setResettingPriorityByRoute((prev) => ({ ...prev, [routeId]: true }));
    try {
      await api.resetRouteChannelPriority(routeId);
      invalidateProbeStateForRoute(routeId);
      toast.success(tr('已重置所有通道优先级为 P0'));
      await loadChannels(routeId, true);

      const route = routeSummaries.find((r) => r.id === routeId);
      if (route && isRouteExactModel(route)) {
        try {
          const res = await api.getRouteDecision(route.modelPattern);
          setDecisionByRoute((prev) => ({
            ...prev,
            [routeId]: (res?.decision || null) as RouteDecision | null,
          }));
        } catch {
          // ignore route decision refresh failures
        }
      }
    } catch (e: any) {
      toast.error(e.message || tr('重置优先级失败'));
    } finally {
      setResettingPriorityByRoute((prev) => ({ ...prev, [routeId]: false }));
    }
  };

  const handleSiteBlockModel = async (channelId: number, routeId: number) => {
    const channels = channelsByRouteId[routeId] || [];
    const channel = channels.find((c) => c.id === channelId);
    if (!channel?.site?.id) {
      toast.error('找不到通道对应的站点信息');
      return;
    }
    const route = routeSummaries.find((r) => r.id === routeId);
    const modelName = channel.sourceModel || (route && isExactModelPattern(route.modelPattern) ? route.modelPattern : '') || '';
    if (!modelName) {
      toast.error('该通道没有精确模型名，无法使用站点屏蔽（通配符路由请在站点编辑中手动禁用）');
      return;
    }
    const siteName = channel.site.name || '未知站点';
    const confirmed = await new Promise<boolean>((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:9999;display:flex;align-items:center;justify-content:center';
      const dialog = document.createElement('div');
      dialog.style.cssText = 'background:var(--color-bg-card,#fff);border-radius:12px;padding:24px;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.2)';
      dialog.innerHTML = `
        <div style="font-weight:600;font-size:15px;margin-bottom:12px">确认站点屏蔽</div>
        <div style="font-size:13px;color:var(--color-text-secondary);line-height:1.6;margin-bottom:16px">
          将模型「<b>${escapeHtml(modelName)}</b>」加入站点「<b>${escapeHtml(siteName)}</b>」的禁用列表。<br/>执行后将自动触发路由重建，该站点下此模型的通道将不再生成。
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <button id="__sb_cancel" class="btn btn-ghost" style="padding:6px 16px">取消</button>
          <button id="__sb_confirm" class="btn btn-warning" style="padding:6px 16px">确认屏蔽</button>
        </div>
      `;
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
      dialog.querySelector('#__sb_cancel')!.addEventListener('click', () => { document.body.removeChild(overlay); resolve(false); });
      dialog.querySelector('#__sb_confirm')!.addEventListener('click', () => { document.body.removeChild(overlay); resolve(true); });
      overlay.addEventListener('click', (e) => { if (e.target === overlay) { document.body.removeChild(overlay); resolve(false); } });
    });
    if (!confirmed) return;

    try {
      const siteId = channel.site.id;
      const existing = await api.getSiteDisabledModels(siteId);
      const currentModels: string[] = existing?.models || [];
      if (currentModels.includes(modelName)) {
        toast.info(`模型「${modelName}」已在站点「${siteName}」的禁用列表中`);
        return;
      }
      await api.updateSiteDisabledModels(siteId, [...currentModels, modelName]);
      toast.success(`已将「${modelName}」加入站点「${siteName}」的禁用列表，正在重建路由...`);
      await api.rebuildRoutes(false);
      invalidateChannels();
      await load();
    } catch (e: any) {
      toast.error(e.message || '站点屏蔽模型失败');
    }
  };

  const toggleExpand = async (routeId: number) => {
    const isCurrentlyExpanded = expandedRouteIds.includes(routeId);
    if (isCurrentlyExpanded) {
      setExpandedRouteIds((prev) => prev.filter((id) => id !== routeId));
    } else {
      loadCandidates();
      setExpandedRouteIds((prev) => [...prev, routeId]);
      // Load channels on demand
      const route = routeById.get(routeId) || null;
      const isReadOnlyRoute = route?.kind === 'zero_channel' || route?.readOnly === true || route?.isVirtual === true;
      if (!channelsByRouteId[routeId] && !isReadOnlyRoute) {
        try {
          await loadChannels(routeId);
        } catch {
          toast.error('加载通道失败');
        }
      }
    }
  };

  const getMissingTokenSiteItems = (routeId: number): MissingTokenRouteSiteActionItem[] => {
    const missingTokenHints = getRouteMissingTokenHints(routeId);
    if (missingTokenHints.length === 0) return EMPTY_MISSING_ITEMS;
    const siteMap = new Map<string, MissingTokenRouteSiteActionItem>();
    for (const hint of missingTokenHints) {
      for (const account of hint.accounts) {
        if (!Number.isFinite(account.accountId) || account.accountId <= 0) continue;
        const siteName = (account.siteName || '').trim() || `site-${account.siteId || 'unknown'}`;
        const key = `${account.siteId || 0}::${siteName.toLowerCase()}`;
        const accountLabel = account.username || `account-${account.accountId}`;
        const existing = siteMap.get(key);
        if (!existing) {
          siteMap.set(key, { key, siteName, accountId: account.accountId, accountLabel });
          continue;
        }
        if (account.accountId < existing.accountId) {
          existing.accountId = account.accountId;
          existing.accountLabel = accountLabel;
        }
      }
    }
    return Array.from(siteMap.values()).sort((a, b) => (
      a.siteName.localeCompare(b.siteName, undefined, { sensitivity: 'base' })
    ));
  };

  const getMissingTokenGroupItems = (routeId: number): MissingTokenGroupRouteSiteActionItem[] => {
    const missingGroupHints = getRouteMissingTokenGroupHints(routeId);
    if (missingGroupHints.length === 0) return EMPTY_MISSING_GROUP_ITEMS;
    const siteMap = new Map<string, MissingTokenGroupRouteSiteActionItem>();
    for (const hint of missingGroupHints) {
      for (const account of hint.accounts) {
        if (!Number.isFinite(account.accountId) || account.accountId <= 0) continue;
        const siteName = (account.siteName || '').trim() || `site-${account.siteId || 'unknown'}`;
        const key = `${account.siteId || 0}::${siteName.toLowerCase()}`;
        const accountLabel = account.username || `account-${account.accountId}`;
        const missingGroups = Array.isArray(account.missingGroups) ? account.missingGroups : [];
        const requiredGroups = Array.isArray(account.requiredGroups) ? account.requiredGroups : [];
        const availableGroups = Array.isArray(account.availableGroups) ? account.availableGroups : [];
        const existing = siteMap.get(key);
        if (!existing) {
          siteMap.set(key, {
            key,
            siteName,
            accountId: account.accountId,
            accountLabel,
            missingGroups: [...missingGroups],
            requiredGroups: [...requiredGroups],
            availableGroups: [...availableGroups],
            ...(account.groupCoverageUncertain === true ? { groupCoverageUncertain: true } : {}),
          });
          continue;
        }
        if (account.accountId < existing.accountId) {
          existing.accountId = account.accountId;
          existing.accountLabel = accountLabel;
        }
        existing.missingGroups = Array.from(new Set([...existing.missingGroups, ...missingGroups]))
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        existing.requiredGroups = Array.from(new Set([...existing.requiredGroups, ...requiredGroups]))
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        existing.availableGroups = Array.from(new Set([...existing.availableGroups, ...availableGroups]))
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        if (account.groupCoverageUncertain === true) {
          existing.groupCoverageUncertain = true;
        }
      }
    }
    return Array.from(siteMap.values()).sort((a, b) => (
      a.siteName.localeCompare(b.siteName, undefined, { sensitivity: 'base' })
    ));
  };

  // Stable callbacks for RouteCard memo (use refs to avoid dependency on closure variables)
  const toggleExpandRef = useRef(toggleExpand);
  toggleExpandRef.current = toggleExpand;
  const stableToggleExpand = useCallback((routeId: number) => toggleExpandRef.current(routeId), []);
  const handleEditRouteRef = useRef(handleEditRoute);
  handleEditRouteRef.current = handleEditRoute;
  const stableEditRoute = useCallback((route: RouteSummaryRow) => handleEditRouteRef.current(route), []);
  const handleDeleteRouteRef = useRef(handleDeleteRoute);
  handleDeleteRouteRef.current = handleDeleteRoute;
  const stableDeleteRoute = useCallback((routeId: number) => { handleDeleteRouteRef.current(routeId); }, []);
  const handleToggleEnabledRef = useRef(handleToggleRouteEnabled);
  handleToggleEnabledRef.current = handleToggleRouteEnabled;
  const stableToggleEnabled = useCallback((route: RouteSummaryRow) => { handleToggleEnabledRef.current(route); }, []);
  const handleRoutingStrategyChangeRef = useRef(handleRoutingStrategyChange);
  handleRoutingStrategyChangeRef.current = handleRoutingStrategyChange;
  const stableRoutingStrategyChange = useCallback(
    (route: RouteSummaryRow, strategy: RouteRoutingStrategy) => handleRoutingStrategyChangeRef.current(route, strategy),
    [],
  );
  const stableAddChannel = useCallback((routeId: number) => {
    loadCandidates();
    setAddChannelModalRouteId(routeId);
  }, []);
  const stableToggleSourceGroup = useCallback(
    (groupKey: string) => setExpandedSourceGroupMap((prev) => ({ ...prev, [groupKey]: !prev[groupKey] })),
    [],
  );
  const handleChannelSettingsSaveRef = useRef(handleChannelSettingsSave);
  handleChannelSettingsSaveRef.current = handleChannelSettingsSave;
  const stableChannelSettingsSave = useCallback(
    (routeId: number, channelId: number, accountId: number, updates: { tokenId?: number | null; priority?: number; weight?: number }) =>
      handleChannelSettingsSaveRef.current(routeId, channelId, accountId, updates),
    [],
  );
  const handleDeleteChannelRef = useRef(handleDeleteChannel);
  handleDeleteChannelRef.current = handleDeleteChannel;
  const stableDeleteChannel = useCallback(
    (channelId: number, routeId: number) => handleDeleteChannelRef.current(channelId, routeId),
    [],
  );
  const handleToggleChannelEnabledRef = useRef(handleToggleChannelEnabled);
  handleToggleChannelEnabledRef.current = handleToggleChannelEnabled;
  const stableToggleChannelEnabled = useCallback(
    (channelId: number, routeId: number, enabled: boolean) => handleToggleChannelEnabledRef.current(channelId, routeId, enabled),
    [],
  );
  const handleChannelDragEndRef = useRef(handleChannelDragEnd);
  handleChannelDragEndRef.current = handleChannelDragEnd;
  const stableChannelDragEnd = useCallback(
    (routeId: number, event: DragEndEvent) => handleChannelDragEndRef.current(routeId, event),
    [],
  );
  const handleCreateTokenRef = useRef(handleCreateTokenForMissingAccount);
  handleCreateTokenRef.current = handleCreateTokenForMissingAccount;
  const stableCreateTokenForMissing = useCallback(
    (accountId: number, modelName: string) => handleCreateTokenRef.current(accountId, modelName),
    [],
  );
  const handleSiteBlockModelRef = useRef(handleSiteBlockModel);
  handleSiteBlockModelRef.current = handleSiteBlockModel;
  const stableSiteBlockModel = useCallback(
    (channelId: number, routeId: number) => handleSiteBlockModelRef.current(channelId, routeId),
    [],
  );
  const handleResetPriorityRef = useRef(handleResetPriority);
  handleResetPriorityRef.current = handleResetPriority;
  const stableResetPriority = useCallback(
    (routeId: number) => handleResetPriorityRef.current(routeId),
    [],
  );
  const handleProbeChannelRef = useRef(handleProbeChannel);
  handleProbeChannelRef.current = handleProbeChannel;
  const stableProbeChannel = useCallback(
    (channelId: number) => handleProbeChannelRef.current(channelId),
    [],
  );
  const handleProbeRouteChannelsRef = useRef(handleProbeRouteChannels);
  handleProbeRouteChannelsRef.current = handleProbeRouteChannels;
  const stableProbeRouteChannels = useCallback(
    (routeId: number) => handleProbeRouteChannelsRef.current(routeId),
    [],
  );
  const handleApplyProbeRankingRef = useRef(handleApplyProbeRanking);
  handleApplyProbeRankingRef.current = handleApplyProbeRanking;
  const stableApplyProbeRanking = useCallback(
    (routeId: number) => handleApplyProbeRankingRef.current(routeId),
    [],
  );
  const handleClearRouteProbeSessionRef = useRef(handleClearRouteProbeSession);
  handleClearRouteProbeSessionRef.current = handleClearRouteProbeSession;
  const stableClearRouteProbeSession = useCallback(
    (routeId: number) => handleClearRouteProbeSessionRef.current(routeId),
    [],
  );

  const handleResetSiteHealth = async (siteId: number) => {
    try {
      const res = await api.resetSiteHealth(siteId);
      toast.success(res.message || '已清除站点运行时惩罚');
      // Refresh route decisions so badges reflect the reset immediately
      loadRouteDecisions(routeSummaries, { force: true, persistSnapshots: true }).catch(() => {});
      // Refresh expanded routes' channel lists; invalidate collapsed-but-cached
      // routes so they re-fetch fresh data when expanded again.
      for (const routeId of Object.keys(channelsByRouteId).map(Number)) {
        if (expandedRouteIds.includes(routeId)) {
          loadChannels(routeId, true).catch(() => {});
        } else {
          invalidateChannels(routeId);
        }
      }
    } catch (e: unknown) {
      toast.error((e instanceof Error ? e.message : null) || '清除站点惩罚失败');
    }
  };
  const handleResetSiteHealthRef = useRef(handleResetSiteHealth);
  handleResetSiteHealthRef.current = handleResetSiteHealth;
  const stableResetSiteHealth = useCallback(
    (siteId: number) => handleResetSiteHealthRef.current(siteId),
    [],
  );

  const handleResetChannelCooldown = async (channelId: number) => {
    try {
      const res = await api.resetChannelCooldown(channelId);
      toast.success(res.message || '已解除通道冷却');
      loadRouteDecisions(routeSummaries, { force: true, persistSnapshots: true }).catch(() => {});
      // Refresh or invalidate the channel list for the route containing this channel
      for (const routeId of Object.keys(channelsByRouteId).map(Number)) {
        const channels = channelsByRouteId[routeId];
        if (channels?.some((ch) => ch.id === channelId)) {
          if (expandedRouteIds.includes(routeId)) {
            loadChannels(routeId, true).catch(() => {});
          } else {
            invalidateChannels(routeId);
          }
          break;
        }
      }
    } catch (e: unknown) {
      toast.error((e instanceof Error ? e.message : null) || '解除通道冷却失败');
    }
  };
  const handleResetChannelCooldownRef = useRef(handleResetChannelCooldown);
  handleResetChannelCooldownRef.current = handleResetChannelCooldown;
  const stableResetChannelCooldown = useCallback(
    (channelId: number) => handleResetChannelCooldownRef.current(channelId),
    [],
  );

  const handleClearRouteCooldown = async (routeId: number) => {
    if (clearingCooldownByRoute[routeId]) return;
    setClearingCooldownByRoute((prev) => ({ ...prev, [routeId]: true }));
    try {
      const res = await api.clearRouteCooldown(routeId) as { message?: string };
      try {
        if (expandedRouteIds.includes(routeId)) {
          await loadChannels(routeId, true);
        } else {
          invalidateChannels(routeId);
        }

        const route = routeSummaries.find((item) => item.id === routeId);
        if (route) {
          if (isRouteExactModel(route)) {
            const decisionRes = await api.getRouteDecision(route.modelPattern);
            setDecisionByRoute((prev) => ({
              ...prev,
              [routeId]: (decisionRes?.decision || null) as RouteDecision | null,
            }));
          } else {
            const decisionRes = await api.getRouteWideDecisionsBatch([routeId], { persistSnapshots: true });
            setDecisionByRoute((prev) => ({
              ...prev,
              [routeId]: (decisionRes?.decisions?.[String(routeId)] || null) as RouteDecision | null,
            }));
          }
        }

        toast.success(res.message || '已清除路由冷却');
      } catch {
        toast.error('已清除，但刷新失败');
      }
    } catch (e: unknown) {
      toast.error((e instanceof Error ? e.message : null) || '清除路由冷却失败');
    } finally {
      setClearingCooldownByRoute((prev) => ({ ...prev, [routeId]: false }));
    }
  };
  const handleClearRouteCooldownRef = useRef(handleClearRouteCooldown);
  handleClearRouteCooldownRef.current = handleClearRouteCooldown;
  const stableClearRouteCooldown = useCallback(
    (routeId: number) => handleClearRouteCooldownRef.current(routeId),
    [],
  );

  const addChannelModalRoute = addChannelModalRouteId
    ? routeSummaries.find((r) => r.id === addChannelModalRouteId) || null
    : null;

  const handleAddChannelSuccess = async () => {
    if (!addChannelModalRouteId) return;
    invalidateProbeStateForRoute(addChannelModalRouteId);
    // Reload channels for this route
    await loadChannels(addChannelModalRouteId, true);
    // Refresh summary to update channel count
    await load();
  };

  return (
    <div className="animate-fade-in" style={{ minHeight: 400 }}>
      {/* Toolbar: search + sort + actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div className="toolbar-search" style={{ minWidth: 220, flex: 1, maxWidth: 360 }}>
          <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={tr('搜索模型路由...')}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ minWidth: 128 }}>
            <ModernSelect
              size="sm"
              value={sortBy}
              onChange={(nextValue) => {
                const nextSortBy = nextValue as RouteSortBy;
                setSortBy(nextSortBy);
                setSortDir(nextSortBy === 'modelPattern' ? 'asc' : 'desc');
              }}
              options={[
                { value: 'modelPattern', label: tr('模型名称') },
                { value: 'channelCount', label: tr('通道数量') },
              ]}
              placeholder={tr('排序字段')}
            />
          </div>
          <button
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 12px', fontSize: 12 }}
            onClick={() => setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
            data-tooltip={tr('切换排序方向')}
            aria-label={tr('切换排序方向')}
          >
            {sortDir === 'asc' ? tr('升序 ↑') : tr('降序 ↓')}
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderLeft: '1px solid var(--color-border)', paddingLeft: 8 }}>
          <button
            onClick={handleRefreshRouteDecisions}
            disabled={loadingDecision}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
          >
            {loadingDecision ? (
              <><span className="spinner spinner-sm" /> {tr('刷新中...')}</>
            ) : (
              tr('刷新选中概率')
            )}
          </button>

          <button
            onClick={handleRebuild}
            disabled={rebuilding}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
          >
            {rebuilding ? (
              <><span className="spinner spinner-sm" /> {tr('重建中...')}</>
            ) : (
              tr('自动重建')
            )}
          </button>

          <button
            onClick={() => {
              loadCandidates();
              resetRouteForm();
              setShowManual(true);
            }}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
          >
            {tr('新建群组')}
          </button>

          <button
            onClick={toggleBatchSelectMode}
            className={`btn ${batchSelectMode ? 'btn-primary' : 'btn-ghost'}`}
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
          >
            {batchSelectMode ? tr('退出批量') : tr('批量操作')}
          </button>

          <button
            type="button"
            aria-pressed={showZeroChannelRoutes}
            onClick={() => {
              if (!showZeroChannelRoutes) loadCandidates();
              setShowZeroChannelRoutes((prev) => !prev);
            }}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
          >
            {showZeroChannelRoutes ? tr('隐藏 0 通道路由') : tr('显示 0 通道路由')}
          </button>
        </div>

        <span className="badge badge-info" style={{ fontSize: 12, fontWeight: 500, marginLeft: 'auto' }}>
          {tr('共')} {filteredRoutes.length} {tr('条路由')}
        </span>
      </div>

      {/* Collapsible filter panel */}
      <ResponsiveFilterPanel
        isMobile={isMobile}
        mobileOpen={showFilters}
        onMobileClose={() => setShowFilters(false)}
        mobileTitle={tr('筛选路由')}
        mobileTriggerWrapperClassName=""
        mobileTrigger={(
          <button
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px', marginBottom: 12 }}
            onClick={() => {
              loadCandidates();
              setShowFilters(true);
            }}
          >
            {tr('筛选')}
          </button>
        )}
        mobileContent={(
          <RouteFilterBar
            totalRouteCount={baseFilteredRoutes.length}
            activeBrand={activeBrand}
            setActiveBrand={setActiveBrand}
            activeSite={activeSite}
            setActiveSite={setActiveSite}
            activeEndpointType={activeEndpointType}
            setActiveEndpointType={setActiveEndpointType}
            activeGroupFilter={activeGroupFilter}
            setActiveGroupFilter={setActiveGroupFilter}
            enabledFilter={enabledFilter}
            setEnabledFilter={setEnabledFilter}
            enabledCounts={enabledCounts}
            brandList={brandList}
            siteList={siteList}
            endpointTypeList={endpointTypeList}
            groupRouteList={groupRouteList}
            collapsed={false}
            onToggle={() => setShowFilters(false)}
          />
        )}
        desktopContent={(
          <RouteFilterBar
            totalRouteCount={baseFilteredRoutes.length}
            activeBrand={activeBrand}
            setActiveBrand={setActiveBrand}
            activeSite={activeSite}
            setActiveSite={setActiveSite}
            activeEndpointType={activeEndpointType}
            setActiveEndpointType={setActiveEndpointType}
            activeGroupFilter={activeGroupFilter}
            setActiveGroupFilter={setActiveGroupFilter}
            enabledFilter={enabledFilter}
            setEnabledFilter={setEnabledFilter}
            enabledCounts={enabledCounts}
            brandList={brandList}
            siteList={siteList}
            endpointTypeList={endpointTypeList}
            groupRouteList={groupRouteList}
            collapsed={filterCollapsed}
            onToggle={() => {
              if (filterCollapsed) loadCandidates();
              setFilterCollapsed((prev) => !prev);
            }}
          />
        )}
      />

      {/* Info tip */}
      <div className="info-tip" style={{ marginBottom: 12 }}>
        {tr('系统会根据模型可用性自动生成路由。精确模型路由会自动过滤只支持该模型的账号和令牌。优先级 P0 最高，数字越大优先级越低。选中概率表示请求到达时该通道被选中的概率。成本来源优先级为：实测成本 → 账号配置成本 → 目录参考价 → 默认回退单价。')}
      </div>

      {/* Manual route panel */}
      <ManualRoutePanel
        show={showManual}
        editingRouteId={editingRouteId}
        form={form}
        setForm={setForm}
        saving={saving}
        canSave={canSaveRoute}
        routeIconSelectOptions={routeIconSelectOptions}
        previewModelSamples={previewModelSamples}
        exactSourceRouteOptions={exactSourceRouteOptions}
        sourceEndpointTypesByRouteId={sourceEndpointTypesByRouteId}
        onSave={handleAddRoute}
        onCancel={handleCancelEditRoute}
      />

      {/* Route card grid */}
      {/* Batch selection floating bar */}
      {batchSelectMode && (
        <div style={{
          position: 'sticky', top: 0, zIndex: 50,
          background: 'var(--color-bg-card, #fff)',
          border: '1px solid var(--color-border)',
          borderRadius: 8, padding: '10px 16px',
          marginBottom: 12,
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
        }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>
            {tr('已选择')} <b>{selectedRouteIds.size}</b> / {selectableRouteIds.size} {tr('条路由')}
          </span>
          <button className="btn btn-ghost" style={{ padding: '4px 12px', fontSize: 12 }} onClick={selectAllRoutes}>{tr('全选')}</button>
          <button className="btn btn-ghost" style={{ padding: '4px 12px', fontSize: 12 }} onClick={deselectAllRoutes}>{tr('取消全选')}</button>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button
              className="btn btn-warning"
              style={{ padding: '6px 16px', fontSize: 13 }}
              disabled={selectedRouteIds.size === 0 || batchUpdatingRoutes}
              onClick={() => handleBatchUpdateRoutes('disable')}
            >
              {batchUpdatingRoutes ? <><span className="spinner spinner-sm" /> {tr('处理中...')}</> : tr('批量禁用')}
            </button>
            <button
              className="btn btn-primary"
              style={{ padding: '6px 16px', fontSize: 13 }}
              disabled={selectedRouteIds.size === 0 || batchUpdatingRoutes}
              onClick={() => handleBatchUpdateRoutes('enable')}
            >
              {batchUpdatingRoutes ? <><span className="spinner spinner-sm" /> {tr('处理中...')}</> : tr('批量启用')}
            </button>
          </div>
        </div>
      )}

      <div className={isMobile ? 'mobile-card-list' : 'route-card-grid'}>
        {visibleRoutes.map((route) => {
          const isExpanded = expandedRouteIds.includes(route.id);
          const isReadOnlyRoute = route.kind === 'zero_channel' || route.readOnly === true || route.isVirtual === true;
          const exactRoute = isRouteExactModel(route);
          const explicitGroupRoute = isExplicitGroupRoute(route);
          const channelManagementDisabled = explicitGroupRoute;
          const routeTitle = resolveRouteTitle(route);

          const isSelectable = selectableRouteIds.has(route.id);
          const isSelected = selectedRouteIds.has(route.id);

          if (isMobile) {
            return (
              <div key={route.id} style={{ display: 'grid', gap: 8 }}>
                <MobileCard
                  title={routeTitle}
                  headerActions={(
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {batchSelectMode && isSelectable && (
                        <label
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 12 }}
                        >
                          <input
                            data-testid={`route-select-${route.id}`}
                            aria-label={`选择路由 ${routeTitle}`}
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleRouteSelection(route.id)}
                            style={{ width: 16, height: 16, cursor: 'pointer', accentColor: 'var(--color-primary, #4f46e5)' }}
                          />
                          <span>{tr('选择')}</span>
                        </label>
                      )}
                      <span className={`badge ${isReadOnlyRoute ? 'badge-muted' : (route.enabled ? 'badge-success' : 'badge-muted')}`} style={{ fontSize: 10 }}>
                        {isReadOnlyRoute ? tr('未生成') : (route.enabled ? tr('启用') : tr('禁用'))}
                      </span>
                    </div>
                  )}
                  footerActions={(
                    <>
                      <button
                        type="button"
                        className="btn btn-link"
                        onClick={() => toggleExpand(route.id)}
                      >
                        {isExpanded ? tr('收起') : tr('详情')}
                      </button>
                      {!isReadOnlyRoute && (
                        <button
                          type="button"
                          className="btn btn-link"
                          onClick={() => handleEditRoute(route)}
                        >
                          {tr('编辑')}
                        </button>
                      )}
                      {!isReadOnlyRoute && (
                        <button
                          type="button"
                          className="btn btn-link"
                          onClick={() => handleToggleRouteEnabled(route)}
                        >
                          {route.enabled ? tr('禁用') : tr('启用')}
                        </button>
                      )}
                      {!isReadOnlyRoute && !channelManagementDisabled && (
                        <button
                          type="button"
                          className="btn btn-link"
                          onClick={() => stableAddChannel(route.id)}
                        >
                          {tr('添加通道')}
                        </button>
                      )}
                    </>
                  )}
                >
                  <MobileField label="模型" value={route.modelPattern} stacked />
                  <MobileField label="通道" value={route.channelCount} />
                  <MobileField label="策略" value={isReadOnlyRoute ? tr('未生成') : getRouteRoutingStrategyLabel(route.routingStrategy)} />
                  <MobileField label="状态" value={isReadOnlyRoute ? tr('未生成') : (route.enabled ? tr('启用') : tr('禁用'))} />
                  {explicitGroupRoute && (
                    <MobileField label="模式" value={tr('群组聚合')} />
                  )}
                  {!exactRoute && !explicitGroupRoute && (
                    <MobileField label="模式" value={tr('通配符路由')} />
                  )}
                </MobileCard>
                {isExpanded && (
                  <RouteCard
                    route={route}
                    brand={routeBrandById.get(route.id) || null}
                    expanded
                    compact
                    onToggleExpand={stableToggleExpand}
                    onEdit={stableEditRoute}
                    onDelete={stableDeleteRoute}
                    onToggleEnabled={stableToggleEnabled}
                    onClearCooldown={stableClearRouteCooldown}
                    clearingCooldown={!!clearingCooldownByRoute[route.id]}
                    onRoutingStrategyChange={stableRoutingStrategyChange}
                    updatingRoutingStrategy={!!updatingRoutingStrategyByRoute[route.id]}
                    channels={channelsByRouteId[route.id]}
                    loadingChannels={!!loadingChannelsByRouteId[route.id]}
                    routeDecision={decisionByRoute[route.id] || null}
                    loadingDecision={loadingDecision}
                    candidateView={getRouteCandidateView(route.id)}

                    updatingChannel={updatingChannel}
                    savingPriority={!!savingPriorityByRoute[route.id]}
                    onSaveSettings={stableChannelSettingsSave}
                    onDeleteChannel={stableDeleteChannel}
                    onToggleChannelEnabled={stableToggleChannelEnabled}
                    onChannelDragEnd={stableChannelDragEnd}
                    missingTokenSiteItems={getMissingTokenSiteItems(route.id)}
                    missingTokenGroupItems={getMissingTokenGroupItems(route.id)}
                    onCreateTokenForMissing={stableCreateTokenForMissing}
                    onAddChannel={stableAddChannel}
                    onResetPriority={stableResetPriority}
                    resettingPriority={!!resettingPriorityByRoute[route.id]}
                    onSiteBlockModel={stableSiteBlockModel}
                    expandedSourceGroupMap={expandedSourceGroupMap}
                    onToggleSourceGroup={stableToggleSourceGroup}
                    onResetSiteHealth={stableResetSiteHealth}
                    onResetChannelCooldown={stableResetChannelCooldown}
                    onProbeRouteChannels={stableProbeRouteChannels}
                    routeProbeSession={routeProbeSessions[route.id]}
                    routeProbeSnapshot={routeProbeSnapshots[route.id]}
                    onApplyProbeRanking={stableApplyProbeRanking}
                    onClearRouteProbeSession={stableClearRouteProbeSession}
                    onProbeChannel={stableProbeChannel}
                    probingChannelIds={probingChannelIds}
                    channelProbeResults={channelProbeResults}
                  />
                )}
              </div>
            );
          }

          const routeCard = (
            <RouteCard
              key={route.id}
              route={route}
              brand={routeBrandById.get(route.id) || null}
              expanded={isExpanded}
              onToggleExpand={stableToggleExpand}
              onEdit={stableEditRoute}
              onDelete={stableDeleteRoute}
              onToggleEnabled={stableToggleEnabled}
              onClearCooldown={stableClearRouteCooldown}
              clearingCooldown={!!clearingCooldownByRoute[route.id]}
              onRoutingStrategyChange={stableRoutingStrategyChange}
              updatingRoutingStrategy={!!updatingRoutingStrategyByRoute[route.id]}
              channels={channelsByRouteId[route.id]}
              loadingChannels={!!loadingChannelsByRouteId[route.id]}
              routeDecision={decisionByRoute[route.id] || null}
              loadingDecision={loadingDecision}
              candidateView={getRouteCandidateView(route.id)}
              updatingChannel={updatingChannel}
              savingPriority={!!savingPriorityByRoute[route.id]}
              onSaveSettings={stableChannelSettingsSave}
              onDeleteChannel={stableDeleteChannel}
              onToggleChannelEnabled={stableToggleChannelEnabled}
              onChannelDragEnd={stableChannelDragEnd}
              missingTokenSiteItems={getMissingTokenSiteItems(route.id)}
              missingTokenGroupItems={getMissingTokenGroupItems(route.id)}
              onCreateTokenForMissing={stableCreateTokenForMissing}
              onAddChannel={stableAddChannel}
              onResetPriority={stableResetPriority}
              resettingPriority={!!resettingPriorityByRoute[route.id]}
              onSiteBlockModel={stableSiteBlockModel}
              expandedSourceGroupMap={expandedSourceGroupMap}
              onToggleSourceGroup={stableToggleSourceGroup}
              onResetSiteHealth={stableResetSiteHealth}
              onResetChannelCooldown={stableResetChannelCooldown}
              onProbeRouteChannels={stableProbeRouteChannels}
              routeProbeSession={routeProbeSessions[route.id]}
              routeProbeSnapshot={routeProbeSnapshots[route.id]}
              onApplyProbeRanking={stableApplyProbeRanking}
              onClearRouteProbeSession={stableClearRouteProbeSession}
              onProbeChannel={stableProbeChannel}
              probingChannelIds={probingChannelIds}
              channelProbeResults={channelProbeResults}
            />
          );

          if (batchSelectMode && isSelectable) {
            return (
              <div key={route.id} style={{ display: 'flex', gap: 0, alignItems: 'stretch', ...(isExpanded ? { gridColumn: '1 / -1' } : {}) }}>
                <div
                  onClick={() => toggleRouteSelection(route.id)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: 36, minHeight: '100%', cursor: 'pointer',
                    borderRadius: '8px 0 0 8px',
                    background: isSelected ? 'var(--color-primary, #4f46e5)' : 'var(--color-bg-card, #fff)',
                    border: '1px solid var(--color-border)',
                    borderRight: 'none',
                    transition: 'background 0.15s',
                  }}
                >
                  <input
                    data-testid={`route-select-${route.id}`}
                    aria-label={`选择路由 ${routeTitle}`}
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleRouteSelection(route.id)}
                    onClick={(e) => e.stopPropagation()}
                    style={{ width: 16, height: 16, cursor: 'pointer', accentColor: 'var(--color-primary, #4f46e5)' }}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {routeCard}
                </div>
              </div>
            );
          }

          return routeCard;
        })}
      </div>

      {shouldShowLoadMore && (
        <div
          ref={loadMoreSentinelRef}
          style={{ textAlign: 'center', padding: '12px 0', fontSize: 12, color: 'var(--color-text-muted)' }}
        >
          {tr('当前已加载路由')} {visibleRouteCount} / {filteredRoutes.length}
        </div>
      )}

      {filteredRoutes.length === 0 && (
        <div className="card">
          <div className="empty-state">
            <svg className="empty-state-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1}
                d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
              />
            </svg>
            <div className="empty-state-title">{routeSummaries.length === 0 ? '暂无路由' : '没有匹配的路由'}</div>
            <div className="empty-state-desc">
              {routeSummaries.length === 0
                ? '点击"自动重建"可按当前模型可用性生成路由。'
                : '请调整品牌筛选、搜索词或排序条件。'}
            </div>
          </div>
        </div>
      )}

      {/* Add channel modal */}
      {addChannelModalRoute && (
        <AddChannelModal
          open={!!addChannelModalRouteId}
          onClose={() => setAddChannelModalRouteId(null)}
          routeId={addChannelModalRoute.id}
          routeTitle={resolveRouteTitle(addChannelModalRoute)}
          candidateView={getRouteCandidateView(addChannelModalRoute.id)}
          onSuccess={handleAddChannelSuccess}
          missingTokenHints={getRouteMissingTokenHints(addChannelModalRoute.id)}
          onCreateTokenForMissing={handleCreateTokenForMissingAccount}
          existingChannelAccountIds={new Set((channelsByRouteId[addChannelModalRoute.id] || []).map((c) => c.accountId))}
        />
      )}
    </div>
  );
}

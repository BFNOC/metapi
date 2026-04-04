export type IndexedRouteModelCandidate = {
  modelName: string;
  accountId: number;
  tokenId: number;
  tokenName: string;
  isDefault: boolean;
  username: string | null;
  siteId: number;
  siteName: string;
};

export type RouteModelCandidatesByModelName = Record<string, IndexedRouteModelCandidate[]>;

export type IndexedDirectAccountCandidate = {
  modelName: string;
  accountId: number;
  username: string | null;
  siteId: number;
  siteName: string;
  connectionMode: 'apikey' | 'oauth';
};

export type DirectAccountCandidatesByModelName = Record<string, IndexedDirectAccountCandidate[]>;

export type RouteAccountOption = {
  id: number;
  label: string;
};

export type RouteTokenOption = {
  id: number;
  name: string;
  isDefault: boolean;
  sourceModel?: string;
};

export type RouteCandidateView = {
  routeCandidates: IndexedRouteModelCandidate[];
  accountOptions: RouteAccountOption[];
  tokenOptionsByAccountId: Record<number, RouteTokenOption[]>;
  directBindingOptionsByAccountId?: Record<number, Array<{
    connectionMode: 'apikey' | 'oauth';
    sourceModel?: string;
  }>>;
};

export type RouteModelPatternLike = {
  id: number;
  modelPattern: string;
  routeMode?: string | null;
};

const EMPTY_ROUTE_CANDIDATE_VIEW: RouteCandidateView = {
  routeCandidates: [],
  accountOptions: [],
  tokenOptionsByAccountId: {},
  directBindingOptionsByAccountId: {},
};

export function buildRouteModelCandidatesIndex(
  routes: RouteModelPatternLike[],
  modelCandidates: RouteModelCandidatesByModelName,
  directAccountCandidates: DirectAccountCandidatesByModelName,
  matchesModelPattern: (model: string, pattern: string) => boolean,
): Record<number, RouteCandidateView> {
  const index: Record<number, RouteCandidateView> = {};

  for (const route of routes || []) {
    if (route.routeMode === 'explicit_group') {
      index[route.id] = EMPTY_ROUTE_CANDIDATE_VIEW;
      continue;
    }
    const modelPattern = (route.modelPattern || '').trim();
    if (!modelPattern) {
      index[route.id] = EMPTY_ROUTE_CANDIDATE_VIEW;
      continue;
    }

    const deduped = new Map<string, IndexedRouteModelCandidate>();
    const dedupedDirectAccounts = new Map<string, IndexedDirectAccountCandidate>();
    for (const [modelName, candidates] of Object.entries(modelCandidates || {})) {
      if (!matchesModelPattern(modelName, modelPattern)) continue;
      for (const candidate of candidates || []) {
        const key = `${candidate.tokenId}::${modelName}`;
        if (!deduped.has(key)) {
          deduped.set(key, {
            ...candidate,
            modelName,
          });
        }
      }
    }
    for (const [modelName, candidates] of Object.entries(directAccountCandidates || {})) {
      if (!matchesModelPattern(modelName, modelPattern)) continue;
      for (const candidate of candidates || []) {
        const key = `${candidate.accountId}::${modelName}`;
        if (!dedupedDirectAccounts.has(key)) {
          dedupedDirectAccounts.set(key, {
            ...candidate,
            modelName,
          });
        }
      }
    }

    const routeCandidates = Array.from(deduped.values()).sort((a, b) => {
      if (a.accountId === b.accountId) return a.tokenId - b.tokenId;
      return a.accountId - b.accountId;
    });
    const directRouteCandidates = Array.from(dedupedDirectAccounts.values()).sort((a, b) => {
      if (a.accountId === b.accountId) {
        return a.modelName.localeCompare(b.modelName, undefined, { sensitivity: 'base' });
      }
      return a.accountId - b.accountId;
    });

    const accountMap = new Map<number, string>();
    const tokenOptionsByAccountId: Record<number, RouteTokenOption[]> = {};
    const directBindingOptionsByAccountId: Record<number, Array<{
      connectionMode: 'apikey' | 'oauth';
      sourceModel?: string;
    }>> = {};
    for (const candidate of routeCandidates) {
      if (!accountMap.has(candidate.accountId)) {
        accountMap.set(candidate.accountId, `${candidate.username || `account-${candidate.accountId}`} @ ${candidate.siteName}`);
      }
      if (!tokenOptionsByAccountId[candidate.accountId]) {
        tokenOptionsByAccountId[candidate.accountId] = [];
      }
      tokenOptionsByAccountId[candidate.accountId].push({
        id: candidate.tokenId,
        name: candidate.tokenName,
        isDefault: candidate.isDefault,
        sourceModel: candidate.modelName,
      });
    }
    for (const candidate of directRouteCandidates) {
      if (!accountMap.has(candidate.accountId)) {
        accountMap.set(candidate.accountId, `${candidate.username || `account-${candidate.accountId}`} @ ${candidate.siteName}`);
      }
      if (!directBindingOptionsByAccountId[candidate.accountId]) {
        directBindingOptionsByAccountId[candidate.accountId] = [];
      }
      const options = directBindingOptionsByAccountId[candidate.accountId];
      if (!options.some((item) => (
        item.connectionMode === candidate.connectionMode
        && (item.sourceModel || '') === candidate.modelName
      ))) {
        options.push({
          connectionMode: candidate.connectionMode,
          sourceModel: candidate.modelName,
        });
      }
    }

    for (const accountIdText of Object.keys(tokenOptionsByAccountId)) {
      const accountId = Number.parseInt(accountIdText, 10);
      tokenOptionsByAccountId[accountId].sort((a, b) => {
        if (a.isDefault === b.isDefault) {
          if (a.id === b.id) return (a.sourceModel || '').localeCompare(b.sourceModel || '', undefined, { sensitivity: 'base' });
          return a.id - b.id;
        }
        return a.isDefault ? -1 : 1;
      });
    }
    for (const accountIdText of Object.keys(directBindingOptionsByAccountId)) {
      const accountId = Number.parseInt(accountIdText, 10);
      directBindingOptionsByAccountId[accountId].sort((a, b) => (
        (a.sourceModel || '').localeCompare(b.sourceModel || '', undefined, { sensitivity: 'base' })
      ));
    }

    const accountOptions = Array.from(accountMap.entries())
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.id - b.id);
    index[route.id] = {
      routeCandidates,
      accountOptions,
      tokenOptionsByAccountId,
      directBindingOptionsByAccountId,
    };
  }

  return index;
}

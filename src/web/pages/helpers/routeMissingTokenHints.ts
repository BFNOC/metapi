export type MissingTokenModelAccount = {
  accountId: number;
  username: string | null;
  siteId: number;
  siteName: string;
};

export type MissingTokenModelsByName = Record<string, MissingTokenModelAccount[]>;

export type RouteMissingTokenHint = {
  modelName: string;
  accounts: MissingTokenModelAccount[];
};

type RoutePatternLike = {
  id: number;
  modelPattern: string;
};

export function normalizeMissingTokenModels(
  withoutTokenByModel: MissingTokenModelsByName,
): MissingTokenModelsByName {
  const normalized: MissingTokenModelsByName = {};
  for (const modelName of Object.keys(withoutTokenByModel || {})) {
    const normalizedModelName = String(modelName || '').trim();
    if (!normalizedModelName) continue;
    const accountMap = new Map<number, MissingTokenModelAccount>();
    for (const account of withoutTokenByModel[modelName] || []) {
      if (!account || !Number.isFinite(account.accountId)) continue;
      const accountName = (account.username || '').trim();
      const siteName = String(account.siteName || '').trim();
      accountMap.set(account.accountId, {
        accountId: account.accountId,
        username: accountName || null,
        siteId: account.siteId,
        siteName,
      });
    }
    if (accountMap.size > 0) {
      normalized[normalizedModelName] = Array.from(accountMap.values()).sort((a, b) => a.accountId - b.accountId);
    }
  }
  return normalized;
}

export function buildRouteMissingTokenIndex(
  routes: RoutePatternLike[],
  missingByModel: MissingTokenModelsByName,
  matchesModelPattern: (model: string, pattern: string) => boolean,
): Record<number, RouteMissingTokenHint[]> {
  const index: Record<number, RouteMissingTokenHint[]> = {};

  for (const route of routes || []) {
    const modelPattern = (route.modelPattern || '').trim();
    if (!modelPattern) {
      index[route.id] = [];
      continue;
    }

    const matchedHints: RouteMissingTokenHint[] = [];
    for (const [modelName, accounts] of Object.entries(missingByModel || {})) {
      if (!matchesModelPattern(modelName, modelPattern)) continue;
      const dedupedAccounts = new Map<number, MissingTokenModelAccount>();
      for (const account of accounts || []) {
        if (!account || !Number.isFinite(account.accountId)) continue;
        dedupedAccounts.set(account.accountId, account);
      }

      matchedHints.push({
        modelName,
        accounts: Array.from(dedupedAccounts.values()).sort((a, b) => {
          const siteCompare = String(a.siteName || '').localeCompare(String(b.siteName || ''), undefined, { sensitivity: 'base' });
          if (siteCompare !== 0) return siteCompare;
          return a.accountId - b.accountId;
        }),
      });
    }

    matchedHints.sort((a, b) => a.modelName.localeCompare(b.modelName, undefined, { sensitivity: 'base' }));
    index[route.id] = matchedHints;
  }

  return index;
}

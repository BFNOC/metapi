import { api } from '../api.js';

export type LoadModelMappingCandidatesInput = {
  accountId: number;
  siteId: number;
  siteModelFilterMode?: string | null;
};

export type ModelMappingLoaderResult = {
  availableModels: string[];
  filterMode: 'allow-list' | 'deny-list';
  filterApplied: boolean;
};

export async function loadModelMappingCandidates({
  accountId,
  siteId,
  siteModelFilterMode,
}: LoadModelMappingCandidatesInput): Promise<ModelMappingLoaderResult> {
  const filterMode = siteModelFilterMode === 'allow-list' ? 'allow-list' : 'deny-list';
  const modelsResult = await api.getAccountModels(accountId);
  const rawRows = Array.isArray(modelsResult?.models) ? modelsResult.models : [];
  const rawModels = rawRows
    .map((model: any) => String(model?.name || '').trim())
    .filter((model: string) => model.length > 0);

  if (filterMode === 'allow-list') {
    const allowedResult = await api.getSiteAllowedModels(siteId).catch(() => null);
    if (!allowedResult) {
      return {
        availableModels: [...rawModels].sort(),
        filterMode,
        filterApplied: false,
      };
    }

    const allowedSet = new Set(
      (Array.isArray(allowedResult.models) ? allowedResult.models : [])
        .map((model: unknown) => String(model || '').trim().toLowerCase())
        .filter((model: string) => model.length > 0),
    );

    return {
      availableModels: rawModels
        .filter((model: string) => allowedSet.has(model.toLowerCase()))
        .sort(),
      filterMode,
      filterApplied: true,
    };
  }

  const enabledModels = rawRows
    .filter((model: any) => !model?.disabled)
    .map((model: any) => String(model?.name || '').trim())
    .filter((model: string) => model.length > 0)
    .sort();

  return {
    availableModels: enabledModels,
    filterMode,
    filterApplied: rawRows.some((model: any) => Boolean(model?.disabled)),
  };
}

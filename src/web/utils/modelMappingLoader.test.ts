import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api.js';
import { loadModelMappingCandidates } from './modelMappingLoader.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccountModels: vi.fn(),
    getSiteAllowedModels: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

describe('loadModelMappingCandidates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies allow-list filtering when mode is allow-list', async () => {
    apiMock.getAccountModels.mockResolvedValue({
      models: [
        { name: 'gpt-4', disabled: false },
        { name: 'gpt-3.5-turbo', disabled: false },
        { name: 'claude-3', disabled: false },
      ],
    });
    apiMock.getSiteAllowedModels.mockResolvedValue({
      models: ['gpt-4', 'claude-3'],
    });

    const result = await loadModelMappingCandidates({
      accountId: 1,
      siteId: 10,
      siteModelFilterMode: 'allow-list',
    });

    expect(result).toEqual({
      availableModels: ['claude-3', 'gpt-4'],
      filterMode: 'allow-list',
      filterApplied: true,
    });
  });

  it('returns an empty list when allow-list is explicitly empty', async () => {
    apiMock.getAccountModels.mockResolvedValue({
      models: [
        { name: 'gpt-4', disabled: false },
        { name: 'gpt-3.5-turbo', disabled: false },
      ],
    });
    apiMock.getSiteAllowedModels.mockResolvedValue({ models: [] });

    const result = await loadModelMappingCandidates({
      accountId: 1,
      siteId: 10,
      siteModelFilterMode: 'allow-list',
    });

    expect(result).toEqual({
      availableModels: [],
      filterMode: 'allow-list',
      filterApplied: true,
    });
  });

  it('falls back to raw models when allow-list loading fails', async () => {
    apiMock.getAccountModels.mockResolvedValue({
      models: [
        { name: 'gpt-4', disabled: false },
        { name: 'claude-3', disabled: false },
      ],
    });
    apiMock.getSiteAllowedModels.mockRejectedValue(new Error('boom'));

    const result = await loadModelMappingCandidates({
      accountId: 1,
      siteId: 10,
      siteModelFilterMode: 'allow-list',
    });

    expect(result).toEqual({
      availableModels: ['claude-3', 'gpt-4'],
      filterMode: 'allow-list',
      filterApplied: false,
    });
  });

  it('uses disabled flags from account models in deny-list mode', async () => {
    apiMock.getAccountModels.mockResolvedValue({
      models: [
        { name: 'gpt-4', disabled: false },
        { name: 'gpt-3.5-turbo', disabled: true },
        { name: 'claude-3', disabled: false },
      ],
    });

    const result = await loadModelMappingCandidates({
      accountId: 1,
      siteId: 10,
      siteModelFilterMode: 'deny-list',
    });

    expect(result).toEqual({
      availableModels: ['claude-3', 'gpt-4'],
      filterMode: 'deny-list',
      filterApplied: true,
    });
    expect(api.getSiteAllowedModels).not.toHaveBeenCalled();
  });

  it('matches allow-list entries case-insensitively while preserving original model names', async () => {
    apiMock.getAccountModels.mockResolvedValue({
      models: [
        { name: 'GPT-4', disabled: false },
        { name: 'gpt-3.5-turbo', disabled: false },
      ],
    });
    apiMock.getSiteAllowedModels.mockResolvedValue({ models: ['gpt-4'] });

    const result = await loadModelMappingCandidates({
      accountId: 1,
      siteId: 10,
      siteModelFilterMode: 'allow-list',
    });

    expect(result.availableModels).toEqual(['GPT-4']);
  });
});

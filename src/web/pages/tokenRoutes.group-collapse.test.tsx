import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import TokenRoutes from './TokenRoutes.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getRoutes: vi.fn(),
    getModelTokenCandidates: vi.fn(),
    getRouteDecisionsBatch: vi.fn(),
    getRouteWideDecisionsBatch: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('../components/BrandIcon.js', () => ({
  InlineBrandIcon: ({ model }: { model: string }) => model ? <span>{model}</span> : null,
  getBrand: () => null,
  useIconCdn: () => 'https://cdn.test',
  hashColor: () => 'linear-gradient(135deg,#4f46e5,#818cf8)',
}));

function collectText(node: ReactTestInstance): string {
  const children = node.children || [];
  return children.map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

function findButtonByText(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find((node) => (
    node.type === 'button'
    && typeof node.props.onClick === 'function'
    && collectText(node).includes(text)
  ));
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('TokenRoutes grouped source models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getModelTokenCandidates.mockResolvedValue({ models: {} });
    apiMock.getRouteDecisionsBatch.mockResolvedValue({ decisions: {} });
    apiMock.getRouteWideDecisionsBatch.mockResolvedValue({ decisions: {} });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('collapses source-model groups by default for wildcard routes', async () => {
    apiMock.getRoutes.mockResolvedValue([
      {
        id: 1,
        modelPattern: 're:^claude-opus-(4-6|4-5)$',
        displayName: 'claude-opus-4-6',
        enabled: true,
        channels: [
          {
            id: 11,
            accountId: 101,
            tokenId: 1001,
            sourceModel: 'claude-opus-4-5',
            priority: 0,
            weight: 1,
            enabled: true,
            manualOverride: false,
            successCount: 0,
            failCount: 0,
            account: { username: 'user_a' },
            site: { name: 'site-a' },
            token: { id: 1001, name: 'token-a', accountId: 101, enabled: true, isDefault: true },
          },
          {
            id: 12,
            accountId: 102,
            tokenId: 1002,
            sourceModel: 'claude-opus-4-6',
            priority: 0,
            weight: 1,
            enabled: true,
            manualOverride: false,
            successCount: 0,
            failCount: 0,
            account: { username: 'user_b' },
            site: { name: 'site-b' },
            token: { id: 1002, name: 'token-b', accountId: 102, enabled: true, isDefault: true },
          },
        ],
      },
    ]);

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).toContain('claude-opus-4-5');
      expect(text).toContain('claude-opus-4-6');
      expect(text).not.toContain('user_a');
      expect(text).not.toContain('user_b');
    } finally {
      root?.unmount();
    }
  });

  it('expands a source-model group after user click', async () => {
    apiMock.getRoutes.mockResolvedValue([
      {
        id: 1,
        modelPattern: 're:^claude-opus-(4-6|4-5)$',
        displayName: 'claude-opus-4-6',
        enabled: true,
        channels: [
          {
            id: 11,
            accountId: 101,
            tokenId: 1001,
            sourceModel: 'claude-opus-4-5',
            priority: 0,
            weight: 1,
            enabled: true,
            manualOverride: false,
            successCount: 0,
            failCount: 0,
            account: { username: 'user_a' },
            site: { name: 'site-a' },
            token: { id: 1001, name: 'token-a', accountId: 101, enabled: true, isDefault: true },
          },
        ],
      },
    ]);

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      expect(collectText(root.root)).not.toContain('user_a');

      const toggleButton = findButtonByText(root.root, 'claude-opus-4-5');
      await act(async () => {
        toggleButton.props.onClick();
      });
      await flushMicrotasks();

      expect(collectText(root.root)).toContain('user_a');
    } finally {
      root?.unmount();
    }
  });

  it('renders missing-token site tags with interactive hover class', async () => {
    apiMock.getRoutes.mockResolvedValue([
      {
        id: 1,
        modelPattern: 'gpt-5.2-codex',
        displayName: 'gpt-5.2-codex',
        enabled: true,
        channels: [],
      },
    ]);
    apiMock.getModelTokenCandidates.mockResolvedValue({
      models: {},
      modelsWithoutToken: {
        'gpt-5.2-codex': [
          {
            accountId: 101,
            username: 'linuxdo_11494',
            siteId: 11,
            siteName: 'Wong',
          },
        ],
      },
    });

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const siteButton = findButtonByText(root.root, 'Wong');
      expect(String(siteButton.props.className || '')).toContain('missing-token-site-tag');
    } finally {
      root?.unmount();
    }
  });

  it('maps endpoint types to expected brand icons in filter panel', async () => {
    apiMock.getRoutes.mockResolvedValue([
      {
        id: 1,
        modelPattern: 'gpt-5.2-codex',
        displayName: 'gpt-5.2-codex',
        enabled: true,
        channels: [
          {
            id: 11,
            accountId: 101,
            tokenId: 1001,
            sourceModel: 'gpt-5.2-codex',
            priority: 0,
            weight: 1,
            enabled: true,
            manualOverride: false,
            successCount: 0,
            failCount: 0,
            account: { username: 'user_a' },
            site: { id: 1, name: 'Wong' },
            token: { id: 1001, name: 'token-a', accountId: 101, enabled: true, isDefault: true },
          },
        ],
      },
    ]);
    apiMock.getModelTokenCandidates.mockResolvedValue({
      models: {},
      endpointTypesByModel: {
        'gpt-5.2-codex': ['openai', 'gemini', 'anthropic'],
      },
    });

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).toContain('chatgpt');
      expect(text).toContain('gemini');
      expect(text).toContain('claude');
    } finally {
      root?.unmount();
    }
  });

  it('falls back to site platform endpoint grouping when endpoint metadata cache is empty', async () => {
    apiMock.getRoutes.mockResolvedValue([
      {
        id: 1,
        modelPattern: 'gpt-4o-mini',
        displayName: 'gpt-4o-mini',
        enabled: true,
        channels: [
          {
            id: 11,
            accountId: 101,
            tokenId: 1001,
            sourceModel: null,
            priority: 0,
            weight: 1,
            enabled: true,
            manualOverride: false,
            successCount: 0,
            failCount: 0,
            account: { username: 'user_a' },
            site: { id: 1, name: 'site-a', platform: 'new-api' },
            token: { id: 1001, name: 'token-a', accountId: 101, enabled: true, isDefault: true },
          },
        ],
      },
    ]);
    apiMock.getModelTokenCandidates.mockResolvedValue({
      models: {},
      endpointTypesByModel: {},
    });

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).toContain('接口能力');
      expect(text).toContain('openai');
    } finally {
      root?.unmount();
    }
  });

  it('still shows endpoint group section with empty hint when no endpoint data can be inferred', async () => {
    apiMock.getRoutes.mockResolvedValue([
      {
        id: 1,
        modelPattern: 'custom-model-without-channel',
        displayName: 'custom-model-without-channel',
        enabled: true,
        channels: [],
      },
    ]);
    apiMock.getModelTokenCandidates.mockResolvedValue({
      models: {},
      endpointTypesByModel: {},
    });

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).toContain('接口能力');
      expect(text).toContain('暂无接口能力数据');
    } finally {
      root?.unmount();
    }
  });
});

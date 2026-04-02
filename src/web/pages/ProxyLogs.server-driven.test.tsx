import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import ModernSelect from '../components/ModernSelect.js';
import { ToastProvider } from '../components/Toast.js';
import ProxyLogs from './ProxyLogs.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getProxyLogs: vi.fn(),
    getProxyLogDetail: vi.fn(),
    getSites: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function buildListResponse(overrides?: Partial<{
  items: any[];
  total: number;
  page: number;
  pageSize: number;
  summary: {
    totalCount: number;
    successCount: number;
    failedCount: number;
    totalCost: number;
    totalTokensAll: number;
  };
}>) {
  return {
    items: [
      {
        id: 101,
        createdAt: '2026-03-09 16:00:00',
        modelRequested: 'gpt-4o',
        modelActual: 'gpt-4o',
        status: 'success',
        latencyMs: 120,
        firstByteLatencyMs: 35,
        isStream: true,
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        retryCount: 0,
        estimatedCost: 1.23,
        errorMessage: 'downstream: /v1/chat upstream: /api/chat',
        username: 'tester',
        siteName: 'main-site',
        siteUrl: 'https://main-site.example.com',
        clientFamily: 'codex',
        clientAppId: 'cherry_studio',
        clientAppName: 'Cherry Studio',
        clientConfidence: 'heuristic',
        downstreamKeyName: '移动端灰度',
        downstreamKeyGroupName: '项目A',
        downstreamKeyTags: ['VIP', '灰度'],
      },
    ],
    total: 1,
    page: 1,
    pageSize: 50,
    summary: {
      totalCount: 12,
      successCount: 8,
      failedCount: 4,
      totalCost: 1.23,
      totalTokensAll: 15,
    },
    clientOptions: [
      { value: 'app:cherry_studio', label: '应用 · Cherry Studio' },
      { value: 'family:codex', label: '协议 · Codex' },
    ],
    ...overrides,
  };
}

describe('ProxyLogs server-driven page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSites.mockResolvedValue([
      { id: 9, name: 'main-site', status: 'active' },
      { id: 12, name: 'backup-site', status: 'active' },
    ]);
    apiMock.getProxyLogs.mockResolvedValue(buildListResponse());
    apiMock.getProxyLogDetail.mockResolvedValue({
      id: 101,
      createdAt: '2026-03-09 16:00:00',
      modelRequested: 'gpt-4o',
      modelActual: 'gpt-4o',
      status: 'success',
      latencyMs: 120,
      firstByteLatencyMs: 35,
      isStream: true,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      retryCount: 0,
      estimatedCost: 1.23,
      errorMessage: 'downstream: /v1/chat upstream: /api/chat',
      username: 'tester',
      siteName: 'main-site',
      siteUrl: 'https://main-site.example.com',
      clientFamily: 'codex',
      clientAppId: 'cherry_studio',
      clientAppName: 'Cherry Studio',
      clientConfidence: 'heuristic',
      downstreamKeyName: '移动端灰度',
      downstreamKeyGroupName: '项目A',
      downstreamKeyTags: ['VIP', '灰度'],
      billingDetails: {
        breakdown: {
          inputPerMillion: 1,
          outputPerMillion: 2,
          cacheReadPerMillion: 0,
          cacheCreationPerMillion: 0,
          inputCost: 0.1,
          outputCost: 0.2,
          cacheReadCost: 0,
          cacheCreationCost: 0,
          totalCost: 0.3,
        },
        pricing: {
          modelRatio: 1,
          completionRatio: 1,
          cacheRatio: 0,
          cacheCreationRatio: 0,
          groupRatio: 1,
        },
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          billablePromptTokens: 10,
          promptTokensIncludeCache: false,
        },
      },
      runtimeEndpointAffinity: {
        isRuntimeOnly: true,
        scope: 'text_default',
        downstreamFormat: 'responses',
        preferredEndpoint: 'chat',
        blockedEndpoints: [
          {
            endpoint: 'responses',
            blockedUntilMs: Date.now() + 300_000,
            remainingMs: 300_000,
          },
        ],
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('requests paginated data from the server and renders server summary counts', async () => {
    let root!: WebTestRenderer;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/logs']}>
            <ToastProvider>
              <ProxyLogs />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      expect(apiMock.getProxyLogs).toHaveBeenCalledWith({
        limit: 50,
        offset: 0,
        status: 'all',
        search: '',
      });

      const text = collectText(root!.root);
      expect(text).toContain('消耗总额 $1.2300');
      expect(text).toContain('全部 12');
      expect(text).toContain('成功 8');
      expect(text).toContain('失败 4');
      expect(text).toContain('Cherry Studio');
      expect(text).toContain('Codex');
      expect(text).toContain('推测');
      expect(text).toContain('下游 Key: 移动端灰度');
      expect(text).toContain('流式');
      expect(text).toContain('首字');
    } finally {
      root?.unmount();
    }
  });

  it('keeps the model badge sized to the model name in desktop rows', async () => {
    let root!: WebTestRenderer;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/logs']}>
            <ToastProvider>
              <ProxyLogs />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const modelBadge = root!.root.find((node) => (
        node.type === 'span'
        && collectText(node) === 'gpt-4o'
        && node.props.style?.display === 'inline-flex'
      ));

      expect(modelBadge.props.style?.alignSelf).toBe('flex-start');
    } finally {
      root?.unmount();
    }
  });

  it('renders explicit client self-reports before protocol-family fallback labels', async () => {
    apiMock.getProxyLogs.mockResolvedValue(buildListResponse({
      items: [
        {
          id: 101,
          createdAt: '2026-03-09 16:00:00',
          modelRequested: 'gpt-4o',
          modelActual: 'gpt-4o',
          status: 'success',
          latencyMs: 120,
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          retryCount: 0,
          estimatedCost: 1.23,
          errorMessage: 'downstream: /v1/responses upstream: /v1/responses',
          username: 'tester',
          siteName: 'main-site',
          siteUrl: 'https://main-site.example.com',
          clientFamily: 'codex',
          clientAppId: 'openclaw',
          clientAppName: 'openclaw',
          clientConfidence: 'exact',
          downstreamKeyName: '移动端灰度',
          downstreamKeyGroupName: '项目A',
          downstreamKeyTags: ['VIP', '灰度'],
        },
      ],
    }));

    let root!: WebTestRenderer;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/logs']}>
            <ToastProvider>
              <ProxyLogs />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const row = root!.root.find((node) => (
        node.type === 'tr' && node.props['data-testid'] === 'proxy-log-row-101'
      ));
      const rowText = collectText(row);
      expect(rowText).toContain('openclaw');
      expect(rowText).toContain('Codex');
      expect(rowText).not.toContain('推测');
    } finally {
      root?.unmount();
    }
  });

  it('re-queries the server for status, client, and search changes instead of filtering locally', async () => {
    let root!: WebTestRenderer;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/logs']}>
            <ToastProvider>
              <ProxyLogs />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const failedTab = root!.root.findAll((node) => (
        node.type === 'button' && collectText(node).includes('失败')
      ))[0];
      await act(async () => {
        failedTab.props.onClick();
      });
      await flushMicrotasks();

      const selects = root!.root.findAllByType(ModernSelect);
      const clientSelect = selects.find((node) => node.props.placeholder === '全部客户端');
      expect(clientSelect).toBeDefined();

      await act(async () => {
        clientSelect!.props.onChange('app:cherry_studio');
      });
      await flushMicrotasks();

      const searchInput = root!.root.find((node) => (
        node.type === 'input' && node.props.placeholder === '搜索模型、下游 Key、主分组、标签...'
      ));
      await act(async () => {
        searchInput.props.onChange({ target: { value: 'mini' } });
      });
      await flushMicrotasks();

      expect(apiMock.getProxyLogs).toHaveBeenNthCalledWith(2, {
        limit: 50,
        offset: 0,
        status: 'failed',
        search: '',
      });
      expect(apiMock.getProxyLogs).toHaveBeenNthCalledWith(3, {
        limit: 50,
        offset: 0,
        status: 'failed',
        search: '',
        client: 'app:cherry_studio',
      });
      expect(apiMock.getProxyLogs).toHaveBeenLastCalledWith({
        limit: 50,
        offset: 0,
        status: 'failed',
        search: 'mini',
        client: 'app:cherry_studio',
      });
    } finally {
      root?.unmount();
    }
  });

  it('loads detail on first expand and reuses the cached detail on re-expand', async () => {
    let root!: WebTestRenderer;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/logs']}>
            <ToastProvider>
              <ProxyLogs />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const row = root!.root.find((node) => (
        node.type === 'tr' && node.props['data-testid'] === 'proxy-log-row-101'
      ));

      await act(async () => {
        row.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.getProxyLogDetail).toHaveBeenCalledTimes(1);

      await act(async () => {
        row.props.onClick();
      });
      await flushMicrotasks();

      await act(async () => {
        row.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.getProxyLogDetail).toHaveBeenCalledTimes(1);
      expect(apiMock.getProxyLogDetail).toHaveBeenCalledWith(101);
    } finally {
      root?.unmount();
    }
  });

  it('renders unknown usage as -- instead of 0 in the server-driven table', async () => {
    apiMock.getProxyLogs.mockResolvedValue(buildListResponse({
      items: [
        {
          id: 101,
          createdAt: '2026-03-09 16:00:00',
          modelRequested: 'gpt-5',
          modelActual: 'gpt-5',
          status: 'success',
          latencyMs: 120,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          usageSource: 'unknown',
          retryCount: 0,
          estimatedCost: 0,
          errorMessage: '[downstream:/v1/chat/completions] [upstream:/v1/chat/completions] [usage:unknown]',
          username: 'tester',
          siteName: 'main-site',
          siteUrl: 'https://main-site.example.com',
          clientFamily: 'codex',
          clientAppId: 'cherry_studio',
          clientAppName: 'Cherry Studio',
          clientConfidence: 'heuristic',
        },
      ],
      summary: {
        totalCount: 1,
        successCount: 1,
        failedCount: 0,
        totalCost: 0,
        totalTokensAll: 0,
      },
    }));
    let root!: WebTestRenderer;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/logs']}>
            <ToastProvider>
              <ProxyLogs />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const row = root!.root.find((node) => (
        node.type === 'tr' && node.props['data-testid'] === 'proxy-log-row-101'
      ));
      const rowText = collectText(row);
      expect(rowText).toContain('--');
      expect(rowText).not.toContain('输入0');
    } finally {
      root?.unmount();
    }
  });

  it('renders runtime endpoint affinity in the expanded detail view', async () => {
    let root!: WebTestRenderer;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/logs']}>
            <ToastProvider>
              <ProxyLogs />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const row = root!.root.find((node) => (
        node.type === 'tr' && node.props['data-testid'] === 'proxy-log-row-101'
      ));

      await act(async () => {
        row.props.onClick();
      });
      await flushMicrotasks();

      const text = collectText(root!.root);
      expect(text).toContain('协议学习');
      expect(text).toContain('当前首选协议: chat');
      expect(text).toContain('作用范围: responses / text_default');
      expect(text).toContain('临时跳过协议: responses');
      expect(text).toContain('仅当前进程有效，重启后清空');
    } finally {
      root?.unmount();
    }
  });

  it('hydrates site and time filters from the route query', async () => {
    let root!: WebTestRenderer;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/logs?siteId=9&client=family%3Acodex&from=2026-03-09T08:00&to=2026-03-09T09:00']}>
            <ToastProvider>
              <ProxyLogs />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const expectedFrom = new Date(2026, 2, 9, 8, 0).toISOString();
      const expectedTo = new Date(2026, 2, 9, 9, 0).toISOString();
      expect(apiMock.getProxyLogs).toHaveBeenCalledWith({
        limit: 50,
        offset: 0,
        status: 'all',
        search: '',
        siteId: 9,
        client: 'family:codex',
        from: expectedFrom,
        to: expectedTo,
      });

      const rendered = JSON.stringify(root!.toJSON());
      expect(rendered).toContain('main-site');
    } finally {
      root?.unmount();
    }
  });
});

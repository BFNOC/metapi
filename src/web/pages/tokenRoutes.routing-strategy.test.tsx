import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import TokenRoutes from './TokenRoutes.js';

const { apiMock, getBrandMock } = vi.hoisted(() => ({
  apiMock: {
    getRoutesSummary: vi.fn(),
    getRouteChannels: vi.fn(),
    getModelTokenCandidates: vi.fn(),
    getRouteDecisionsBatch: vi.fn(),
    getRouteWideDecisionsBatch: vi.fn(),
    updateRoute: vi.fn(),
  },
  getBrandMock: vi.fn(),
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('../components/BrandIcon.js', () => ({
  BrandGlyph: ({ brand, icon, model }: { brand?: { name?: string } | null; icon?: string | null; model?: string | null }) => (
    <span>{brand?.name || icon || model || ''}</span>
  ),
  InlineBrandIcon: ({ model }: { model: string }) => model ? <span>{model}</span> : null,
  getBrand: (...args: unknown[]) => getBrandMock(...args),
  hashColor: () => 'linear-gradient(135deg,#4f46e5,#818cf8)',
  normalizeBrandIconKey: (icon: string) => icon,
}));

vi.mock('./token-routes/RouteCard.js', () => ({
  default: ({ route, onRoutingStrategyChange }: { route: { id: number; routingStrategy?: string | null }; onRoutingStrategyChange: (route: { id: number; routingStrategy?: string | null }, next: 'weighted' | 'round_robin' | 'stable_first') => void }) => (
    <div className="mock-route-card">
      <span className="mock-route-strategy">{route.routingStrategy || 'weighted'}</span>
      <button type="button" onClick={() => onRoutingStrategyChange(route, 'round_robin')}>切到轮询</button>
      <button type="button" onClick={() => onRoutingStrategyChange(route, 'stable_first')}>切到稳定优先</button>
    </div>
  ),
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
  });
}

describe('TokenRoutes routing strategy updates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBrandMock.mockReset();
    getBrandMock.mockReturnValue(null);
    apiMock.getRoutesSummary
      .mockResolvedValueOnce([
        {
          id: 1,
          modelPattern: 'gpt-4o-mini',
          displayName: 'gpt-4o-mini',
          displayIcon: null,
          modelMapping: null,
          routingStrategy: 'weighted',
          enabled: true,
          channelCount: 0,
          enabledChannelCount: 0,
          siteNames: [],
          decisionSnapshot: null,
          decisionRefreshedAt: null,
        },
      ])
      .mockRejectedValueOnce(new Error('refresh failed'));
    apiMock.getRouteChannels.mockResolvedValue([]);
    apiMock.getModelTokenCandidates.mockResolvedValue({ models: {} });
    apiMock.getRouteDecisionsBatch.mockResolvedValue({ decisions: {} });
    apiMock.getRouteWideDecisionsBatch.mockResolvedValue({ decisions: {} });
    apiMock.updateRoute.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the optimistic routing strategy when refresh fails after a successful save', async () => {
    let root!: WebTestRenderer;
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

      const roundRobinButton = root.root.find((node) => (
        node.type === 'button'
        && collectText(node).includes('切到轮询')
      ));

      await act(async () => {
        roundRobinButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateRoute).toHaveBeenCalledWith(1, { routingStrategy: 'round_robin' });
      expect(apiMock.getRoutesSummary).toHaveBeenCalledTimes(2);

      const strategyText = root.root.find((node) => (
        node.type === 'span'
        && typeof node.props.className === 'string'
        && node.props.className.includes('mock-route-strategy')
      ));
      expect(collectText(strategyText)).toContain('round_robin');
    } finally {
      root?.unmount();
    }
  });

  it('supports switching to stable_first and keeps the optimistic label when refresh fails', async () => {
    let root!: WebTestRenderer;
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

      const stableFirstButton = root.root.find((node) => (
        node.type === 'button'
        && collectText(node).includes('切到稳定优先')
      ));

      await act(async () => {
        stableFirstButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateRoute).toHaveBeenCalledWith(1, { routingStrategy: 'stable_first' });

      const strategyText = root.root.find((node) => (
        node.type === 'span'
        && typeof node.props.className === 'string'
        && node.props.className.includes('mock-route-strategy')
      ));
      expect(collectText(strategyText)).toContain('stable_first');
    } finally {
      root?.unmount();
    }
  });
});

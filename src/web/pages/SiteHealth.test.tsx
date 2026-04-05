import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import SiteHealth from './SiteHealth.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getSiteHealthStates: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('../components/useIsMobile.js', () => ({
  useIsMobile: () => false,
}));

vi.mock('../components/ResponsiveFilterPanel.js', () => ({
  default: ({ desktopContent }: { desktopContent?: React.ReactNode }) => <>{desktopContent}</>,
}));

const { modelProbeModalMock } = vi.hoisted(() => ({
  modelProbeModalMock: vi.fn(),
}));

vi.mock('../components/ModelProbeModal.js', () => ({
  default: (props: any) => {
    modelProbeModalMock(props);
    return props.open ? <div data-probe-modal-open>{props.siteName}</div> : null;
  },
}));

function collectText(node: any): string {
  if (!node) return '';
  if (Array.isArray(node)) return node.map((item) => collectText(item)).join('');
  if (typeof node === 'string') return node;
  return (node.children || []).map((child: any) => collectText(child)).join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const rows = [
  {
    siteId: 1,
    siteName: 'Alpha Site',
    siteUrl: 'https://alpha.example.com',
    platform: 'new-api',
    siteStatus: 'active',
    state: 'quarantined',
    probePolicy: 'manual_only',
    breakerOpen: false,
    penaltyScore: 2.5,
    latencyEmaMs: 850,
    cooldownSummary: {
      activeChannelCooldownCount: 1,
      affectedRouteCount: 1,
      earliestCooldownUntil: '2099-01-01T00:00:00.000Z',
      latestCooldownUntil: '2099-01-01T00:00:00.000Z',
    },
    lastSuccessAt: '2026-04-05T16:00:00.000Z',
    lastFailureAt: '2026-04-05T15:00:00.000Z',
    recentFailureSummary: {
      kind: 'challenge',
      message: '最近失败：挑战页',
      httpStatus: 503,
      occurredAt: '2026-04-05T15:00:00.000Z',
    },
    activeModelCount: 2,
    unhealthyModelCount: 1,
    recentFailureCount: 3,
    severeFailureCount: 1,
    isPinned: false,
    sortOrder: 0,
  },
  {
    siteId: 2,
    siteName: 'Beta Site',
    siteUrl: 'https://beta.example.com',
    platform: 'new-api',
    siteStatus: 'active',
    state: 'active',
    probePolicy: 'allow_recovery_probe',
    breakerOpen: false,
    penaltyScore: 0,
    latencyEmaMs: 120,
    cooldownSummary: {
      activeChannelCooldownCount: 0,
      affectedRouteCount: 0,
      earliestCooldownUntil: null,
      latestCooldownUntil: null,
    },
    lastSuccessAt: '2026-04-05T16:30:00.000Z',
    lastFailureAt: null,
    recentFailureSummary: null,
    activeModelCount: 1,
    unhealthyModelCount: 0,
    recentFailureCount: 0,
    severeFailureCount: 0,
    isPinned: false,
    sortOrder: 1,
  },
];

describe('SiteHealth page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSiteHealthStates.mockResolvedValue({
      enabled: true,
      items: rows,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads and renders site health rows', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/site-health']}>
            <ToastProvider>
              <SiteHealth />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      expect(apiMock.getSiteHealthStates).toHaveBeenCalledTimes(1);
      const text = collectText(root.toJSON());
      expect(text).toContain('Alpha Site');
      expect(text).toContain('Beta Site');
      expect(text).toContain('总站点');
      expect(text).toContain('隔离中');
      expect(text).toContain('正常');
      expect(text).toContain('冷却通道 1 / 影响路由 1');
      expect(root.root.findByType('table').props.className).toContain('data-table');
    } finally {
      root?.unmount();
    }
  });

  it('filters by keyword and state', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/site-health']}>
            <ToastProvider>
              <SiteHealth />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const inputs = root.root.findAllByType('input');
      const selects = root.root.findAllByType('select');

      await act(async () => {
        inputs[0].props.onChange({ target: { value: 'Beta' } });
      });
      await flushMicrotasks();
      expect(collectText(root.toJSON())).toContain('Beta Site');
      expect(collectText(root.toJSON())).not.toContain('Alpha Site');

      await act(async () => {
        inputs[0].props.onChange({ target: { value: '' } });
        selects[0].props.onChange({ target: { value: 'quarantined' } });
      });
      await flushMicrotasks();
      expect(collectText(root.toJSON())).toContain('Alpha Site');
      expect(collectText(root.toJSON())).not.toContain('Beta Site');
    } finally {
      root?.unmount();
    }
  });

  it('opens probe modal for the selected site', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/site-health']}>
            <ToastProvider>
              <SiteHealth />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const verifyButton = root.root.findAll((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).includes('探活')
      ))[0];
      expect(verifyButton.props.disabled).toBe(false);

      await act(async () => {
        verifyButton.props.onClick();
      });
      await flushMicrotasks();

      expect(modelProbeModalMock).toHaveBeenLastCalledWith(expect.objectContaining({
        open: true,
        siteId: 1,
        siteName: 'Alpha Site',
      }));
      expect(collectText(root.toJSON())).toContain('Alpha Site');
    } finally {
      root?.unmount();
    }
  });
});

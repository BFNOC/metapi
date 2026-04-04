import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import ModernSelect from '../../components/ModernSelect.js';
import { ToastProvider } from '../../components/Toast.js';
import AddChannelModal from './AddChannelModal.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    batchAddChannels: vi.fn(),
  },
}));

vi.mock('../../api.js', () => ({
  api: apiMock,
}));

vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return {
    ...actual,
    createPortal: (node: unknown) => node,
  };
});

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

describe('AddChannelModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.batchAddChannels.mockResolvedValue({ created: 1, skipped: 0, errors: [] });
  });

  it('submits tokenId=null for direct-account candidates', async () => {
    const onSuccess = vi.fn();
    const onClose = vi.fn();
    const root = create(
      <ToastProvider>
        <AddChannelModal
          open
          onClose={onClose}
          routeId={9}
          routeTitle="gpt-4o-mini"
          candidateView={{
            routeCandidates: [],
            accountOptions: [{ id: 101, label: 'welfare @ site-a' }],
            tokenOptionsByAccountId: {},
            directBindingOptionsByAccountId: {
              101: [{ connectionMode: 'apikey', sourceModel: 'gpt-4o-mini' }],
            },
          }}
          onSuccess={onSuccess}
        />
      </ToastProvider>,
    );

    const accountCard = root.root.find((node) => (
      node.type === 'div'
      && typeof node.props.onClick === 'function'
      && node.props.style?.cursor === 'pointer'
      && collectText(node).includes('welfare @ site-a')
    ));
    act(() => {
      accountCard.props.onClick();
    });

    const submitButton = root.root.findAll((node) => (
      node.type === 'button'
      && typeof node.props.onClick === 'function'
      && collectText(node).includes('批量添加')
    ))[0];
    await act(async () => {
      submitButton.props.onClick();
      await flushMicrotasks();
    });

    expect(apiMock.batchAddChannels).toHaveBeenCalledWith(9, [{
      accountId: 101,
      tokenId: null,
      sourceModel: 'gpt-4o-mini',
    }]);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('submits tokenId=0 for managed-token follow-default selection', async () => {
    const root = create(
      <ToastProvider>
        <AddChannelModal
          open
          onClose={vi.fn()}
          routeId={10}
          routeTitle="gpt-4o-mini"
          candidateView={{
            routeCandidates: [
              {
                modelName: 'gpt-4o-mini',
                accountId: 202,
                tokenId: 1,
                tokenName: 'default',
                isDefault: true,
                username: 'session-user',
                siteId: 1,
                siteName: 'site-a',
              },
            ],
            accountOptions: [{ id: 202, label: 'session-user @ site-a' }],
            tokenOptionsByAccountId: {
              202: [{ id: 1, name: 'default', isDefault: true, sourceModel: 'gpt-4o-mini' }],
            },
            directBindingOptionsByAccountId: {},
          }}
          onSuccess={vi.fn()}
        />
      </ToastProvider>,
    );

    const accountCard = root.root.find((node) => (
      node.type === 'div'
      && typeof node.props.onClick === 'function'
      && node.props.style?.cursor === 'pointer'
      && collectText(node).includes('session-user @ site-a')
    ));
    act(() => {
      accountCard.props.onClick();
    });

    const select = root.root.findByType(ModernSelect);
    act(() => {
      select.props.onChange('default');
    });

    const submitButton = root.root.findAll((node) => (
      node.type === 'button'
      && typeof node.props.onClick === 'function'
      && collectText(node).includes('批量添加')
    ))[0];
    await act(async () => {
      submitButton.props.onClick();
      await flushMicrotasks();
    });

    expect(apiMock.batchAddChannels).toHaveBeenCalledWith(10, [{
      accountId: 202,
      tokenId: 0,
      sourceModel: undefined,
    }]);
  });
});

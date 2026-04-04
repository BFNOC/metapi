import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import ModelMappingModal from '../components/ModelMappingModal.js';
import { ToastProvider } from '../components/Toast.js';
import { TokensPanel } from './Tokens.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccountTokens: vi.fn(),
    getAccounts: vi.fn(),
    getTokenModels: vi.fn(),
    getTokenModelMapping: vi.fn(),
    updateTokenModelMapping: vi.fn(),
    updateAccount: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
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
  const children = node.children || [];
  return children
    .map((child) => {
      if (typeof child === 'string') return child;
      return collectText(child);
    })
    .join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function buildRoot() {
  return create(
    <ToastProvider>
      <MemoryRouter initialEntries={['/accounts?segment=tokens']}>
        <TokensPanel />
      </MemoryRouter>
    </ToastProvider>,
    {
      createNodeMock: (element) => {
        if (element.type === 'tr' || element.type === 'div') {
          return {
            scrollIntoView: () => undefined,
          };
        }
        return {};
      },
    },
  );
}

describe('Tokens mapping modal filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis, 'document', {
      value: {
        body: {
          style: {
            overflow: '',
          },
        },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      configurable: true,
      writable: true,
    });
    apiMock.getAccounts.mockResolvedValue([
      {
        id: 1,
        username: 'alpha',
        accessToken: '',
        status: 'active',
        credentialMode: 'apikey',
        capabilities: { canCheckin: false, canRefreshBalance: false, proxyOnly: true },
        siteId: 10,
        site: {
          id: 10,
          name: 'Site A',
          status: 'active',
          platform: 'new-api',
          modelFilterMode: 'allow-list',
        },
      },
    ]);
    apiMock.getAccountTokens.mockResolvedValue([
      {
        id: 22,
        name: 'token-a',
        tokenMasked: 'sk-***22',
        enabled: true,
        isDefault: false,
        updatedAt: '2026-03-16 08:00:00',
        accountId: 1,
        account: { username: 'alpha' },
        site: { id: 10, name: 'Site A', url: 'https://site-a.example.com' },
      },
    ]);
    apiMock.getTokenModels.mockResolvedValue({
      tokenId: 22,
      models: [
        { name: 'gpt-4', filtered: true },
        { name: 'claude-3', filtered: false },
      ],
    });
    apiMock.getTokenModelMapping.mockResolvedValue({
      tokenId: 22,
      modelMapping: { 'glm-5': 'claude-3' },
    });
    apiMock.updateTokenModelMapping.mockResolvedValue({ success: true });
    apiMock.updateAccount.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads token-level mapping and only exposes current token candidates', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = buildRoot();
      });
      await flushMicrotasks();

      const mappingButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '模型映射'
      ));

      await act(async () => {
        await mappingButton.props.onClick();
      });
      await flushMicrotasks();

      const mappingModal = root.root.findByType(ModelMappingModal);
      expect(apiMock.getTokenModelMapping).toHaveBeenCalledWith(22);
      expect(apiMock.getTokenModels).toHaveBeenCalledWith(22);
      expect(mappingModal.props.open).toBe(true);
      expect(mappingModal.props.targetName).toBe('token-a');
      expect(mappingModal.props.initialMapping).toEqual({ 'glm-5': 'claude-3' });
      expect(mappingModal.props.availableModels).toEqual(['claude-3']);
      expect(mappingModal.props.availableModels).not.toContain('gpt-4');
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
    }
  });

  it('saves token-level mapping through token API instead of account API', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = buildRoot();
      });
      await flushMicrotasks();

      const mappingButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '模型映射'
      ));

      await act(async () => {
        await mappingButton.props.onClick();
      });
      await flushMicrotasks();

      const mappingModal = root.root.findByType(ModelMappingModal);
      await act(async () => {
        await mappingModal.props.onSave({ 'gpt-4o-mini': 'claude-3' });
      });

      expect(apiMock.updateTokenModelMapping).toHaveBeenCalledWith(22, {
        modelMapping: { 'gpt-4o-mini': 'claude-3' },
      });
      expect(apiMock.updateAccount).not.toHaveBeenCalled();
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
    }
  });
});

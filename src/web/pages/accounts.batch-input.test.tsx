import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import ModernSelect from '../components/ModernSelect.js';
import Accounts from './Accounts.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccounts: vi.fn(),
    getSites: vi.fn(),
    getAccountTokens: vi.fn(),
    addAccount: vi.fn(),
    verifyToken: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || [])
    .map((child) => (typeof child === 'string' ? child : collectText(child)))
    .join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function openApiKeyAddPanel(root: WebTestRenderer) {
  const addButton = root.root.find((node) => (
    node.type === 'button'
    && typeof node.props.onClick === 'function'
    && typeof node.props.className === 'string'
    && node.props.className.includes('btn btn-primary')
  ));

  await act(async () => {
    addButton.props.onClick();
  });
  await flushMicrotasks();

  const selects = root.root.findAllByType(ModernSelect);
  expect(selects.length).toBeGreaterThan(1);

  await act(async () => {
    selects[1]!.props.onChange('10');
  });
}

describe('Accounts batch API key input', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getAccounts.mockResolvedValue([]);
    apiMock.getSites.mockResolvedValue([
      { id: 10, name: 'Key Site', platform: 'new-api', status: 'active' },
    ]);
    apiMock.getAccountTokens.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('recognizes batch API key input and submits parsed accessTokens without requiring pre-verification', async () => {
    apiMock.addAccount.mockResolvedValue({
      success: true,
      batch: true,
      createdCount: 1,
      failedCount: 1,
      items: [
        { index: 0, status: 'created' },
        { index: 1, status: 'failed', message: 'second key invalid' },
      ],
    });

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts?segment=apikey']}>
            <ToastProvider>
              <Accounts />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();
      await openApiKeyAddPanel(root);

      const textareas = root.root.findAll((node) => node.type === 'textarea');
      expect(textareas.length).toBeGreaterThan(0);

      await act(async () => {
        textareas[0]!.props.onChange({ target: { value: 'sk-alpha\nsk-beta' } });
      });
      await flushMicrotasks();

      const rendered = collectText(root.root);
      expect(rendered).toContain('已识别 2 个 API Key');
      expect(rendered).toContain('支持换行、空格、逗号批量粘贴多个 API Key。');
      expect(rendered).toContain('批量模式下无需先点验证，提交后会逐条校验并创建。');

      const buttons = root.root.findAll((node) => node.type === 'button');
      const verifyButton = buttons.find((node) => collectText(node).includes('批量添加时校验'));
      const submitButton = buttons.find((node) => collectText(node).includes('批量添加连接'));

      expect(verifyButton?.props.disabled).toBe(true);
      expect(submitButton?.props.disabled).toBe(false);

      await act(async () => {
        await submitButton!.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.addAccount).toHaveBeenCalledWith(expect.objectContaining({
        siteId: 10,
        accessToken: 'sk-alpha\nsk-beta',
        accessTokens: ['sk-alpha', 'sk-beta'],
        credentialMode: 'apikey',
      }));
      expect(apiMock.verifyToken).not.toHaveBeenCalled();
    } finally {
      root?.unmount();
    }
  });

  it('keeps the single-key verification flow unchanged', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts?segment=apikey']}>
            <ToastProvider>
              <Accounts />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();
      await openApiKeyAddPanel(root);

      const textareas = root.root.findAll((node) => node.type === 'textarea');
      expect(textareas.length).toBeGreaterThan(0);

      await act(async () => {
        textareas[0]!.props.onChange({ target: { value: 'sk-single' } });
      });
      await flushMicrotasks();

      const buttons = root.root.findAll((node) => node.type === 'button');
      const verifyButton = buttons.find((node) => collectText(node).includes('验证 API Key'));
      const submitButton = buttons.find((node) => collectText(node).includes('添加连接'));

      expect(verifyButton?.props.disabled).toBe(false);
      expect(submitButton?.props.disabled).toBe(true);
      expect(apiMock.addAccount).not.toHaveBeenCalled();
    } finally {
      root?.unmount();
    }
  });
});

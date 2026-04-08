import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Sites from './Sites.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getSites: vi.fn(),
    getSiteDisabledModels: vi.fn().mockResolvedValue({ models: [] }),
    getSiteAvailableModels: vi.fn().mockResolvedValue({ models: [] }),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('../components/useIsMobile.js', () => ({
  useIsMobile: () => true,
}));

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Sites mobile layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the primary site url in mobile cards', async () => {
    apiMock.getSites.mockResolvedValue([
      {
        id: 1,
        name: 'Mobile Site',
        url: 'https://mobile.example.com',
        platform: 'new-api',
        status: 'active',
        useSystemProxy: false,
      },
    ]);

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/sites']}>
            <ToastProvider>
              <Sites />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const rendered = JSON.stringify(root.toJSON());
      expect(rendered).toContain('Mobile Site');
      expect(rendered).toContain('https://mobile.example.com');
    } finally {
      root?.unmount();
    }
  });

  it('keeps the desktop site-name column visible at the 900px breakpoint', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/web/index.css'), 'utf8');
    expect(css).not.toContain('.sites-table th:nth-child(2),');
    expect(css).not.toContain('.sites-table td:nth-child(2),');
    expect(css).toContain('.sites-table th:nth-child(6),');
  });
});

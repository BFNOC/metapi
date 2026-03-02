import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { Sub2ApiAdapter } from './sub2api.js';

describe('Sub2ApiAdapter', () => {
  let server: ReturnType<typeof createServer> | undefined;
  let baseUrl: string;
  let adapter: Sub2ApiAdapter;

  beforeEach(() => {
    adapter = new Sub2ApiAdapter();
  });

  afterEach(async () => {
    if (server) {
      const s = server;
      server = undefined;
      await new Promise<void>((resolve, reject) => {
        s.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    }
  });

  function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    return new Promise<void>((resolve) => {
      server = createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        const addr = server!.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  }

  it('detects sub2api from URL', async () => {
    expect(await adapter.detect('https://sub2api.example.com')).toBe(true);
    expect(await adapter.detect('https://example.com')).toBe(false);
  });

  it('detects sub2api by auth/me unauthorized envelope even without sub2api domain', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/auth/me') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 'UNAUTHORIZED',
          message: 'Authorization header is required',
        }));
        return;
      }
      if (req.url === '/v1/models') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 'API_KEY_REQUIRED',
          message: 'API key is required',
        }));
        return;
      }
      res.writeHead(404).end();
    });

    expect(await adapter.detect(baseUrl)).toBe(true);
  });

  it('does not mis-detect generic json 401 responses', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/auth/me' || req.url === '/v1/models') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>Not Sub2</title></head><body></body></html>');
    });

    expect(await adapter.detect(baseUrl)).toBe(false);
  });

  it('returns unsupported for checkin', async () => {
    const result = await adapter.checkin('http://localhost', 'token');
    expect(result.success).toBe(false);
    expect(result.message).toContain('not supported');
  });

  it('fetches balance from /api/v1/auth/me', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/auth/me') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: { id: 1, username: 'testuser', email: 'test@example.com', balance: 12.5 },
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const balance = await adapter.getBalance(baseUrl, 'jwt-token');
    expect(balance.balance).toBeGreaterThan(0);
    expect(balance.used).toBe(0);
  });

  it('fetches user info from /api/v1/auth/me', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/auth/me') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: { id: 1, username: 'testuser', email: 'test@example.com', balance: 5.0 },
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const userInfo = await adapter.getUserInfo(baseUrl, 'jwt-token');
    expect(userInfo).not.toBeNull();
    expect(userInfo!.username).toBe('testuser');
  });

  it('falls back to email local part when username is empty', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/auth/me') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: { id: 1, username: '', email: 'alice@example.com', balance: 0 },
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const userInfo = await adapter.getUserInfo(baseUrl, 'jwt-token');
    expect(userInfo!.username).toBe('alice');
  });

  it('fetches models via /v1/models', async () => {
    await startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: [{ id: 'gpt-4o' }, { id: 'claude-3-opus' }],
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const models = await adapter.getModels(baseUrl, 'jwt-token');
    expect(models).toEqual(['gpt-4o', 'claude-3-opus']);
  });

  it('handles non-zero code as error in /api/v1/auth/me', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/auth/me') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 401,
          message: 'token expired',
          data: null,
        }));
        return;
      }
      res.writeHead(404).end();
    });

    await expect(adapter.getBalance(baseUrl, 'expired-token')).rejects.toThrow();
  });

  it('login returns unsupported', async () => {
    const result = await adapter.login('http://localhost', 'user', 'pass');
    expect(result.success).toBe(false);
  });

  it('token management returns empty/false', async () => {
    expect(await adapter.getApiToken('http://localhost', 'token')).toBeNull();
    expect(await adapter.getApiTokens('http://localhost', 'token')).toEqual([]);
    expect(await adapter.createApiToken('http://localhost', 'token')).toBe(false);
    expect(await adapter.deleteApiToken('http://localhost', 'token', 'key')).toBe(false);
  });
});

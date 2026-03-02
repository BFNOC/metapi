import { BasePlatformAdapter, type BalanceInfo, type CheckinResult, type UserInfo } from './base.js';

function normalizeBaseUrl(baseUrl: string): string {
  return (baseUrl || '').replace(/\/+$/, '');
}

export class CliProxyApiAdapter extends BasePlatformAdapter {
  readonly platformName = 'cliproxyapi';

  async detect(url: string): Promise<boolean> {
    const normalized = (url || '').toLowerCase();

    // Quick check: default CLIProxyAPI port
    if (/:8317(\/|$)/.test(normalized)) {
      return true;
    }

    // Quick check: common hostname keyword
    if (normalized.includes('cliproxy')) {
      return true;
    }

    // Probe management endpoint with strict signature checks.
    // Do not trust bare 401/403 because many non-CLIProxy sites may return
    // those statuses for unknown/protected paths.
    try {
      const base = normalizeBaseUrl(url);
      const { fetch } = await import('undici');
      const res = await fetch(`${base}/v0/management/openai-compatibility`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      const hasCpaHeaders = Boolean(
        res.headers.get('x-cpa-version')
        || res.headers.get('x-cpa-commit')
        || res.headers.get('x-cpa-build-date'),
      );
      if (hasCpaHeaders) {
        return res.status === 200 || res.status === 401 || res.status === 403;
      }

      if (res.status === 200) {
        const payload = await res.json().catch(() => null);
        if (payload && typeof payload === 'object') {
          return Object.prototype.hasOwnProperty.call(payload, 'openai-compatibility');
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  override async login(_baseUrl: string, _username: string, _password: string) {
    return { success: false as const, message: 'CLIProxyAPI does not support login' };
  }

  override async getUserInfo(_baseUrl: string, _accessToken: string): Promise<UserInfo | null> {
    return null;
  }

  async checkin(_baseUrl: string, _accessToken: string): Promise<CheckinResult> {
    return { success: false, message: 'CLIProxyAPI does not support checkin' };
  }

  async getBalance(_baseUrl: string, _accessToken: string): Promise<BalanceInfo> {
    return { balance: 0, used: 0, quota: 0 };
  }

  async getModels(baseUrl: string, apiToken: string): Promise<string[]> {
    try {
      const base = normalizeBaseUrl(baseUrl);
      const res = await this.fetchJson<any>(`${base}/v1/models`, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      return (res?.data || []).map((m: any) => m?.id).filter(Boolean);
    } catch {
      return [];
    }
  }
}

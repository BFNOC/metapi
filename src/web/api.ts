import { clearAuthSession, getAuthToken } from './authSession.js';

type RequestOptions = RequestInit & {
  timeoutMs?: number;
};

export class ApiRequestError<T = unknown> extends Error {
  statusCode: number;
  responseBody: T | string | null;

  constructor(message: string, statusCode: number, responseBody: T | string | null = null) {
    super(message);
    this.name = 'ApiRequestError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

function requireAuthToken(): string {
  const token = getAuthToken(localStorage);
  if (!token) {
    const hadToken = !!localStorage.getItem('auth_token');
    clearAuthSession(localStorage);
    if (hadToken && typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
      window.location.reload();
    }
    throw new Error('Session expired');
  }
  return token;
}

async function extractResponseError(res: Response): Promise<{
  message: string;
  body: unknown;
}> {
  let message = `HTTP ${res.status}`;
  let body: unknown = null;
  try {
    const text = await res.text();
    if (text) {
      try {
        const json = JSON.parse(text);
        body = json;
        if (json?.message && typeof json.message === 'string') {
          message = json.message;
        } else if (json?.error && typeof json.error === 'string') {
          message = json.error;
        } else if (json?.error?.message && typeof json.error.message === 'string') {
          message = json.error.message;
        } else {
          message = `${message}: ${text.slice(0, 120)}`;
        }
      } catch {
        body = text;
        message = `${message}: ${text.slice(0, 120)}`;
      }
    }
  } catch { }
  return { message, body };
}

function parseContentDispositionFilename(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(headerValue);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const quotedMatch = /filename="([^"]+)"/i.exec(headerValue);
  if (quotedMatch?.[1]) return quotedMatch[1];
  const bareMatch = /filename=([^;]+)/i.exec(headerValue);
  return bareMatch?.[1]?.trim() || null;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(buffer).toString('base64');
  }

  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function fetchAuthenticatedResponse(url: string, options: RequestOptions = {}): Promise<Response> {
  const { timeoutMs = 30_000, signal: externalSignal, ...fetchOptions } = options;
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  let cleanupExternalSignal = () => { };

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      const abortHandler = () => controller.abort();
      externalSignal.addEventListener('abort', abortHandler, { once: true });
      cleanupExternalSignal = () => externalSignal.removeEventListener('abort', abortHandler);
    }
  }

  const token = requireAuthToken();
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
  };
  if (fetchOptions.body) headers['Content-Type'] = 'application/json';

  try {
    const res = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        ...headers,
        ...fetchOptions.headers as Record<string, string>,
      },
    });
    if (res.status === 401 || res.status === 403) {
      const hadToken = !!getAuthToken(localStorage);
      clearAuthSession(localStorage);
      if (hadToken && typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
        window.location.reload();
      }
      throw new Error('Session expired');
    }
    return res;
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      if (externalSignal?.aborted) throw error;
      throw new Error(`请求超时（${Math.max(1, Math.round(timeoutMs / 1000))}s）`);
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    cleanupExternalSignal();
  }
}

async function request(url: string, options: RequestOptions = {}) {
  const res = await fetchAuthenticatedResponse(url, options);
  if (!res.ok) {
    const { message, body } = await extractResponseError(res);
    throw new ApiRequestError(message, res.status, body);
  }
  return res.json();
}

/** Stream SSE probe results, calling onResult for each model as it completes. */
async function streamProbeResults(
  url: string,
  data: Record<string, unknown>,
  onResult: (result: unknown) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetchAuthenticatedResponse(url, {
    method: 'POST',
    body: JSON.stringify(data),
    headers: { 'Accept': 'text/event-stream' },
    timeoutMs: 300_000,
    signal,
  });
  if (!res.ok) {
    const { message, body } = await extractResponseError(res);
    throw new ApiRequestError(message, res.status, body);
  }
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);
        if (payload === '[DONE]') return;
        try {
          onResult(JSON.parse(payload));
        } catch { /* skip malformed */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function buildQueryString(params?: Record<string, string | number | boolean | null | undefined>) {
  if (!params) return '';
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    searchParams.set(key, String(value));
  }
  const serialized = searchParams.toString();
  return serialized ? `?${serialized}` : '';
}

type TestChatRequestPayload = {
  model: string;
  messages: Array<{ role: string; content: string }>;
  targetFormat?: 'openai' | 'claude' | 'responses' | 'gemini';
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
};

export type ProxyTestMethod = 'POST' | 'GET' | 'DELETE';
export type ProxyTestRequestKind = 'json' | 'multipart' | 'empty';

export type ProxyTestMultipartFile = {
  field: string;
  name: string;
  mimeType: string;
  dataUrl: string;
};

export type ProxyTestRequestEnvelope = {
  method: ProxyTestMethod;
  path: string;
  requestKind: ProxyTestRequestKind;
  stream?: boolean;
  jobMode?: boolean;
  rawMode?: boolean;
  jsonBody?: unknown;
  rawJsonText?: string;
  multipartFields?: Record<string, string>;
  multipartFiles?: ProxyTestMultipartFile[];
};

type ChannelProbeResultPayload = {
  channelId: number;
  status: 'supported' | 'unsupported' | 'inconclusive' | 'skipped';
  ttftMs: number | null;
  httpStatus: number | null;
  error: string | null;
};

type ApplyProbeRankingItem = Pick<ChannelProbeResultPayload, 'channelId' | 'ttftMs' | 'status' | 'httpStatus' | 'error'>;

const DEFAULT_PROXY_TEST_TIMEOUT_MS = 30_000;
const LONG_RUNNING_PROXY_TEST_TIMEOUT_MS = 150_000;

function resolveProxyTestTimeoutMs(data: ProxyTestRequestEnvelope) {
  if (data.jobMode) return LONG_RUNNING_PROXY_TEST_TIMEOUT_MS;
  if (data.path === '/v1/images/generations') return LONG_RUNNING_PROXY_TEST_TIMEOUT_MS;
  if (data.path === '/v1/images/edits') return LONG_RUNNING_PROXY_TEST_TIMEOUT_MS;
  if (data.path === '/v1/videos' && data.method === 'POST') return LONG_RUNNING_PROXY_TEST_TIMEOUT_MS;
  return DEFAULT_PROXY_TEST_TIMEOUT_MS;
}

function proxyTestRequest(data: ProxyTestRequestEnvelope) {
  return request('/api/test/proxy', {
    method: 'POST',
    body: JSON.stringify(data),
    timeoutMs: resolveProxyTestTimeoutMs(data),
  });
}

async function proxyTestStreamRequest(data: ProxyTestRequestEnvelope, signal?: AbortSignal) {
  const token = getAuthToken(localStorage);
  if (!token) {
    clearAuthSession(localStorage);
    throw new Error('Session expired');
  }
  const response = await fetch('/api/test/proxy/stream', {
    method: 'POST',
    signal,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });
  if (response.status === 401 || response.status === 403) {
    clearAuthSession(localStorage);
    throw new Error('Session expired');
  }
  return response;
}

export type ProxyTestJobResponse = {
  jobId: string;
  status: 'pending' | 'succeeded' | 'failed' | 'cancelled';
  result?: unknown;
  error?: unknown;
  createdAt?: string;
  updatedAt?: string;
  expiresAt?: string;
};

export type SystemProxyTestRequest = {
  proxyUrl?: string;
};

export type SystemProxyTestResponse = {
  success: true;
  proxyUrl: string;
  probeUrl: string;
  finalUrl: string;
  reachable: true;
  ok: boolean;
  statusCode: number;
  latencyMs: number;
};

export type ProxyLogStatusFilter = 'all' | 'success' | 'failed';
export type ProxyLogClientConfidence = 'exact' | 'heuristic' | 'unknown' | null;
export type ProxyLogUsageSource = 'upstream' | 'self-log' | 'unknown' | null;

export type ProxyLogBillingDetails = {
  quotaType: number;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    billablePromptTokens: number;
    promptTokensIncludeCache: boolean | null;
  };
  pricing: {
    modelRatio: number;
    completionRatio: number;
    cacheRatio: number;
    cacheCreationRatio: number;
    groupRatio: number;
  };
  breakdown: {
    inputPerMillion: number;
    outputPerMillion: number;
    cacheReadPerMillion: number;
    cacheCreationPerMillion: number;
    inputCost: number;
    outputCost: number;
    cacheReadCost: number;
    cacheCreationCost: number;
    totalCost: number;
  };
} | null;

export type ProxyLogListItem = {
  id: number;
  createdAt: string;
  modelRequested: string;
  modelActual: string;
  status: string;
  latencyMs: number;
  isStream?: boolean | null;
  firstByteLatencyMs?: number | null;
  totalTokens: number | null;
  retryCount: number;
  accountId?: number | null;
  siteId?: number | null;
  username?: string | null;
  siteName?: string | null;
  siteUrl?: string | null;
  errorMessage?: string | null;
  downstreamKeyId?: number | null;
  downstreamKeyName?: string | null;
  downstreamKeyGroupName?: string | null;
  downstreamKeyTags?: string[];
  clientFamily?: string | null;
  clientAppId?: string | null;
  clientAppName?: string | null;
  clientConfidence?: ProxyLogClientConfidence;
  usageSource?: ProxyLogUsageSource;
  promptTokens?: number | null;
  completionTokens?: number | null;
  estimatedCost?: number | null;
};

export type ProxyLogDetail = ProxyLogListItem & {
  routeId?: number | null;
  channelId?: number | null;
  httpStatus?: number | null;
  billingDetails?: ProxyLogBillingDetails;
  runtimeEndpointAffinity?: {
    isRuntimeOnly: true;
    scope: 'text_default';
    downstreamFormat: 'openai' | 'claude' | 'responses';
    preferredEndpoint: 'chat' | 'messages' | 'responses' | null;
    blockedEndpoints: Array<{
      endpoint: 'chat' | 'messages' | 'responses';
      blockedUntilMs: number;
      remainingMs: number;
    }>;
  } | null;
};

export type ProxyLogsSummary = {
  totalCount: number;
  successCount: number;
  failedCount: number;
  totalCost: number;
  totalTokensAll: number;
};

export type ProxyLogsQuery = {
  limit?: number;
  offset?: number;
  status?: ProxyLogStatusFilter;
  search?: string;
  client?: string;
  siteId?: number;
  from?: string;
  to?: string;
};

export type ProxyLogClientOption = {
  value: string;
  label: string;
};

export type ProxyLogsResponse = {
  items: ProxyLogListItem[];
  total: number;
  page: number;
  pageSize: number;
  clientOptions: ProxyLogClientOption[];
  summary: ProxyLogsSummary;
};

export type OAuthProviderInfo = {
  provider: string;
  label: string;
  platform: string;
  enabled: boolean;
  loginType: 'oauth';
  requiresProjectId: boolean;
  supportsDirectAccountRouting: boolean;
  supportsCloudValidation: boolean;
  supportsNativeProxy: boolean;
};

export type OAuthStartInstructions = {
  redirectUri: string;
  callbackPort: number;
  callbackPath: string;
  manualCallbackDelayMs: number;
  sshTunnelCommand?: string;
  sshTunnelKeyCommand?: string;
};

export type OAuthStartResponse = {
  provider: string;
  state: string;
  authorizationUrl: string;
  instructions: OAuthStartInstructions;
};

export type OAuthSessionInfo = {
  provider: string;
  state: string;
  status: 'pending' | 'success' | 'error';
  accountId?: number;
  siteId?: number;
  error?: string;
};

export type OAuthQuotaWindowInfo = {
  supported: boolean;
  limit?: number | null;
  used?: number | null;
  remaining?: number | null;
  resetAt?: string | null;
  message?: string | null;
};

export type OAuthQuotaInfo = {
  status: 'supported' | 'unsupported' | 'error';
  source: 'official' | 'reverse_engineered';
  lastSyncAt?: string | null;
  lastError?: string | null;
  providerMessage?: string | null;
  subscription?: {
    planType?: string | null;
    activeStart?: string | null;
    activeUntil?: string | null;
  } | null;
  windows: {
    fiveHour: OAuthQuotaWindowInfo;
    sevenDay: OAuthQuotaWindowInfo;
  };
  lastLimitResetAt?: string | null;
};

export type OAuthConnectionInfo = {
  accountId: number;
  siteId: number;
  provider: string;
  username?: string | null;
  email?: string | null;
  accountKey?: string | null;
  planType?: string | null;
  projectId?: string | null;
  modelCount: number;
  modelsPreview: string[];
  status: 'healthy' | 'abnormal';
  quota?: OAuthQuotaInfo | null;
  routeChannelCount?: number;
  lastModelSyncAt?: string | null;
  lastModelSyncError?: string | null;
  site?: { id: number; name: string; url: string; platform: string } | null;
};

export type OAuthConnectionsResponse = {
  items: OAuthConnectionInfo[];
  total: number;
  limit: number;
  offset: number;
};

export type SiteEndpointOverrides = string[] | null;

export type SiteRecord = {
  id: number;
  name: string;
  url: string;
  externalCheckinUrl?: string | null;
  platform?: string;
  status?: string;
  proxyUrl?: string | null;
  useSystemProxy?: boolean;
  customHeaders?: string | null;
  endpointOverrides?: SiteEndpointOverrides;
  globalWeight?: number;
  isPinned?: boolean;
  sortOrder?: number;
  totalBalance?: number;
  probeDisabled?: boolean;
  modelFilterMode?: string | null;
  createdAt?: string;
};

export type SiteMutationPayload = {
  name?: string;
  url?: string;
  externalCheckinUrl?: string;
  platform?: string;
  proxyUrl?: string;
  useSystemProxy?: boolean;
  customHeaders?: string;
  endpointOverrides?: SiteEndpointOverrides;
  globalWeight?: number;
  probeDisabled?: boolean;
  status?: string;
  isPinned?: boolean;
  sortOrder?: number;
  modelFilterMode?: string;
  postRefreshProbeEnabled?: boolean;
  postRefreshProbeModel?: string;
  postRefreshProbeScope?: 'single' | 'all';
  postRefreshProbeLatencyThresholdMs?: number;
};

export type AccountMutationPayload = {
  siteId?: number;
  username?: string;
  accessToken?: string;
  accessTokens?: string[];
  apiToken?: string | null;
  platformUserId?: number;
  checkinEnabled?: boolean;
  credentialMode?: 'auto' | 'session' | 'apikey';
  refreshToken?: string | null;
  tokenExpiresAt?: number | string | null;
  skipModelFetch?: boolean;
  status?: string;
  unitCost?: number | null;
  extraConfig?: string;
  isPinned?: boolean;
  sortOrder?: number;
  proxyUrl?: string | null;
  modelMapping?: Record<string, string> | null;
  endpointOverrides?: string[] | null;
};

export type AccountTokenMutationPayload = {
  accountId?: number;
  name?: string;
  token?: string;
  enabled?: boolean;
  isDefault?: boolean;
  source?: string;
  group?: string;
  unlimitedQuota?: boolean | string;
  remainQuota?: number | string;
  expiredTime?: number | string;
  allowIps?: string;
  modelLimitsEnabled?: boolean | string;
  modelLimits?: string;
  endpointOverrides?: string[] | null;
};

export type SiteHealthState = 'active' | 'penalized' | 'quarantined' | 'recovering';
export type SiteHealthFailureCategory =
  | 'auth'
  | 'rate_limit_429'
  | 'quota_exhausted'
  | 'upstream_5xx'
  | 'challenge'
  | 'empty'
  | 'timeout'
  | 'other'
  | null;
export type SiteHealthProbePolicy = 'allow_recovery_probe' | 'manual_only' | 'forbid_batch_probe';

export type SiteHealthCooldownSummary = {
  activeChannelCooldownCount: number;
  affectedRouteCount: number;
  earliestCooldownUntil: string | null;
  latestCooldownUntil: string | null;
};

export type SiteHealthFailureSummary = {
  kind: SiteHealthFailureCategory;
  message: string | null;
  httpStatus: number | null;
  occurredAt: string | null;
};

export type SiteHealthSuccessSummary = {
  modelName: string | null;
  httpStatus: number | null;
  firstByteLatencyMs: number | null;
  latencyMs: number | null;
  occurredAt: string | null;
};

export type SiteHealthStateRow = {
  siteId: number;
  siteName: string;
  siteUrl: string | null;
  platform: string | null;
  siteStatus: string;
  state: SiteHealthState;
  probePolicy: SiteHealthProbePolicy;
  breakerOpen: boolean;
  penaltyScore: number;
  latencyEmaMs: number | null;
  cooldownSummary: SiteHealthCooldownSummary;
  lastSuccessAt: string | null;
  recentSuccessSummary: SiteHealthSuccessSummary | null;
  lastFailureAt: string | null;
  recentFailureSummary: SiteHealthFailureSummary | null;
  activeModelCount: number;
  unhealthyModelCount: number;
  recentFailureCount: number;
  severeFailureCount: number;
  isPinned: boolean;
  sortOrder: number;
};

export type SiteHealthStatesResponse = {
  enabled: boolean;
  items: SiteHealthStateRow[];
};

export type SiteHealthManualVerifyResponse = {
  success: boolean;
  siteId: number;
  siteName: string;
  probePolicy: SiteHealthProbePolicy;
  candidateModel: string | null;
  candidateSource: 'route' | 'availability' | 'allow_list' | 'none';
  recoveryHint: boolean;
  message: string;
  result: {
    modelName: string | null;
    status: string | null;
    ttftMs: number | null;
    httpStatus: number | null;
    error: string | null;
  } | null;
};

export type RuntimeSettingsPayload = {
  proxyToken?: string;
  codexUpstreamWebsocketEnabled?: boolean;
  responsesCompactFallbackToResponsesEnabled?: boolean;
  proxySessionChannelConcurrencyLimit?: number;
  proxySessionChannelQueueWaitMs?: number;
  systemProxyUrl?: string;
  payloadRules?: unknown;
  proxyErrorKeywords?: string[] | string;
  proxyEmptyContentFailEnabled?: boolean;
  adminIpAllowlist?: string[] | string;
  routingFallbackUnitCost?: number;
  proxyFirstByteTimeoutSec?: number;
  tokenRouterFailureCooldownMaxSec?: number;
  routingWeights?: Record<string, unknown>;
  checkinCron?: string;
  checkinScheduleMode?: 'cron' | 'interval';
  checkinIntervalHours?: number;
  balanceRefreshCron?: string;
  logCleanupCron?: string;
  logCleanupUsageLogsEnabled?: boolean;
  logCleanupProgramLogsEnabled?: boolean;
  logCleanupRetentionDays?: number;
  webhookUrl?: string;
  barkUrl?: string;
  webhookEnabled?: boolean;
  barkEnabled?: boolean;
  serverChanEnabled?: boolean;
  serverChanKey?: string;
  telegramEnabled?: boolean;
  telegramApiBaseUrl?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  telegramUseSystemProxy?: boolean;
  telegramMessageThreadId?: string;
  smtpEnabled?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPass?: string;
  smtpFrom?: string;
  smtpTo?: string;
  notifyCooldownSec?: number;
  globalBlockedBrands?: string[];
};

export const api = {
  // Sites
  getSites: () => request('/api/sites'),
  addSite: (data: SiteMutationPayload) => request('/api/sites', { method: 'POST', body: JSON.stringify(data) }) as Promise<SiteRecord>,
  updateSite: (id: number, data: SiteMutationPayload) => request(`/api/sites/${id}`, { method: 'PUT', body: JSON.stringify(data) }) as Promise<SiteRecord>,
  deleteSite: (id: number) => request(`/api/sites/${id}`, { method: 'DELETE' }),
  batchUpdateSites: (data: any) => request('/api/sites/batch', { method: 'POST', body: JSON.stringify(data) }),
  detectSite: (url: string) => request('/api/sites/detect', { method: 'POST', body: JSON.stringify({ url }) }),
  getSiteDisabledModels: (siteId: number) => request(`/api/sites/${siteId}/disabled-models`),
  updateSiteDisabledModels: (siteId: number, models: string[]) => request(`/api/sites/${siteId}/disabled-models`, { method: 'PUT', body: JSON.stringify({ models }) }),
  getSiteHealthStates: () => request('/api/site-health/states') as Promise<SiteHealthStatesResponse>,
  manualVerifySiteHealth: (siteId: number) =>
    request(`/api/site-health/manual-verify/${siteId}`, {
      method: 'POST',
      timeoutMs: 30_000,
    }) as Promise<SiteHealthManualVerifyResponse>,
  resetSiteHealth: (siteId: number) => request(`/api/sites/${siteId}/reset-health`, { method: 'POST' }),
  getSiteAvailableModels: (siteId: number) => request(`/api/sites/${siteId}/available-models`),
  probeModels: (siteId: number, data: { modelNames?: string[]; prompt?: string; concurrency?: number; timeoutMs?: number }) =>
    request(`/api/sites/${siteId}/probe-models`, { method: 'POST', body: JSON.stringify(data), timeoutMs: 120_000 }),
  probeModelsStream: (siteId: number, data: Record<string, unknown>, onResult: (r: unknown) => void, signal?: AbortSignal) =>
    streamProbeResults(`/api/sites/${siteId}/probe-models`, data, onResult, signal),
  probeSiteNow: (siteId: number, options?: { scope?: 'single' | 'all'; modelName?: string; latencyThresholdMs?: number }) =>
    request(`/api/sites/${siteId}/probe-now`, {
      method: 'POST',
      body: JSON.stringify(options || {}),
      timeoutMs: options?.scope === 'all' ? 120_000 : 30_000,
    }),
  getSiteAllowedModels: (siteId: number) => request(`/api/sites/${siteId}/allowed-models`),
  updateSiteAllowedModels: (siteId: number, models: string[], modelFilterMode?: string) =>
    request(`/api/sites/${siteId}/allowed-models`, {
      method: 'PUT',
      body: JSON.stringify({ models, ...(modelFilterMode ? { modelFilterMode } : {}) }),
    }),
  updateSiteModelFilter: (siteId: number, data: { modelFilterMode: string; models: string[] }) =>
    request(`/api/sites/${siteId}/model-filter`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  // Accounts
  getAccounts: () => request('/api/accounts'),
  addAccount: (data: AccountMutationPayload) => request('/api/accounts', { method: 'POST', body: JSON.stringify(data) }),
  loginAccount: (data: { siteId: number; username: string; password: string }) => request('/api/accounts/login', { method: 'POST', body: JSON.stringify(data) }),
  verifyToken: (data: { siteId: number; accessToken: string; platformUserId?: number; credentialMode?: 'auto' | 'session' | 'apikey' }) => request('/api/accounts/verify-token', { method: 'POST', body: JSON.stringify(data) }),
  rebindAccountSession: (id: number, data: { accessToken: string; platformUserId?: number; refreshToken?: string; tokenExpiresAt?: number }) =>
    request(`/api/accounts/${id}/rebind-session`, { method: 'POST', body: JSON.stringify(data) }),
  updateAccount: (id: number, data: AccountMutationPayload) => request(`/api/accounts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAccount: (id: number) => request(`/api/accounts/${id}`, { method: 'DELETE' }),
  batchUpdateAccounts: (data: any) => request('/api/accounts/batch', { method: 'POST', body: JSON.stringify(data) }),
  refreshBalance: (id: number) => request(`/api/accounts/${id}/balance`, { method: 'POST' }),
  getAccountModels: (id: number) => request(`/api/accounts/${id}/models`),
  addAccountAvailableModels: (accountId: number, models: string[]) => request(`/api/accounts/${accountId}/models/manual`, { method: 'POST', body: JSON.stringify({ models }) }),
  deleteAccountManualModel: (accountId: number, model: string) => request(`/api/accounts/${accountId}/models/manual`, { method: 'DELETE', body: JSON.stringify({ model }) }),
  refreshAccountHealth: (data?: { accountId?: number; wait?: boolean }) => request('/api/accounts/health/refresh', {
    method: 'POST',
    body: JSON.stringify(data || {}),
    timeoutMs: data?.wait ? 150_000 : 30_000,
  }),

  // Account tokens
  getAccountTokens: (accountId?: number) => request(`/api/account-tokens${accountId ? `?accountId=${accountId}` : ''}`),
  addAccountToken: (data: AccountTokenMutationPayload) => request('/api/account-tokens', { method: 'POST', body: JSON.stringify(data) }),
  updateAccountToken: (id: number, data: AccountTokenMutationPayload) => request(`/api/account-tokens/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAccountToken: (id: number) => request(`/api/account-tokens/${id}`, { method: 'DELETE' }),
  batchUpdateAccountTokens: (data: any) => request('/api/account-tokens/batch', { method: 'POST', body: JSON.stringify(data) }),
  getAccountTokenGroups: (accountId: number) => request(`/api/account-tokens/groups/${accountId}`),
  setDefaultAccountToken: (id: number) => request(`/api/account-tokens/${id}/default`, { method: 'POST' }),
  getAccountTokenValue: (id: number) => request(`/api/account-tokens/${id}/value`),
  syncAccountTokens: (accountId: number) => request(`/api/account-tokens/sync/${accountId}`, { method: 'POST', timeoutMs: 45_000 }),
  syncAllAccountTokens: (wait = false) => request('/api/account-tokens/sync-all', {
    method: 'POST',
    body: JSON.stringify(wait ? { wait: true } : {}),
    timeoutMs: wait ? 150_000 : 30_000,
  }),
  probeAccountTokenModels: (tokenId: number, data: { modelNames?: string[]; prompt?: string; concurrency?: number; timeoutMs?: number }) =>
    request(`/api/account-tokens/${tokenId}/probe-models`, { method: 'POST', body: JSON.stringify(data), timeoutMs: 120_000 }),
  probeAccountTokenModelsStream: (tokenId: number, data: Record<string, unknown>, onResult: (r: unknown) => void, signal?: AbortSignal) =>
    streamProbeResults(`/api/account-tokens/${tokenId}/probe-models`, data, onResult, signal),
  getTokenModels: (tokenId: number) => request(`/api/account-tokens/${tokenId}/models`),
  refreshTokenModels: (tokenId: number) =>
    request(`/api/account-tokens/${tokenId}/refresh-models`, { method: 'POST', timeoutMs: 30_000 }),
  getTokenModelFilter: (tokenId: number) => request(`/api/account-tokens/${tokenId}/model-filter`),
  updateTokenModelFilter: (tokenId: number, data: { modelFilterMode: string; filteredModels: string[] }) =>
    request(`/api/account-tokens/${tokenId}/model-filter`, { method: 'PUT', body: JSON.stringify(data) }),
  getTokenModelMapping: (tokenId: number) => request(`/api/account-tokens/${tokenId}/model-mapping`),
  updateTokenModelMapping: (tokenId: number, data: { modelMapping: Record<string, string> | null }) =>
    request(`/api/account-tokens/${tokenId}/model-mapping`, { method: 'PUT', body: JSON.stringify(data) }),

  // Check-in
  triggerCheckinAll: () => request('/api/checkin/trigger', { method: 'POST' }),
  triggerCheckin: (id: number) => request(`/api/checkin/trigger/${id}`, { method: 'POST' }),
  getCheckinLogs: (params?: string) => request(`/api/checkin/logs${params ? '?' + params : ''}`),
  updateCheckinSchedule: (cron: string) => request('/api/checkin/schedule', { method: 'PUT', body: JSON.stringify({ cron }) }),

  // Routes
  getRoutes: () => request('/api/routes'),
  getRoutesLite: () => request('/api/routes/lite'),
  getRoutesSummary: () => request('/api/routes/summary'),
  getRouteChannels: (routeId: number) => request(`/api/routes/${routeId}/channels`),
  probeChannel: (channelId: number) =>
    request(`/api/channels/${channelId}/probe`, { method: 'POST', timeoutMs: 30_000 }) as Promise<{ success: boolean; result: ChannelProbeResultPayload }>,
  probeRouteChannelsStream: (
    routeId: number,
    data: { timeoutMs?: number; concurrency?: number } | undefined,
    onResult: (r: unknown) => void,
    signal?: AbortSignal,
  ) => streamProbeResults(`/api/routes/${routeId}/channels/probe`, data || {}, onResult, signal),
  applyProbeRanking: (routeId: number, ranking: ApplyProbeRankingItem[]) =>
    request(`/api/routes/${routeId}/channels/apply-probe-ranking`, {
      method: 'POST',
      body: JSON.stringify({ ranking }),
    }) as Promise<{ success: boolean; updatedCount: number }>,
  batchAddChannels: (routeId: number, channels: Array<{ accountId: number; tokenId?: number | null; sourceModel?: string }>) =>
    request(`/api/routes/${routeId}/channels/batch`, { method: 'POST', body: JSON.stringify({ channels }) }),
  addRoute: (data: any) => request('/api/routes', { method: 'POST', body: JSON.stringify(data) }),
  updateRoute: (id: number, data: any) => request(`/api/routes/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteRoute: (id: number) => request(`/api/routes/${id}`, { method: 'DELETE' }),
  batchUpdateRoutes: (data: { ids: number[]; action: 'enable' | 'disable' }) =>
    request('/api/routes/batch', { method: 'POST', body: JSON.stringify(data) }),
  addChannel: (routeId: number, data: any) => request(`/api/routes/${routeId}/channels`, { method: 'POST', body: JSON.stringify(data) }),
  updateChannel: (id: number, data: any) => request(`/api/channels/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  batchUpdateChannels: (updates: Array<{ id: number; priority: number }>) =>
    request('/api/channels/batch', { method: 'PUT', body: JSON.stringify({ updates }) }),
  deleteChannel: (id: number) => request(`/api/channels/${id}`, { method: 'DELETE' }),
  resetChannelCooldown: (id: number) => request(`/api/channels/${id}/reset-cooldown`, { method: 'POST' }),
  clearRouteCooldown: (routeId: number) => request(`/api/routes/${routeId}/cooldown/clear`, { method: 'POST' }),
  resetRouteChannelPriority: (routeId: number) =>
    request(`/api/routes/${routeId}/channels/reset-priority`, { method: 'POST' }),
  rebuildRoutes: (refreshModels = true, wait = false) => request('/api/routes/rebuild', {
    method: 'POST',
    body: JSON.stringify({ refreshModels, ...(wait ? { wait: true } : {}) }),
    timeoutMs: wait ? 150_000 : 30_000,
  }),
  getRouteDecision: (model: string) => request(`/api/routes/decision?model=${encodeURIComponent(model)}`),
  getRouteDecisionsBatch: (models: string[], options?: { refreshPricingCatalog?: boolean; persistSnapshots?: boolean }) => request('/api/routes/decision/batch', {
    method: 'POST',
    body: JSON.stringify({
      models,
      ...(options?.refreshPricingCatalog ? { refreshPricingCatalog: true } : {}),
      ...(options?.persistSnapshots ? { persistSnapshots: true } : {}),
    }),
  }),
  getRouteDecisionsByRouteBatch: (items: Array<{ routeId: number; model: string }>, options?: { refreshPricingCatalog?: boolean; persistSnapshots?: boolean }) => request('/api/routes/decision/by-route/batch', {
    method: 'POST',
    body: JSON.stringify({
      items,
      ...(options?.refreshPricingCatalog ? { refreshPricingCatalog: true } : {}),
      ...(options?.persistSnapshots ? { persistSnapshots: true } : {}),
    }),
  }),
  getRouteWideDecisionsBatch: (routeIds: number[], options?: { refreshPricingCatalog?: boolean; persistSnapshots?: boolean }) => request('/api/routes/decision/route-wide/batch', {
    method: 'POST',
    body: JSON.stringify({
      routeIds,
      ...(options?.refreshPricingCatalog ? { refreshPricingCatalog: true } : {}),
      ...(options?.persistSnapshots ? { persistSnapshots: true } : {}),
    }),
  }),

  // Stats
  getDashboard: () => request('/api/stats/dashboard'),
  getProxyLogs: (params?: ProxyLogsQuery) => request(`/api/stats/proxy-logs${buildQueryString(params)}`) as Promise<ProxyLogsResponse>,
  getProxyLogDetail: (id: number) => request(`/api/stats/proxy-logs/${id}`) as Promise<ProxyLogDetail>,
  checkModels: (accountId: number) => request(`/api/models/check/${accountId}`, { method: 'POST' }),
  getSiteDistribution: () => request('/api/stats/site-distribution'),
  getSiteTrend: (days = 7) => request(`/api/stats/site-trend?days=${days}`),
  getModelBySite: (siteId?: number, days = 7) =>
    request(`/api/stats/model-by-site?${siteId ? `siteId=${siteId}&` : ''}days=${days}`),

  // Search
  search: (query: string) => request('/api/search', { method: 'POST', body: JSON.stringify({ query, limit: 20 }) }),

  // OAuth
  getOAuthProviders: () => request('/api/oauth/providers') as Promise<{ providers: OAuthProviderInfo[] }>,
  startOAuthProvider: (provider: string, data?: { accountId?: number; projectId?: string }) => request(`/api/oauth/providers/${encodeURIComponent(provider)}/start`, {
    method: 'POST',
    body: JSON.stringify(data || {}),
  }) as Promise<OAuthStartResponse>,
  getOAuthSession: (state: string) => request(`/api/oauth/sessions/${encodeURIComponent(state)}`) as Promise<OAuthSessionInfo>,
  submitOAuthManualCallback: (state: string, callbackUrl: string) => request(`/api/oauth/sessions/${encodeURIComponent(state)}/manual-callback`, {
    method: 'POST',
    body: JSON.stringify({ callbackUrl }),
  }) as Promise<{ success: true }>,
  getOAuthConnections: (params?: { limit?: number; offset?: number }) =>
    request(`/api/oauth/connections${buildQueryString(params)}`) as Promise<OAuthConnectionsResponse>,
  refreshOAuthConnectionQuota: (accountId: number) => request(`/api/oauth/connections/${accountId}/quota/refresh`, {
    method: 'POST',
    body: JSON.stringify({}),
  }) as Promise<{ success: true; quota: OAuthQuotaInfo }>,
  rebindOAuthConnection: (accountId: number) => request(`/api/oauth/connections/${accountId}/rebind`, {
    method: 'POST',
    body: JSON.stringify({}),
  }) as Promise<OAuthStartResponse>,
  deleteOAuthConnection: (accountId: number) => request(`/api/oauth/connections/${accountId}`, {
    method: 'DELETE',
  }) as Promise<{ success: true }>,

  // Events
  getEvents: (params?: string) => request(`/api/events${params ? '?' + params : ''}`),
  getEventCount: () => request('/api/events/count'),
  markEventRead: (id: number) => request(`/api/events/${id}/read`, { method: 'POST' }),
  markAllEventsRead: () => request('/api/events/read-all', { method: 'POST' }),
  clearEvents: () => request('/api/events', { method: 'DELETE' }),
  getSiteAnnouncements: (params?: string) => request(`/api/site-announcements${params ? '?' + params : ''}`),
  markSiteAnnouncementRead: (id: number) => request(`/api/site-announcements/${id}/read`, { method: 'POST' }),
  markAllSiteAnnouncementsRead: () => request('/api/site-announcements/read-all', { method: 'POST' }),
  clearSiteAnnouncements: () => request('/api/site-announcements', { method: 'DELETE' }),
  syncSiteAnnouncements: (payload?: { siteId?: number }) => request('/api/site-announcements/sync', {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  }),
  getTasks: (limit = 50) => request(`/api/tasks?limit=${Math.max(1, Math.min(200, Math.trunc(limit)))}`),
  getTask: (id: string) => request(`/api/tasks/${encodeURIComponent(id)}`),

  // Auth management
  getAuthInfo: () => request('/api/settings/auth/info'),
  changeAuthToken: (oldToken: string, newToken: string) => request('/api/settings/auth/change', {
    method: 'POST', body: JSON.stringify({ oldToken, newToken }),
  }),
  getRuntimeSettings: () => request('/api/settings/runtime'),
  getBrandList: () => request('/api/settings/brand-list'),
  updateRuntimeSettings: (data: RuntimeSettingsPayload) => request('/api/settings/runtime', {
    method: 'PUT',
    body: JSON.stringify(data),
  }),
  testSystemProxy: (data: SystemProxyTestRequest) => request('/api/settings/system-proxy/test', {
    method: 'POST',
    body: JSON.stringify(data),
    timeoutMs: 20_000,
  }),
  getRuntimeDatabaseConfig: () => request('/api/settings/database/runtime'),
  updateRuntimeDatabaseConfig: (data: { dialect: 'sqlite' | 'mysql' | 'postgres'; connectionString: string; ssl?: boolean }) =>
    request('/api/settings/database/runtime', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  testExternalDatabaseConnection: (data: { dialect: 'sqlite' | 'mysql' | 'postgres'; connectionString: string; ssl?: boolean }) =>
    request('/api/settings/database/test-connection', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  migrateExternalDatabase: (data: { dialect: 'sqlite' | 'mysql' | 'postgres'; connectionString: string; overwrite?: boolean; ssl?: boolean }) =>
    request('/api/settings/database/migrate', {
      method: 'POST',
      body: JSON.stringify(data),
      timeoutMs: 120_000,
    }),
  getDownstreamApiKeys: () => request('/api/downstream-keys'),
  createDownstreamApiKey: (data: any) => request('/api/downstream-keys', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  updateDownstreamApiKey: (id: number, data: any) => request(`/api/downstream-keys/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  }),
  deleteDownstreamApiKey: (id: number) => request(`/api/downstream-keys/${id}`, {
    method: 'DELETE',
  }),
  batchDownstreamApiKeys: (data: {
    ids: number[];
    action: 'enable' | 'disable' | 'delete' | 'resetUsage' | 'updateMetadata';
    groupOperation?: 'keep' | 'set' | 'clear';
    groupName?: string;
    tagOperation?: 'keep' | 'append';
    tags?: string[];
  }) =>
    request('/api/downstream-keys/batch', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  resetDownstreamApiKeyUsage: (id: number) => request(`/api/downstream-keys/${id}/reset-usage`, {
    method: 'POST',
  }),
  getDownstreamApiKeysSummary: (params?: { range?: '24h' | '7d' | 'all'; status?: 'all' | 'enabled' | 'disabled'; search?: string }) =>
    request(`/api/downstream-keys/summary${buildQueryString(params)}`),
  getDownstreamApiKeyOverview: (id: number) => request(`/api/downstream-keys/${id}/overview`),
  getDownstreamApiKeyTrend: (id: number, params?: { range?: '24h' | '7d' | 'all' }) =>
    request(`/api/downstream-keys/${id}/trend${buildQueryString(params)}`),
  exportBackup: (type: 'all' | 'accounts' | 'preferences' = 'all') =>
    request(`/api/settings/backup/export?type=${encodeURIComponent(type)}`),
  importBackup: (data: any) =>
    request('/api/settings/backup/import', {
      method: 'POST',
      body: JSON.stringify({ data }),
    }),
  getBackupWebdavConfig: () => request('/api/settings/backup/webdav'),
  saveBackupWebdavConfig: (data: {
    enabled: boolean;
    fileUrl: string;
    username: string;
    password?: string;
    clearPassword?: boolean;
    exportType: 'all' | 'accounts' | 'preferences';
    autoSyncEnabled: boolean;
    autoSyncCron: string;
  }) =>
    request('/api/settings/backup/webdav', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  exportBackupToWebdav: (type?: 'all' | 'accounts' | 'preferences') =>
    request('/api/settings/backup/webdav/export', {
      method: 'POST',
      body: JSON.stringify(type ? { type } : {}),
      timeoutMs: 60_000,
    }),
  importBackupFromWebdav: () =>
    request('/api/settings/backup/webdav/import', {
      method: 'POST',
      body: JSON.stringify({}),
      timeoutMs: 60_000,
    }),
  clearRuntimeCache: () => request('/api/settings/maintenance/clear-cache', { method: 'POST' }),
  clearUsageData: () => request('/api/settings/maintenance/clear-usage', { method: 'POST' }),
  factoryReset: () => request('/api/settings/maintenance/factory-reset', { method: 'POST' }),
  testNotification: () => request('/api/settings/notify/test', { method: 'POST' }),

  // Monitor embed
  getMonitorConfig: () => request('/api/monitor/config'),
  updateMonitorConfig: (data: { ldohCookie?: string | null }) => request('/api/monitor/config', {
    method: 'PUT',
    body: JSON.stringify(data),
  }),
  initMonitorSession: () => request('/api/monitor/session', { method: 'POST' }),

  // Models marketplace
  getModelsMarketplace: (options?: { refresh?: boolean; includePricing?: boolean }) => {
    const params = new URLSearchParams();
    if (options?.refresh) params.set('refresh', '1');
    if (options?.includePricing) params.set('includePricing', '1');
    const query = params.toString();
    return request(`/api/models/marketplace${query ? `?${query}` : ''}`, { timeoutMs: options?.refresh ? 45_000 : 15_000 });
  },
  getModelTokenCandidates: () => request('/api/models/token-candidates'),

  // Simple chat test from admin panel
  startTestChatJob: (data: TestChatRequestPayload) =>
    request('/api/test/chat/jobs', { method: 'POST', body: JSON.stringify(data) }),
  getTestChatJob: (jobId: string) => request(`/api/test/chat/jobs/${encodeURIComponent(jobId)}`),
  deleteTestChatJob: (jobId: string) => request(`/api/test/chat/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' }),
  startProxyTestJob: (data: ProxyTestRequestEnvelope) =>
    request('/api/test/proxy/jobs', {
      method: 'POST',
      body: JSON.stringify(data),
      timeoutMs: resolveProxyTestTimeoutMs(data),
    }),
  getProxyTestJob: (jobId: string) => request(`/api/test/proxy/jobs/${encodeURIComponent(jobId)}`),
  deleteProxyTestJob: (jobId: string) => request(`/api/test/proxy/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' }),
  getProxyFileContentDataUrl: async (
    fileId: string,
    options: Pick<RequestOptions, 'signal' | 'timeoutMs'> = {},
  ) => {
    const response = await fetchAuthenticatedResponse(`/v1/files/${encodeURIComponent(fileId)}/content`, {
      method: 'GET',
      ...options,
    });
    if (!response.ok) {
      const { message, body } = await extractResponseError(response);
      throw new ApiRequestError(message, response.status, body);
    }

    const mimeType = (response.headers.get('content-type') || 'application/octet-stream')
      .split(';')[0]
      .trim() || 'application/octet-stream';
    const filename = parseContentDispositionFilename(response.headers.get('content-disposition'));
    const base64 = arrayBufferToBase64(await response.arrayBuffer());
    return {
      filename,
      mimeType,
      data: `data:${mimeType};base64,${base64}`,
    };
  },
  testProxy: proxyTestRequest,
  proxyTest: proxyTestRequest,
  testChat: (data: TestChatRequestPayload) =>
    request('/api/test/chat', { method: 'POST', body: JSON.stringify(data) }),
  testProxyStream: proxyTestStreamRequest,
  proxyTestStream: proxyTestStreamRequest,
  testChatStream: async (data: TestChatRequestPayload, signal?: AbortSignal) => {
    const token = getAuthToken(localStorage);
    if (!token) {
      clearAuthSession(localStorage);
      throw new Error('Session expired');
    }
    return fetch('/api/test/chat/stream', {
      method: 'POST',
      signal,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });
  },
};

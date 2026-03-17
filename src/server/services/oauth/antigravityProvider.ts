import { fetch } from 'undici';
import type { OAuthProviderDefinition } from './providers.js';

export const ANTIGRAVITY_OAUTH_PROVIDER = 'antigravity';
export const ANTIGRAVITY_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const ANTIGRAVITY_USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json';
export const ANTIGRAVITY_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
export const ANTIGRAVITY_CLIENT_SECRET = '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';
export const ANTIGRAVITY_LOOPBACK_CALLBACK_PORT = 51121;
export const ANTIGRAVITY_LOOPBACK_CALLBACK_PATH = '/oauth-callback';
export const ANTIGRAVITY_LOOPBACK_REDIRECT_URI = `http://localhost:${ANTIGRAVITY_LOOPBACK_CALLBACK_PORT}${ANTIGRAVITY_LOOPBACK_CALLBACK_PATH}`;
export const ANTIGRAVITY_UPSTREAM_BASE_URL = 'https://cloudcode-pa.googleapis.com';
export const ANTIGRAVITY_GOOGLE_API_CLIENT = 'google-cloud-sdk vscode_cloudshelleditor/0.1';
export const ANTIGRAVITY_USER_AGENT = 'google-api-nodejs-client/9.15.1';
export const ANTIGRAVITY_CLIENT_METADATA = '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}';

const ANTIGRAVITY_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
];

type AntigravityOAuthTokenPayload = {
  access_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  expiry?: unknown;
};

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseExpiresAt(payload: AntigravityOAuthTokenPayload): number | undefined {
  if (typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in) && payload.expires_in > 0) {
    return Date.now() + Math.trunc(payload.expires_in) * 1000;
  }
  if (typeof payload.expires_in === 'string') {
    const parsed = Number.parseInt(payload.expires_in.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Date.now() + parsed * 1000;
    }
  }
  if (typeof payload.expiry === 'string') {
    const parsed = Date.parse(payload.expiry);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

async function postAntigravityToken(body: URLSearchParams) {
  const response = await fetch(ANTIGRAVITY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `antigravity token exchange failed with status ${response.status}`);
  }
  const payload = await response.json() as AntigravityOAuthTokenPayload;
  const accessToken = asTrimmedString(payload.access_token);
  if (!accessToken) {
    throw new Error('antigravity token exchange response missing access token');
  }
  return {
    accessToken,
    refreshToken: asTrimmedString(payload.refresh_token),
    tokenExpiresAt: parseExpiresAt(payload),
    providerData: {
      tokenType: asTrimmedString(payload.token_type),
      scope: asTrimmedString(payload.scope),
    },
  };
}

async function fetchAntigravityUserEmail(accessToken: string): Promise<string | undefined> {
  const response = await fetch(ANTIGRAVITY_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) return undefined;
  const payload = await response.json() as { email?: unknown };
  return asTrimmedString(payload.email);
}

async function fetchAntigravityProjectId(accessToken: string): Promise<string | undefined> {
  const response = await fetch(`${ANTIGRAVITY_UPSTREAM_BASE_URL}/v1internal:loadCodeAssist`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': ANTIGRAVITY_USER_AGENT,
      'X-Goog-Api-Client': ANTIGRAVITY_GOOGLE_API_CLIENT,
      'Client-Metadata': ANTIGRAVITY_CLIENT_METADATA,
    },
    body: JSON.stringify({
      metadata: {
        ideType: 'ANTIGRAVITY',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI',
      },
    }),
  });
  if (!response.ok) return undefined;
  const payload = await response.json() as {
    cloudaicompanionProject?: unknown;
  };
  if (typeof payload.cloudaicompanionProject === 'string') {
    return asTrimmedString(payload.cloudaicompanionProject);
  }
  if (payload.cloudaicompanionProject && typeof payload.cloudaicompanionProject === 'object') {
    return asTrimmedString((payload.cloudaicompanionProject as { id?: unknown }).id);
  }
  return undefined;
}

export const antigravityOauthProvider: OAuthProviderDefinition = {
  metadata: {
    provider: ANTIGRAVITY_OAUTH_PROVIDER,
    label: 'Antigravity',
    platform: 'antigravity',
    enabled: true,
    loginType: 'oauth',
    requiresProjectId: false,
    supportsDirectAccountRouting: true,
    supportsCloudValidation: true,
    supportsNativeProxy: false,
  },
  site: {
    name: 'Google Antigravity OAuth',
    url: ANTIGRAVITY_UPSTREAM_BASE_URL,
    platform: 'antigravity',
  },
  loopback: {
    host: '127.0.0.1',
    port: ANTIGRAVITY_LOOPBACK_CALLBACK_PORT,
    path: ANTIGRAVITY_LOOPBACK_CALLBACK_PATH,
    redirectUri: ANTIGRAVITY_LOOPBACK_REDIRECT_URI,
  },
  buildAuthorizationUrl: async ({ state, redirectUri }) => {
    const params = new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      scope: ANTIGRAVITY_SCOPES.join(' '),
      state,
    });
    return `${ANTIGRAVITY_AUTH_URL}?${params.toString()}`;
  },
  exchangeAuthorizationCode: async ({ code, redirectUri }) => {
    const token = await postAntigravityToken(new URLSearchParams({
      code,
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }));
    const email = await fetchAntigravityUserEmail(token.accessToken);
    const projectId = await fetchAntigravityProjectId(token.accessToken);
    return {
      ...token,
      email,
      accountKey: email,
      accountId: email,
      projectId,
    };
  },
  refreshAccessToken: async ({ refreshToken, oauth }) => {
    const token = await postAntigravityToken(new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }));
    const email = await fetchAntigravityUserEmail(token.accessToken);
    return {
      ...token,
      email,
      accountKey: email,
      accountId: email,
      projectId: oauth?.projectId ?? await fetchAntigravityProjectId(token.accessToken),
    };
  },
  buildProxyHeaders: () => ({
    'User-Agent': ANTIGRAVITY_USER_AGENT,
    'X-Goog-Api-Client': ANTIGRAVITY_GOOGLE_API_CLIENT,
    'Client-Metadata': ANTIGRAVITY_CLIENT_METADATA,
  }),
};

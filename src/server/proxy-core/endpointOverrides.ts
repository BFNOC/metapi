import { normalizeUpstreamEndpointTypes, type UpstreamEndpoint } from './upstreamEndpointTypes.js';

const ALLOWED_ENDPOINT_OVERRIDE_VALUES = new Set(['chat', 'messages', 'responses']);

export type ResolvedEndpointOverride = {
  present: boolean;
  endpoints: UpstreamEndpoint[];
};

function normalizeEndpointOverrideArray(value: unknown): UpstreamEndpoint[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return Array.from(new Set(value
    .map((item) => (typeof item === 'string' ? item.trim().toLowerCase() : ''))
    .filter((item): item is UpstreamEndpoint => ALLOWED_ENDPOINT_OVERRIDE_VALUES.has(item))));
}

export function parseEndpointOverrideValue(value: unknown): ResolvedEndpointOverride {
  if (value === undefined || value === null) {
    return { present: false, endpoints: [] };
  }

  if (Array.isArray(value)) {
    const endpoints = dedupeEndpointList(value.flatMap((item) => parseEndpointOverrideValue(item).endpoints));
    return {
      present: endpoints.length > 0,
      endpoints,
    };
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return { present: false, endpoints: [] };

    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        return parseEndpointOverrideValue(JSON.parse(trimmed));
      } catch {
        // Fall through and treat it as a raw endpoint hint string.
      }
    }

    const splitEntries = trimmed
      .split(/[,\n]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (splitEntries.length > 1) {
      const endpoints = dedupeEndpointList(splitEntries.flatMap((entry) => normalizeUpstreamEndpointTypes(entry)));
      return {
        present: endpoints.length > 0,
        endpoints,
      };
    }
  }

  const endpoints = dedupeEndpointList(normalizeUpstreamEndpointTypes(value));
  return {
    present: endpoints.length > 0,
    endpoints,
  };
}

function dedupeEndpointList(candidates: readonly UpstreamEndpoint[]): UpstreamEndpoint[] {
  return Array.from(new Set(candidates));
}

export function resolveSiteEndpointOverride(site?: Record<string, unknown> | null): ResolvedEndpointOverride {
  return resolveRecordEndpointOverride(site);
}

export function resolveRecordEndpointOverride(
  record?: Record<string, unknown> | null,
): ResolvedEndpointOverride {
  if (!record) return { present: false, endpoints: [] };
  if (!Object.prototype.hasOwnProperty.call(record, 'endpointOverrides')) {
    return { present: false, endpoints: [] };
  }
  return parseEndpointOverrideValue(record.endpointOverrides);
}

function applyResolvedEndpointOverride(
  candidates: readonly UpstreamEndpoint[],
  override: ResolvedEndpointOverride,
): UpstreamEndpoint[] {
  const dedupedCandidates = dedupeEndpointList(candidates);
  if (!override.present) return dedupedCandidates;
  if (override.endpoints.length === 0) return [];

  const allowed = new Set(override.endpoints);
  return dedupedCandidates.filter((candidate) => allowed.has(candidate));
}

export function resolveEndpointCandidatesWithOverrides(input: {
  candidates: readonly UpstreamEndpoint[];
  site?: Record<string, unknown> | null;
  account?: Record<string, unknown> | null;
  token?: Record<string, unknown> | null;
  override?: unknown;
}): UpstreamEndpoint[] {
  const siteOverride = resolveRecordEndpointOverride(input.site);
  const accountOverride = resolveRecordEndpointOverride(input.account);
  const tokenOverride = resolveRecordEndpointOverride(input.token);
  const effectivePersistedOverride = tokenOverride.present
    ? tokenOverride
    : (accountOverride.present ? accountOverride : siteOverride);

  return applyResolvedEndpointOverride(
    applyResolvedEndpointOverride(input.candidates, effectivePersistedOverride),
    parseEndpointOverrideValue(input.override),
  );
}

export function normalizeEndpointOverridesInput(input: unknown): {
  endpointOverrides: string[] | null;
  error?: string;
} {
  if (input === undefined || input === null) {
    return { endpointOverrides: null };
  }

  let parsed: unknown = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) {
      return { endpointOverrides: null };
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return {
        endpointOverrides: null,
        error: 'Invalid endpointOverrides. Expected a valid JSON array.',
      };
    }
  }

  if (!Array.isArray(parsed)) {
    return {
      endpointOverrides: null,
      error: 'Invalid endpointOverrides. Expected a JSON array.',
    };
  }

  const rawValues = parsed
    .map((item) => (typeof item === 'string' ? item.trim().toLowerCase() : ''))
    .filter(Boolean);
  if (rawValues.some((item) => !ALLOWED_ENDPOINT_OVERRIDE_VALUES.has(item))) {
    return {
      endpointOverrides: null,
      error: 'Invalid endpointOverrides. Only chat/messages/responses are supported.',
    };
  }
  const normalized = Array.from(new Set(rawValues));

  return {
    endpointOverrides: normalized.length > 0 ? normalized : null,
  };
}

export function serializeEndpointOverridesValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const parsed = parseEndpointOverrideValue(value);
    if (!parsed.present || parsed.endpoints.length === 0) return null;
    return JSON.stringify(parsed.endpoints);
  }

  const normalized = normalizeEndpointOverrideArray(value);
  if (!normalized || normalized.length === 0) {
    return null;
  }
  return JSON.stringify(normalized);
}

export function buildEndpointCompatibilityUnavailableResponse(message: string): {
  statusCode: number;
  contentType: string;
  payload: {
    error: {
      message: string;
      type: 'invalid_request_error';
    };
  };
  text: string;
} {
  const payload = {
    error: {
      message,
      type: 'invalid_request_error' as const,
    },
  };

  return {
    statusCode: 501,
    contentType: 'application/json',
    payload,
    text: JSON.stringify(payload),
  };
}

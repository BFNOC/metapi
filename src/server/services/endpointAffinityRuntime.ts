export type EndpointAffinityRuntimeEndpoint = 'chat' | 'messages' | 'responses';
export type EndpointAffinityRuntimeView = {
  preferredEndpoint: EndpointAffinityRuntimeEndpoint | null;
  blockedEndpoints: Array<{
    endpoint: EndpointAffinityRuntimeEndpoint;
    blockedUntilMs: number;
    remainingMs: number;
  }>;
};

type EndpointRuntimeState = {
  preferredEndpoint: EndpointAffinityRuntimeEndpoint | null;
  preferredUpdatedAtMs: number;
  lastTouchedAtMs: number;
  blockedUntilMsByEndpoint: Partial<Record<EndpointAffinityRuntimeEndpoint, number>>;
  downgradeCountByEndpoint: Partial<Record<EndpointAffinityRuntimeEndpoint, number>>;
  downgradeUpdatedAtMsByEndpoint: Partial<Record<EndpointAffinityRuntimeEndpoint, number>>;
};

const ENDPOINT_RUNTIME_PREFERRED_TTL_MS = 24 * 60 * 60 * 1000;
const ENDPOINT_RUNTIME_BLOCK_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENDPOINT_RUNTIME_STATES = 512;
const endpointRuntimeStates = new Map<string, EndpointRuntimeState>();

function getOrCreateEndpointRuntimeState(key: string, nowMs = Date.now()): EndpointRuntimeState {
  sweepEndpointRuntimeStates(nowMs);
  const existing = endpointRuntimeStates.get(key);
  if (existing) {
    existing.lastTouchedAtMs = nowMs;
    return existing;
  }

  const initial: EndpointRuntimeState = {
    preferredEndpoint: null,
    preferredUpdatedAtMs: nowMs,
    lastTouchedAtMs: nowMs,
    blockedUntilMsByEndpoint: {},
    downgradeCountByEndpoint: {},
    downgradeUpdatedAtMsByEndpoint: {},
  };
  endpointRuntimeStates.set(key, initial);
  enforceEndpointRuntimeStateLimit();
  return initial;
}

function hasRecentDowngradeSignal(state: EndpointRuntimeState, nowMs: number): boolean {
  return Object.values(state.downgradeUpdatedAtMsByEndpoint).some((updatedAtMs) => (
    typeof updatedAtMs === 'number' && (updatedAtMs + ENDPOINT_RUNTIME_BLOCK_TTL_MS) > nowMs
  ));
}

function maybeDeleteEndpointRuntimeState(key: string, nowMs = Date.now()): void {
  const state = endpointRuntimeStates.get(key);
  if (!state) return;

  const hasActiveBlock = Object.values(state.blockedUntilMsByEndpoint).some((untilMs) => (
    typeof untilMs === 'number' && untilMs > nowMs
  ));
  const preferredFresh = (
    !!state.preferredEndpoint
    && (state.preferredUpdatedAtMs + ENDPOINT_RUNTIME_PREFERRED_TTL_MS) > nowMs
  );
  if (!hasActiveBlock && !preferredFresh && !hasRecentDowngradeSignal(state, nowMs)) {
    endpointRuntimeStates.delete(key);
  }
}

function sweepEndpointRuntimeStates(nowMs = Date.now()): void {
  for (const [key, state] of endpointRuntimeStates.entries()) {
    const hasActiveBlock = Object.values(state.blockedUntilMsByEndpoint).some((untilMs) => (
      typeof untilMs === 'number' && untilMs > nowMs
    ));
    const preferredFresh = (
      !!state.preferredEndpoint
      && (state.preferredUpdatedAtMs + ENDPOINT_RUNTIME_PREFERRED_TTL_MS) > nowMs
    );
    const recentlyTouched = (state.lastTouchedAtMs + ENDPOINT_RUNTIME_PREFERRED_TTL_MS) > nowMs;
    if (!hasActiveBlock && !preferredFresh && !recentlyTouched && !hasRecentDowngradeSignal(state, nowMs)) {
      endpointRuntimeStates.delete(key);
    }
  }
}

function enforceEndpointRuntimeStateLimit(): void {
  if (endpointRuntimeStates.size <= MAX_ENDPOINT_RUNTIME_STATES) return;

  const entries = [...endpointRuntimeStates.entries()]
    .sort((left, right) => left[1].lastTouchedAtMs - right[1].lastTouchedAtMs);
  const overflowCount = endpointRuntimeStates.size - MAX_ENDPOINT_RUNTIME_STATES;
  for (const [key] of entries.slice(0, overflowCount)) {
    endpointRuntimeStates.delete(key);
  }
}

export function resetEndpointAffinityRuntimeState(): void {
  endpointRuntimeStates.clear();
}

export function applyEndpointAffinityRuntimePreference(
  candidates: EndpointAffinityRuntimeEndpoint[],
  key: string,
  nowMs = Date.now(),
): EndpointAffinityRuntimeEndpoint[] {
  const state = endpointRuntimeStates.get(key);
  if (!state || candidates.length <= 1) return candidates;
  state.lastTouchedAtMs = nowMs;

  const blocked = new Set<EndpointAffinityRuntimeEndpoint>();
  for (const endpoint of candidates) {
    const untilMs = state.blockedUntilMsByEndpoint[endpoint];
    if (typeof untilMs === 'number' && untilMs > nowMs) {
      blocked.add(endpoint);
    }
  }

  let next = candidates.filter((endpoint) => !blocked.has(endpoint));
  if (next.length === 0) {
    next = [...candidates];
  }

  const preferredFresh = (
    !!state.preferredEndpoint
    && (state.preferredUpdatedAtMs + ENDPOINT_RUNTIME_PREFERRED_TTL_MS) > nowMs
  );
  if (preferredFresh && state.preferredEndpoint && next.includes(state.preferredEndpoint)) {
    next = [
      state.preferredEndpoint,
      ...next.filter((endpoint) => endpoint !== state.preferredEndpoint),
    ];
  }

  maybeDeleteEndpointRuntimeState(key, nowMs);
  return next;
}

export function recordEndpointAffinityRuntimeSuccess(input: {
  key: string;
  endpoint: EndpointAffinityRuntimeEndpoint;
  rememberPreferred?: boolean;
  nowMs?: number;
}): void {
  const nowMs = input.nowMs ?? Date.now();
  const state = getOrCreateEndpointRuntimeState(input.key, nowMs);
  if (input.rememberPreferred !== false) {
    state.preferredEndpoint = input.endpoint;
    state.preferredUpdatedAtMs = nowMs;
  }
  delete state.blockedUntilMsByEndpoint[input.endpoint];
  delete state.downgradeCountByEndpoint[input.endpoint];
  delete state.downgradeUpdatedAtMsByEndpoint[input.endpoint];
}

export function recordEndpointAffinityRuntimeDowngrade(input: {
  key: string;
  failedEndpoint: EndpointAffinityRuntimeEndpoint;
  recoveredEndpoint: EndpointAffinityRuntimeEndpoint;
  blockThreshold?: number;
  nowMs?: number;
}): void {
  const nowMs = input.nowMs ?? Date.now();
  const threshold = Math.max(1, Math.trunc(input.blockThreshold ?? 2));
  const state = getOrCreateEndpointRuntimeState(input.key, nowMs);

  state.preferredEndpoint = input.recoveredEndpoint;
  state.preferredUpdatedAtMs = nowMs;
  delete state.blockedUntilMsByEndpoint[input.recoveredEndpoint];
  delete state.downgradeCountByEndpoint[input.recoveredEndpoint];
  delete state.downgradeUpdatedAtMsByEndpoint[input.recoveredEndpoint];

  const nextCount = Math.max(0, state.downgradeCountByEndpoint[input.failedEndpoint] ?? 0) + 1;
  state.downgradeCountByEndpoint[input.failedEndpoint] = nextCount;
  state.downgradeUpdatedAtMsByEndpoint[input.failedEndpoint] = nowMs;
  if (nextCount >= threshold) {
    state.blockedUntilMsByEndpoint[input.failedEndpoint] = nowMs + ENDPOINT_RUNTIME_BLOCK_TTL_MS;
    delete state.downgradeCountByEndpoint[input.failedEndpoint];
    delete state.downgradeUpdatedAtMsByEndpoint[input.failedEndpoint];
  }
}

export function getEndpointAffinityRuntimeView(
  key: string,
  nowMs = Date.now(),
): EndpointAffinityRuntimeView | null {
  sweepEndpointRuntimeStates(nowMs);
  const state = endpointRuntimeStates.get(key);
  if (!state) return null;

  const preferredFresh = (
    !!state.preferredEndpoint
    && (state.preferredUpdatedAtMs + ENDPOINT_RUNTIME_PREFERRED_TTL_MS) > nowMs
  );
  const blockedEndpoints = (Object.entries(state.blockedUntilMsByEndpoint) as Array<[
    EndpointAffinityRuntimeEndpoint,
    number | undefined,
  ]>)
    .filter(([, untilMs]) => typeof untilMs === 'number' && untilMs > nowMs)
    .map(([endpoint, untilMs]) => ({
      endpoint,
      blockedUntilMs: untilMs!,
      remainingMs: untilMs! - nowMs,
    }))
    .sort((left, right) => left.blockedUntilMs - right.blockedUntilMs);

  if (!preferredFresh && blockedEndpoints.length === 0) {
    maybeDeleteEndpointRuntimeState(key, nowMs);
    return null;
  }

  const view = {
    preferredEndpoint: preferredFresh ? state.preferredEndpoint : null,
    blockedEndpoints,
  };
  maybeDeleteEndpointRuntimeState(key, nowMs);
  return view;
}

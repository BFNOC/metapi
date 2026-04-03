import type {
  ChannelProbeResult,
  ChannelProbeStatus,
  RouteChannel,
  RouteProbeSnapshot,
} from '../token-routes/types.js';

const STORAGE_KEY = 'metapi:route-probe-snapshots';
const STORE_VERSION = 1;
const MAX_ERROR_LENGTH = 200;
const VALID_PROBE_STATUSES: ReadonlySet<ChannelProbeStatus> = new Set([
  'supported',
  'unsupported',
  'inconclusive',
  'skipped',
]);

type RouteProbeSnapshotStore = {
  version: number;
  snapshots: Record<string, RouteProbeSnapshot>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const toNonNegativeInteger = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.trunc(value));
};

const toInteger = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.trunc(value);
};

const truncateError = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  return value.length > MAX_ERROR_LENGTH ? value.slice(0, MAX_ERROR_LENGTH) : value;
};

const normalizeProbeResult = (channelId: number, value: unknown): ChannelProbeResult | null => {
  if (!isRecord(value)) return null;
  const status = typeof value.status === 'string' && VALID_PROBE_STATUSES.has(value.status as ChannelProbeStatus)
    ? value.status as ChannelProbeStatus
    : null;
  if (!status) return null;

  return {
    channelId,
    status,
    ttftMs: typeof value.ttftMs === 'number' && Number.isFinite(value.ttftMs) ? value.ttftMs : null,
    httpStatus: typeof value.httpStatus === 'number' && Number.isFinite(value.httpStatus)
      ? Math.trunc(value.httpStatus)
      : null,
    error: truncateError(value.error),
  };
};

const normalizeSnapshot = (value: unknown): RouteProbeSnapshot | null => {
  if (!isRecord(value)) return null;
  if (typeof value.probedAt !== 'string' || Number.isNaN(Date.parse(value.probedAt))) return null;

  const expectedCount = toNonNegativeInteger(value.expectedCount);
  const completedCount = toNonNegativeInteger(value.completedCount);
  if (expectedCount == null || completedCount == null) return null;

  const rawFingerprint = Array.isArray(value.channelFingerprint) ? value.channelFingerprint : null;
  if (!rawFingerprint) return null;
  const channelFingerprint = rawFingerprint
    .filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
    .map((item) => Math.trunc(item));

  if (!isRecord(value.results)) return null;
  const results: Record<number, ChannelProbeResult> = {};
  for (const [channelIdText, resultValue] of Object.entries(value.results)) {
    const channelId = Number.parseInt(channelIdText, 10);
    if (!Number.isFinite(channelId)) continue;
    const normalized = normalizeProbeResult(channelId, resultValue);
    if (!normalized) continue;
    results[channelId] = normalized;
  }

  return {
    probedAt: value.probedAt,
    channelFingerprint,
    expectedCount,
    completedCount,
    results,
  };
};

const readSnapshots = (): Record<string, RouteProbeSnapshot> => {
  if (typeof localStorage === 'undefined') return {};

  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return {};
  }
  if (typeof raw !== 'string' || raw.trim().length === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  if (parsed.version !== STORE_VERSION) {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore storage cleanup failures
    }
    return {};
  }
  if (!isRecord(parsed.snapshots)) return {};

  const snapshots: Record<string, RouteProbeSnapshot> = {};
  for (const [routeIdText, snapshotValue] of Object.entries(parsed.snapshots)) {
    const routeId = Number.parseInt(routeIdText, 10);
    if (!Number.isFinite(routeId)) continue;
    const snapshot = normalizeSnapshot(snapshotValue);
    if (!snapshot) continue;
    snapshots[String(routeId)] = snapshot;
  }
  return snapshots;
};

const persistSnapshots = (snapshots: Record<string, RouteProbeSnapshot>): void => {
  if (typeof localStorage === 'undefined') return;
  if (Object.keys(snapshots).length === 0) {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore storage cleanup failures
    }
    return;
  }

  const payload: RouteProbeSnapshotStore = {
    version: STORE_VERSION,
    snapshots,
  };

  try {
    // Read-modify-write is acceptable here; multi-tab conflicts resolve by last writer wins.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore QuotaExceeded and unavailable storage
  }
};

const sanitizeSnapshotForStorage = (snapshot: RouteProbeSnapshot): RouteProbeSnapshot => {
  const results: Record<number, ChannelProbeResult> = {};
  for (const [channelIdText, resultValue] of Object.entries(snapshot.results)) {
    const channelId = Number.parseInt(channelIdText, 10);
    if (!Number.isFinite(channelId)) continue;
    const normalized = normalizeProbeResult(channelId, resultValue);
    if (!normalized) continue;
    results[channelId] = normalized;
  }

  return {
    probedAt: snapshot.probedAt,
    channelFingerprint: [...snapshot.channelFingerprint]
      .filter((channelId): channelId is number => typeof channelId === 'number' && Number.isFinite(channelId))
      .map((channelId) => Math.trunc(channelId))
      .sort((a, b) => a - b),
    expectedCount: Math.max(0, Math.trunc(snapshot.expectedCount)),
    completedCount: Math.max(0, Math.trunc(snapshot.completedCount)),
    results,
  };
};

export function loadRouteProbeSnapshots(): Record<number, RouteProbeSnapshot> {
  const snapshots = readSnapshots();
  const parsed: Record<number, RouteProbeSnapshot> = {};
  for (const [routeIdText, snapshot] of Object.entries(snapshots)) {
    const routeId = Number.parseInt(routeIdText, 10);
    if (!Number.isFinite(routeId)) continue;
    parsed[routeId] = snapshot;
  }
  return parsed;
}

export function saveRouteProbeSnapshot(routeId: number, snapshot: RouteProbeSnapshot): void {
  const normalizedRouteId = toInteger(routeId);
  if (normalizedRouteId == null) return;
  const snapshots = readSnapshots();
  snapshots[String(normalizedRouteId)] = sanitizeSnapshotForStorage(snapshot);
  persistSnapshots(snapshots);
}

export function removeRouteProbeSnapshot(routeId: number): void {
  const normalizedRouteId = toInteger(routeId);
  if (normalizedRouteId == null) return;
  const snapshots = readSnapshots();
  const routeKey = String(normalizedRouteId);
  if (!(routeKey in snapshots)) return;
  delete snapshots[routeKey];
  persistSnapshots(snapshots);
}

export function clearAllRouteProbeSnapshots(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore unavailable storage
  }
}

export function buildChannelFingerprint(channels: RouteChannel[]): number[] {
  return channels
    .filter((channel) => channel.enabled)
    .map((channel) => channel.id)
    .sort((a, b) => a - b);
}

export function isSnapshotStale(
  snapshot: RouteProbeSnapshot,
  currentChannels: RouteChannel[],
): boolean {
  const storedFingerprint = [...snapshot.channelFingerprint]
    .map((channelId) => Math.trunc(channelId))
    .sort((a, b) => a - b);
  const currentFingerprint = buildChannelFingerprint(currentChannels);
  return JSON.stringify(storedFingerprint) !== JSON.stringify(currentFingerprint);
}

export type NormalizedModelMapping = Record<string, string>;

export function parseNormalizedModelMapping(
  raw: string | Record<string, unknown> | null | undefined,
): NormalizedModelMapping | null {
  if (!raw) return null;

  const parsed = typeof raw === 'string'
    ? (() => {
      try { return JSON.parse(raw) as unknown; } catch { return null; }
    })()
    : raw;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const normalized: NormalizedModelMapping = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const normalizedKey = key.trim();
    const normalizedValue = typeof value === 'string' ? value.trim() : '';
    if (!normalizedKey || !normalizedValue) continue;
    normalized[normalizedKey] = normalizedValue;
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

export function normalizeModelMappingInput(
  input: unknown,
): { valid: boolean; modelMapping: NormalizedModelMapping | null } {
  if (input === null || input === undefined) {
    return { valid: true, modelMapping: null };
  }

  if (typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, modelMapping: null };
  }

  return {
    valid: true,
    modelMapping: parseNormalizedModelMapping(input as Record<string, unknown>),
  };
}

export function buildReverseExactModelMapping(
  mapping: string | Record<string, unknown> | NormalizedModelMapping | null | undefined,
): Map<string, string> {
  const reverse = new Map<string, string>();
  const normalized = parseNormalizedModelMapping(mapping);
  if (!normalized) return reverse;

  for (const [requestName, upstreamName] of Object.entries(normalized)) {
    if (requestName.includes('*') || requestName.startsWith('re:') || requestName.startsWith('^')) continue;
    reverse.set(upstreamName.toLowerCase(), requestName);
  }

  return reverse;
}

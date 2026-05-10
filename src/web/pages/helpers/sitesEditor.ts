export type SiteCustomHeaderField = {
  key: string;
  value: string;
};

export type SiteForm = {
  name: string;
  url: string;
  externalCheckinUrl: string;
  platform: string;
  proxyUrl: string;
  useSystemProxy: boolean;
  customHeaders: SiteCustomHeaderField[];
  endpointOverrides: string[];
  globalWeight: string;
  probeDisabled: boolean;
};

export type SiteEditorState =
  | { mode: 'add' }
  | { mode: 'edit'; editingSiteId: number };

export type SiteSavePayload = {
  name: string;
  url: string;
  externalCheckinUrl: string;
  platform: string;
  proxyUrl: string;
  useSystemProxy: boolean;
  customHeaders: string;
  endpointOverrides: string[] | null;
  globalWeight: number;
  postRefreshProbeEnabled?: boolean;
  postRefreshProbeModel?: string;
  postRefreshProbeScope?: 'single' | 'all';
  postRefreshProbeLatencyThresholdMs?: number;
  probeDisabled: boolean;
};

type SiteSaveAction =
  | { kind: 'add'; payload: SiteSavePayload }
  | { kind: 'update'; id: number; payload: SiteSavePayload };

export function emptySiteCustomHeader(): SiteCustomHeaderField {
  return { key: '', value: '' };
}

function ensureSiteCustomHeaderRows(rows: SiteCustomHeaderField[]): SiteCustomHeaderField[] {
  return rows.length > 0 ? rows : [emptySiteCustomHeader()];
}

export function emptySiteForm(): SiteForm {
  return {
    name: '',
    url: '',
    externalCheckinUrl: '',
    platform: '',
    proxyUrl: '',
    useSystemProxy: false,
    customHeaders: [emptySiteCustomHeader()],
    endpointOverrides: [],
    globalWeight: '1',
    probeDisabled: false,
  };
}

function parseCustomHeadersForEditor(raw: unknown): SiteCustomHeaderField[] {
  if (typeof raw !== 'string') {
    return ensureSiteCustomHeaderRows([]);
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return ensureSiteCustomHeaderRows([]);
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return ensureSiteCustomHeaderRows([]);
    }
    return ensureSiteCustomHeaderRows(
      Object.entries(parsed as Record<string, unknown>).map(([key, value]) => ({
        key,
        value: typeof value === 'string' ? value : String(value ?? ''),
      })),
    );
  } catch {
    return ensureSiteCustomHeaderRows([]);
  }
}

function parseEndpointOverridesForEditor(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return Array.from(new Set(raw
      .map((item) => (typeof item === 'string' ? item.trim().toLowerCase() : ''))
      .filter(Boolean)));
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) return [];
      return Array.from(new Set(parsed
        .map((item) => (typeof item === 'string' ? item.trim().toLowerCase() : ''))
        .filter(Boolean)));
    } catch {
      return [];
    }
  }
  return [];
}

export function siteFormFromSite(site: Partial<Omit<SiteForm, 'customHeaders' | 'endpointOverrides' | 'globalWeight' | 'externalCheckinUrl' | 'proxyUrl' | 'useSystemProxy'>> & {
  externalCheckinUrl?: string | null;
  proxyUrl?: string | null;
  useSystemProxy?: boolean | null;
  customHeaders?: string | null;
  endpointOverrides?: string[] | string | null;
  globalWeight?: number | string | null;
  probeDisabled?: boolean | null;
}): SiteForm {
  const globalWeightRaw = Number(site.globalWeight);
  const globalWeight = Number.isFinite(globalWeightRaw) && globalWeightRaw > 0 ? String(globalWeightRaw) : '1';
  return {
    name: site.name ?? '',
    url: site.url ?? '',
    externalCheckinUrl: site.externalCheckinUrl ?? '',
    platform: site.platform ?? '',
    proxyUrl: site.proxyUrl ?? '',
    useSystemProxy: !!site.useSystemProxy,
    customHeaders: parseCustomHeadersForEditor(site.customHeaders),
    endpointOverrides: parseEndpointOverridesForEditor(site.endpointOverrides),
    globalWeight,
    probeDisabled: !!site.probeDisabled,
  };
}

export function serializeSiteCustomHeaders(fields: SiteCustomHeaderField[]): {
  valid: boolean;
  customHeaders: string;
  error?: string;
} {
  const headers: Record<string, string> = {};
  const seen = new Set<string>();

  for (const field of fields) {
    const key = field.key.trim();
    const value = field.value;
    const hasAnyInput = key.length > 0 || value.trim().length > 0;
    if (!hasAnyInput) continue;
    if (!key) {
      return { valid: false, customHeaders: '', error: '请求头名称不能为空' };
    }
    const normalizedKey = key.toLowerCase();
    if (seen.has(normalizedKey)) {
      return { valid: false, customHeaders: '', error: `请求头 "${key}" 重复了` };
    }
    seen.add(normalizedKey);
    headers[key] = value;
  }

  return {
    valid: true,
    customHeaders: Object.keys(headers).length > 0 ? JSON.stringify(headers) : '',
  };
}

export function serializeSiteEndpointOverrides(values: string[]): {
  valid: boolean;
  endpointOverrides: string[] | null;
  error?: string;
} {
  const normalized = Array.from(new Set(values
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)));
  if (normalized.length === 0) {
    return {
      valid: true,
      endpointOverrides: null,
    };
  }
  const allowed = new Set(['chat', 'messages', 'responses']);
  const invalid = normalized.filter((value) => !allowed.has(value));
  if (invalid.length > 0) {
    return {
      valid: false,
      endpointOverrides: null,
      error: 'Endpoint override 仅支持 chat / messages / responses',
    };
  }
  return {
    valid: true,
    endpointOverrides: normalized,
  };
}

export function buildSiteSaveAction(editor: SiteEditorState, form: SiteSavePayload): SiteSaveAction {
  if (editor.mode === 'edit') {
    if (!Number.isFinite(editor.editingSiteId)) {
      throw new Error('editingSiteId is required in edit mode');
    }
    return { kind: 'update', id: editor.editingSiteId, payload: form };
  }
  return { kind: 'add', payload: form };
}

export function parseBulkCustomHeaders(text: string): {
  valid: boolean;
  headers: SiteCustomHeaderField[];
  error?: string;
} {
  const trimmed = text.trim();
  if (!trimmed) {
    return { valid: false, headers: [], error: '内容不能为空' };
  }

  // Try JSON object first: {"key": "value", ...}
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { valid: false, headers: [], error: 'JSON 格式无效，需要对象格式 {"key": "value"}' };
      }
      const headers: SiteCustomHeaderField[] = Object.entries(parsed as Record<string, unknown>).map(([key, value]) => ({
        key: key.trim(),
        value: typeof value === 'string' ? value : String(value ?? ''),
      }));
      if (headers.length === 0) {
        return { valid: false, headers: [], error: 'JSON 对象为空' };
      }
      return { valid: true, headers };
    } catch {
      return { valid: false, headers: [], error: 'JSON 解析失败，请检查格式' };
    }
  }

  // Line-based: "Key: Value" or "Key=Value" per line
  // Also strips curl -H '...' / -H "..." wrappers
  const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
  const headers: SiteCustomHeaderField[] = [];
  for (const rawLine of lines) {
    let line = rawLine;
    // Strip curl -H prefix: -H 'Header: Value' or -H "Header: Value"
    const curlMatch = line.match(/^-H\s+['"](.+?)['"]$/);
    if (curlMatch) {
      line = curlMatch[1];
    }
    // Try "Key: Value" (colon separator, standard HTTP header format)
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      headers.push({
        key: line.slice(0, colonIndex).trim(),
        value: line.slice(colonIndex + 1).trim(),
      });
      continue;
    }
    // Try "Key=Value"
    const eqIndex = line.indexOf('=');
    if (eqIndex > 0) {
      headers.push({
        key: line.slice(0, eqIndex).trim(),
        value: line.slice(eqIndex + 1).trim(),
      });
      continue;
    }
    return { valid: false, headers: [], error: `无法解析: "${line.slice(0, 60)}"。支持格式: Key: Value 或 Key=Value 或 JSON 对象` };
  }

  if (headers.length === 0) {
    return { valid: false, headers: [], error: '未解析出任何请求头' };
  }
  return { valid: true, headers };
}

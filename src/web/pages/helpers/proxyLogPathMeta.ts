type ProxyLogPathMeta = {
  downstreamPath: string | null;
  upstreamPath: string | null;
  errorMessage: string;
};

export function parseProxyLogPathMeta(message?: string): ProxyLogPathMeta {
  const raw = typeof message === 'string' ? message.trim() : '';
  const downstreamMatch = raw.match(/\[downstream:([^\]]+)\]/i);
  const upstreamMatch = raw.match(/\[upstream:([^\]]+)\]/i);
  const stripped = raw.replace(/^\s*(?:\[(?:downstream|upstream):[^\]]+\]\s*)+/i, '').trim();

  return {
    downstreamPath: downstreamMatch?.[1]?.trim() || null,
    upstreamPath: upstreamMatch?.[1]?.trim() || null,
    errorMessage: stripped,
  };
}

import type { ProxyLogStatusFilter } from '../../api.js';

function padDateTimeSegment(value: number): string {
  return String(value).padStart(2, '0');
}

function formatDateTimeRouteValue(value: Date): string {
  return `${value.getFullYear()}-${padDateTimeSegment(value.getMonth() + 1)}-${padDateTimeSegment(value.getDate())}T${padDateTimeSegment(value.getHours())}:${padDateTimeSegment(value.getMinutes())}`;
}

type ProxyLogsRouteRange = {
  from: Date;
  to?: Date;
};

type BuildSiteLogsRouteOptions = {
  range?: ProxyLogsRouteRange;
  status?: ProxyLogStatusFilter;
};

export function buildSiteLogsRoute(siteId: number, options?: BuildSiteLogsRouteOptions): string {
  const params = new URLSearchParams();
  params.set('siteId', String(siteId));
  if (options?.status && options.status !== 'all') {
    params.set('status', options.status);
  }
  if (options?.range) {
    params.set('from', formatDateTimeRouteValue(options.range.from));
    if (options.range.to) {
      params.set('to', formatDateTimeRouteValue(options.range.to));
    }
  }
  return `/logs?${params.toString()}`;
}

export function buildSiteLast24hLogsRoute(
  siteId: number,
  options: { now?: Date; status?: ProxyLogStatusFilter } = {},
): string {
  const now = options.now || new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() - 23, 0, 0, 0);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0, 0);
  return buildSiteLogsRoute(siteId, {
    status: options.status,
    range: { from, to },
  });
}

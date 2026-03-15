import { fetch } from 'undici';
import { withSiteProxyRequestInit } from '../../services/siteProxy.js';
import { summarizeUpstreamError } from './upstreamError.js';
import type { UpstreamEndpoint } from './upstreamEndpoint.js';

function normalizeUpstreamTargetUrl(siteUrl: string, requestPath: string): string {
  const baseRaw = typeof siteUrl === 'string' ? siteUrl.trim() : '';
  const pathRaw = typeof requestPath === 'string' ? requestPath.trim() : '';
  const base = baseRaw.replace(/\/+$/, '');
  let path = pathRaw.startsWith('/') ? pathRaw : `/${pathRaw}`;

  try {
    const parsed = new URL(base);
    const basePath = parsed.pathname.replace(/\/+$/, '');
    const baseHasVersionSuffix = /\/(?:api\/)?v1$/i.test(basePath);
    if (baseHasVersionSuffix && path.startsWith('/v1/')) {
      path = path.slice('/v1'.length) || '/';
    }
  } catch {
    // Ignore URL parsing errors and fall back to naive join.
  }

  if (!base) return path || '/';
  if (!path || path === '/') return base;
  return `${base}${path}`;
}

export type BuiltEndpointRequest = {
  endpoint: UpstreamEndpoint;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

export type EndpointAttemptContext = {
  endpointIndex: number;
  endpointCount: number;
  request: BuiltEndpointRequest;
  targetUrl: string;
  response: Awaited<ReturnType<typeof fetch>>;
  rawErrText: string;
};

export type EndpointRecoverResult = {
  upstream: Awaited<ReturnType<typeof fetch>>;
  upstreamPath: string;
} | null;

export type EndpointFlowResult =
  | {
    ok: true;
    upstream: Awaited<ReturnType<typeof fetch>>;
    upstreamPath: string;
  }
  | {
    ok: false;
    status: number;
    errText: string;
  };

export function withUpstreamPath(path: string, message: string): string {
  return `[upstream:${path}] ${message}`;
}

type ExecuteEndpointFlowInput = {
  siteUrl: string;
  proxyUrl?: string | null;
  endpointCandidates: UpstreamEndpoint[];
  buildRequest: (endpoint: UpstreamEndpoint, endpointIndex: number) => BuiltEndpointRequest;
  tryRecover?: (ctx: EndpointAttemptContext) => Promise<EndpointRecoverResult>;
  shouldDowngrade?: (ctx: EndpointAttemptContext) => boolean;
  onDowngrade?: (ctx: EndpointAttemptContext & { errText: string }) => void | Promise<void>;
};

export async function executeEndpointFlow(input: ExecuteEndpointFlowInput): Promise<EndpointFlowResult> {
  const endpointCount = input.endpointCandidates.length;
  if (endpointCount <= 0) {
    return {
      ok: false,
      status: 502,
      errText: 'Upstream request failed',
    };
  }

  let finalStatus = 0;
  let finalErrText = 'unknown error';

  for (let endpointIndex = 0; endpointIndex < endpointCount; endpointIndex += 1) {
    const endpoint = input.endpointCandidates[endpointIndex] as UpstreamEndpoint;
    const request = input.buildRequest(endpoint, endpointIndex);
    const targetUrl = normalizeUpstreamTargetUrl(input.siteUrl, request.path);

    let response = await fetch(targetUrl, await withSiteProxyRequestInit(targetUrl, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
    }));

    if (response.ok) {
      return {
        ok: true,
        upstream: response,
        upstreamPath: request.path,
      };
    }

    let rawErrText = await response.text().catch(() => 'unknown error');
    const baseContext: EndpointAttemptContext = {
      endpointIndex,
      endpointCount,
      request,
      targetUrl,
      response,
      rawErrText,
    };

    if (input.tryRecover) {
      const recovered = await input.tryRecover(baseContext);
      if (recovered?.upstream?.ok) {
        return {
          ok: true,
          upstream: recovered.upstream,
          upstreamPath: recovered.upstreamPath,
        };
      }
    }

    // Normalize again in case recoverer performed additional probes and updated the response text.
    rawErrText = baseContext.rawErrText;
    response = baseContext.response;
    const errText = withUpstreamPath(
      baseContext.request.path,
      summarizeUpstreamError(response.status, rawErrText),
    );

    const isLastEndpoint = endpointIndex >= endpointCount - 1;
    const shouldDowngrade = !isLastEndpoint && !!input.shouldDowngrade?.(baseContext);
    if (shouldDowngrade) {
      await input.onDowngrade?.({
        ...baseContext,
        errText,
      });
      continue;
    }

    finalStatus = response.status;
    finalErrText = errText;
    break;
  }

  return {
    ok: false,
    status: finalStatus || 502,
    errText: finalErrText || 'unknown error',
  };
}

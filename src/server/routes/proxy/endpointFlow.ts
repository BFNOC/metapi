import { fetch } from 'undici';
import { readRuntimeResponseText } from '../../proxy-core/executors/types.js';
import {
  fetchWithObservedFirstByte,
  isObservedFirstByteTimeoutResponse,
} from '../../proxy-core/firstByteTimeout.js';
import { withSiteProxyRequestInit } from '../../services/siteProxy.js';
import { summarizeUpstreamError } from './upstreamError.js';
import type { UpstreamEndpoint } from './upstreamEndpoint.js';
import { buildUpstreamUrl } from './upstreamUrl.js';

export type BuiltEndpointRequest = {
  endpoint: UpstreamEndpoint;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  runtime?: {
    executor: 'default' | 'codex' | 'gemini-cli' | 'antigravity' | 'claude';
    modelName?: string;
    stream?: boolean;
    oauthProjectId?: string | null;
    action?: 'generateContent' | 'streamGenerateContent' | 'countTokens';
  };
};

export type EndpointAttemptContext = {
  endpointIndex: number;
  endpointCount: number;
  request: BuiltEndpointRequest;
  targetUrl: string;
  response: Awaited<ReturnType<typeof fetch>>;
  rawErrText: string;
};

export type EndpointAttemptSuccessContext = {
  endpointIndex: number;
  endpointCount: number;
  request: BuiltEndpointRequest;
  targetUrl: string;
  response: Awaited<ReturnType<typeof fetch>>;
};

export type EndpointRecoverResult = {
  upstream: Awaited<ReturnType<typeof fetch>>;
  upstreamPath: string;
  request?: BuiltEndpointRequest;
  targetUrl?: string;
} | null;

export type EndpointFlowAttempt = {
  endpoint: UpstreamEndpoint;
  path: string;
  targetUrl: string;
  status: number;
  rawErrText?: string;
  errText?: string;
  downgraded: boolean;
};

export type EndpointFlowResult =
  | {
    ok: true;
    upstream: Awaited<ReturnType<typeof fetch>>;
    upstreamPath: string;
    successfulEndpoint: UpstreamEndpoint;
    attempts: EndpointFlowAttempt[];
    downgraded: boolean;
  }
  | {
    ok: false;
    status: number;
    errText: string;
    rawErrText?: string;
    terminalEndpoint: UpstreamEndpoint | null;
    attempts: EndpointFlowAttempt[];
    downgraded: boolean;
  };

export function withUpstreamPath(path: string, message: string): string {
  return `[upstream:${path}] ${message}`;
}

type ExecuteEndpointFlowInput = {
  siteUrl: string;
  proxyUrl?: string | null;
  endpointCandidates: UpstreamEndpoint[];
  buildRequest: (endpoint: UpstreamEndpoint, endpointIndex: number) => BuiltEndpointRequest;
  dispatchRequest?: (
    request: BuiltEndpointRequest,
    targetUrl: string,
    signal?: AbortSignal,
  ) => Promise<Awaited<ReturnType<typeof fetch>>>;
  firstByteTimeoutMs?: number;
  tryRecover?: (ctx: EndpointAttemptContext) => Promise<EndpointRecoverResult>;
  shouldDowngrade?: (ctx: EndpointAttemptContext) => boolean;
  onDowngrade?: (ctx: EndpointAttemptContext & { errText: string }) => void | Promise<void>;
  onAttemptFailure?: (ctx: EndpointAttemptContext & { errText: string }) => void | Promise<void>;
  onAttemptSuccess?: (ctx: EndpointAttemptSuccessContext) => void | Promise<void>;
};

async function runEndpointFlowHook<T>(
  hook: ((ctx: T) => void | Promise<void>) | undefined,
  ctx: T,
  hookName: string,
): Promise<void> {
  if (!hook) return;
  try {
    await hook(ctx);
  } catch (error) {
    console.error(`endpointFlow ${hookName} hook failed`, error);
  }
}
export async function executeEndpointFlow(input: ExecuteEndpointFlowInput): Promise<EndpointFlowResult> {
  const endpointCount = input.endpointCandidates.length;
  if (endpointCount <= 0) {
    return {
      ok: false,
      status: 502,
      errText: 'Upstream request failed',
      terminalEndpoint: null,
      attempts: [],
      downgraded: false,
    };
  }

  let finalStatus = 0;
  let finalErrText = 'unknown error';
  let finalRawErrText: string | undefined;
  let terminalEndpoint: UpstreamEndpoint | null = null;
  const attempts: EndpointFlowAttempt[] = [];

  for (let endpointIndex = 0; endpointIndex < endpointCount; endpointIndex += 1) {
    const endpoint = input.endpointCandidates[endpointIndex] as UpstreamEndpoint;
    const request = input.buildRequest(endpoint, endpointIndex);
    const defaultTarget = buildUpstreamUrl(input.siteUrl, request.path);
    const targetUrl = input.proxyUrl
      ? buildUpstreamUrl(input.proxyUrl, request.path)
      : defaultTarget;

    const attemptStartedAtMs = Date.now();
    let response = await fetchWithObservedFirstByte(
      async (signal) => (
        input.dispatchRequest
          ? await input.dispatchRequest(request, targetUrl, signal)
          : await fetch(targetUrl, await withSiteProxyRequestInit(targetUrl, {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal,
          }))
      ),
      {
        firstByteTimeoutMs: input.firstByteTimeoutMs,
        startedAtMs: attemptStartedAtMs,
      },
    );

    if (response.ok) {
      attempts.push({
        endpoint: request.endpoint,
        path: request.path,
        targetUrl,
        status: response.status,
        downgraded: false,
      });
      await runEndpointFlowHook(input.onAttemptSuccess, {
        endpointIndex,
        endpointCount,
        request,
        targetUrl,
        response,
      }, 'onAttemptSuccess');
      return {
        ok: true,
        upstream: response,
        upstreamPath: request.path,
        successfulEndpoint: request.endpoint,
        attempts,
        downgraded: endpointIndex > 0,
      };
    }

    let rawErrText = await readRuntimeResponseText(response).catch(() => 'unknown error');
    const baseContext: EndpointAttemptContext = {
      endpointIndex,
      endpointCount,
      request,
      targetUrl,
      response,
      rawErrText,
    };
    const isLastEndpoint = endpointIndex >= endpointCount - 1;

    if (isObservedFirstByteTimeoutResponse(response) && !isLastEndpoint) {
      const errText = rawErrText.trim() || 'first byte timeout';
      await runEndpointFlowHook(input.onAttemptFailure, {
        ...baseContext,
        errText,
      }, 'onAttemptFailure');
      attempts.push({
        endpoint: baseContext.request.endpoint,
        path: baseContext.request.path,
        targetUrl: baseContext.targetUrl,
        status: response.status || 408,
        rawErrText,
        errText,
        downgraded: true,
      });
      finalStatus = response.status || 408;
      finalErrText = errText;
      finalRawErrText = rawErrText;
      continue;
    }

    if (input.tryRecover) {
      const recovered = await input.tryRecover(baseContext);
      if (recovered?.upstream?.ok) {
        const recoveredRequest = recovered.request ?? baseContext.request;
        const recoveredTargetUrl = recovered.targetUrl ?? (
          input.proxyUrl
            ? buildUpstreamUrl(input.proxyUrl, recovered.upstreamPath)
            : buildUpstreamUrl(input.siteUrl, recovered.upstreamPath)
        );
        attempts.push({
          endpoint: baseContext.request.endpoint,
          path: baseContext.request.path,
          targetUrl: baseContext.targetUrl,
          status: baseContext.response.status,
          rawErrText: baseContext.rawErrText,
          downgraded: false,
        });
        attempts.push({
          endpoint: recoveredRequest.endpoint,
          path: recovered.upstreamPath,
          targetUrl: recoveredTargetUrl,
          status: recovered.upstream.status,
          downgraded: false,
        });
        await runEndpointFlowHook(input.onAttemptSuccess, {
          endpointIndex,
          endpointCount,
          request: recoveredRequest,
          targetUrl: recoveredTargetUrl,
          response: recovered.upstream,
        }, 'onAttemptSuccess');
        return {
          ok: true,
          upstream: recovered.upstream,
          upstreamPath: recovered.upstreamPath,
          successfulEndpoint: recoveredRequest.endpoint,
          attempts,
          downgraded: endpointIndex > 0,
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
    await runEndpointFlowHook(input.onAttemptFailure, {
      ...baseContext,
      errText,
    }, 'onAttemptFailure');

    const shouldDowngrade = !isLastEndpoint && !!input.shouldDowngrade?.(baseContext);
    attempts.push({
      endpoint: baseContext.request.endpoint,
      path: baseContext.request.path,
      targetUrl: baseContext.targetUrl,
      status: response.status,
      rawErrText,
      errText,
      downgraded: shouldDowngrade,
    });
    if (shouldDowngrade) {
      await runEndpointFlowHook(input.onDowngrade, {
        ...baseContext,
        errText,
      }, 'onDowngrade');
      continue;
    }

    finalStatus = response.status;
    finalErrText = errText;
    finalRawErrText = rawErrText;
    terminalEndpoint = baseContext.request.endpoint;
    break;
  }

  return {
    ok: false,
    status: finalStatus || 502,
    errText: finalErrText || 'unknown error',
    rawErrText: finalRawErrText,
    terminalEndpoint,
    attempts,
    downgraded: attempts.some((attempt) => attempt.downgraded),
  };
}

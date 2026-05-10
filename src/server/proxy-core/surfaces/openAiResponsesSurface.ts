import { TextDecoder } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { reportProxyAllFailed } from '../../services/alertService.js';
import { hasProxyUsagePayload, mergeProxyUsage, parseProxyUsage } from '../../services/proxyUsageParser.js';
import { openAiResponsesTransformer } from '../../transformers/openai/responses/index.js';
import { buildEndpointCompatibilityUnavailableResponse } from '../endpointOverrides.js';
import {
  extractResponsesTerminalResponseId,
  isResponsesPreviousResponseNotFoundError,
  shouldInferResponsesPreviousResponseId,
  stripResponsesPreviousResponseId,
  withResponsesPreviousResponseId,
} from '../../transformers/openai/responses/continuation.js';
import {
  buildUpstreamEndpointRequest,
  recordUpstreamEndpointDowngrade,
  recordUpstreamEndpointFailure,
  recordUpstreamEndpointSuccess,
  resolveUpstreamEndpointCandidates,
} from '../../routes/proxy/upstreamEndpoint.js';
import { ensureModelAllowedForDownstreamKey, getDownstreamRoutingPolicy, recordDownstreamCostUsage } from '../../routes/proxy/downstreamPolicy.js';
import { executeEndpointFlow, type BuiltEndpointRequest } from '../../routes/proxy/endpointFlow.js';
import { detectProxyFailure } from '../../routes/proxy/proxyFailureJudge.js';
import { getProxyAuthContext, getProxyResourceOwner } from '../../middleware/auth.js';
import { normalizeInputFileBlock } from '../../transformers/shared/inputFile.js';
import {
  ProxyInputFileResolutionError,
  resolveResponsesBodyInputFiles,
} from '../../services/proxyInputFileResolver.js';
import {
  buildOauthProviderHeaders,
} from '../../services/oauth/service.js';
import { getOauthInfoFromAccount } from '../../services/oauth/oauthAccount.js';
import {
  collectResponsesFinalPayloadFromSse,
  collectResponsesFinalPayloadFromSseText,
  createSingleChunkStreamReader,
  looksLikeResponsesSseText,
} from '../../routes/proxy/responsesSseFinal.js';
import {
  createGeminiCliStreamReader,
  unwrapGeminiCliPayload,
} from '../../routes/proxy/geminiCliCompat.js';
import { isCodexResponsesSurface } from '../cliProfiles/codexProfile.js';
import {
  getObservedResponseMeta,
  resolveProxyFirstByteTimeoutMs,
} from '../firstByteTimeout.js';
import { getRuntimeResponseReader, readRuntimeResponseText } from '../executors/types.js';
import { runCodexHttpSessionTask } from '../runtime/codexHttpSessionQueue.js';
import {
  buildCodexSessionResponseStoreKey,
  clearCodexSessionResponseId,
  getCodexSessionResponseId,
  setCodexSessionResponseId,
} from '../runtime/codexSessionResponseStore.js';
import {
  summarizeConversationFileInputsInOpenAiBody,
  summarizeConversationFileInputsInResponsesBody,
} from '../capabilities/conversationFileCapabilities.js';
import {
  sanitizeCompactResponsesRequestBody,
  shouldFallbackCompactResponsesToResponses,
} from '../capabilities/responsesCompact.js';
import { detectDownstreamClientContext } from '../../routes/proxy/downstreamClientContext.js';
import { validateExternalResponsesHttpRequest } from '../responsesPreflight.js';
import { applyOpenAiServiceTierPolicy } from '../serviceTierPolicy.js';
import { maybeHandleWebSearchOnlySimulation } from '../webSearchSimulation.js';
import { getProxyMaxChannelRetries } from '../../services/proxyChannelRetry.js';
import {
  acquireSurfaceChannelLease,
  bindSurfaceStickyChannel,
  buildSurfaceChannelBusyMessage,
  buildSurfaceStickySessionKey,
  clearSurfaceStickyChannel,
  createSurfaceFailureToolkit,
  createSurfaceDispatchRequest,
  recordSurfaceSuccess,
  selectSurfaceChannelForAttempt,
  trySurfaceOauthRefreshRecovery,
} from './sharedSurface.js';
import type { UpstreamEndpoint } from '../upstreamEndpointTypes.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function getCodexSessionHeaderValue(headers: Record<string, string>): string {
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const normalizedKey = rawKey.trim().toLowerCase();
    if (normalizedKey === 'session_id' || normalizedKey === 'session-id') {
      return String(rawValue || '').trim();
    }
  }
  return '';
}
function isResponsesWebsocketTransportRequest(headers: Record<string, unknown>): boolean {
  return Object.entries(headers)
    .some(([rawKey, rawValue]) => rawKey.trim().toLowerCase() === 'x-metapi-responses-websocket-transport'
      && String(rawValue).trim() === '1');
}

function rememberCodexSessionResponseId(sessionId: string, payload: unknown): void {
  const responseId = extractResponsesTerminalResponseId(payload);
  if (!responseId) return;
  setCodexSessionResponseId(sessionId, responseId);
}

function normalizeIncludeList(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}

function hasExplicitInclude(body: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(body, 'include');
}

function hasResponsesReasoningRequest(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const relevantKeys = ['effort', 'budget_tokens', 'budgetTokens', 'max_tokens', 'maxTokens', 'summary'];
  return relevantKeys.some((key) => {
    const entry = value[key];
    if (typeof entry === 'string') return entry.trim().length > 0;
    return entry !== undefined && entry !== null;
  });
}

function carriesResponsesReasoningContinuity(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => carriesResponsesReasoningContinuity(item));
  }
  if (!isRecord(value)) return false;

  const type = typeof value.type === 'string' ? value.type.trim().toLowerCase() : '';
  if (type === 'reasoning') {
    if (typeof value.encrypted_content === 'string' && value.encrypted_content.trim()) {
      return true;
    }
    if (Array.isArray(value.summary) && value.summary.length > 0) {
      return true;
    }
  }

  if (typeof value.reasoning_signature === 'string' && value.reasoning_signature.trim()) {
    return true;
  }

  return carriesResponsesReasoningContinuity(value.input)
    || carriesResponsesReasoningContinuity(value.content);
}

function wantsNativeResponsesReasoning(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const include = normalizeIncludeList(body.include);
  if (include.some((item) => item.toLowerCase() === 'reasoning.encrypted_content')) {
    return true;
  }
  if (carriesResponsesReasoningContinuity(body.input)) {
    return true;
  }
  if (hasExplicitInclude(body)) {
    return false;
  }
  return hasResponsesReasoningRequest(body.reasoning);
}

function carriesResponsesFileUrlInput(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => carriesResponsesFileUrlInput(item));
  }
  if (!isRecord(value)) return false;

  const normalizedFile = normalizeInputFileBlock(value);
  if (normalizedFile?.fileUrl) return true;

  return Object.values(value).some((entry) => carriesResponsesFileUrlInput(entry));
}

function recordSuccessfulEndpointDowngrades(input: {
  attempts: Array<{
    endpoint: 'chat' | 'messages' | 'responses';
    status: number;
  }>;
  successfulEndpoint: 'chat' | 'messages' | 'responses';
  siteId: number;
  modelName: string;
  requestedModelHint?: string;
  requestCapabilities?: {
    hasNonImageFileInput?: boolean;
    conversationFileSummary?: ReturnType<typeof summarizeConversationFileInputsInResponsesBody>;
    wantsNativeResponsesReasoning?: boolean;
  };
}) {
  const seenFailedEndpoints = new Set<'chat' | 'messages' | 'responses'>();
  for (const attempt of input.attempts) {
    if (attempt.endpoint === input.successfulEndpoint) continue;
    if (attempt.status < 400) continue;
    if (seenFailedEndpoints.has(attempt.endpoint)) continue;
    seenFailedEndpoints.add(attempt.endpoint);
    recordUpstreamEndpointDowngrade({
      siteId: input.siteId,
      failedEndpoint: attempt.endpoint,
      recoveredEndpoint: input.successfulEndpoint,
      downstreamFormat: 'responses',
      modelName: input.modelName,
      requestedModelHint: input.requestedModelHint,
      requestCapabilities: input.requestCapabilities,
    });
  }
}

function shouldRefreshOauthResponsesRequest(input: {
  oauthProvider?: string;
  status: number;
  response: { headers: { get(name: string): string | null } };
  rawErrText: string;
}): boolean {
  if (input.status === 401) return true;
  if (input.status !== 403 || input.oauthProvider !== 'codex') return false;
  const authenticate = input.response.headers.get('www-authenticate') || '';
  const combined = `${authenticate}\n${input.rawErrText || ''}`;
  return /\b(invalid_token|expired_token|expired|invalid|unauthorized|account mismatch|authentication)\b/i.test(combined);
}

type UsageSummary = ReturnType<typeof parseProxyUsage>;

export async function handleOpenAiResponsesSurfaceRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  downstreamPath: '/v1/responses' | '/v1/responses/compact',
) {
    const body = request.body as Record<string, unknown>;
    const clientContext = detectDownstreamClientContext({
      downstreamPath,
      headers: request.headers as Record<string, unknown>,
      body,
    });
    const defaultEncryptedReasoningInclude = isCodexResponsesSurface(
      request.headers as Record<string, unknown>,
    );
    if (!isResponsesWebsocketTransportRequest(request.headers as Record<string, unknown>)) {
      const preflight = validateExternalResponsesHttpRequest(body, {
        allowContinuationToolOutput: defaultEncryptedReasoningInclude,
      });
      if (!preflight.ok) {
        return reply.code(preflight.statusCode).send(preflight.payload);
      }
    }
    const parsedRequestEnvelope = openAiResponsesTransformer.transformRequest(body, {
      defaultEncryptedReasoningInclude,
    });
    if (parsedRequestEnvelope.error) {
      return reply.code(parsedRequestEnvelope.error.statusCode).send(parsedRequestEnvelope.error.payload);
    }
    const requestEnvelope = parsedRequestEnvelope.value!;
    const requestedModel = requestEnvelope.model;
    const isStream = requestEnvelope.stream;
    const isCompactRequest = downstreamPath === '/v1/responses/compact';
    if (isCompactRequest && isStream) {
      return reply.code(400).send({
        error: {
          message: 'stream is not supported on /v1/responses/compact',
          type: 'invalid_request_error',
        },
      });
    }
    if (!isCompactRequest) {
      const handledSearch = await maybeHandleWebSearchOnlySimulation({
        app: request.server,
        request,
        reply,
        downstreamFormat: 'responses',
        body: requestEnvelope.parsed.normalizedBody,
      });
      if (handledSearch) return;
    }
    if (!await ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;
    const downstreamPolicy = getDownstreamRoutingPolicy(request);
    const downstreamApiKeyId = getProxyAuthContext(request)?.keyId ?? null;
    const maxRetries = getProxyMaxChannelRetries();
	    const failureToolkit = createSurfaceFailureToolkit({
	      warningScope: 'responses',
	      downstreamPath,
	      maxRetries,
	      clientContext,
	      downstreamApiKeyId,
	    });
	    const stickySessionKey = buildSurfaceStickySessionKey({
	      clientContext,
	      requestedModel,
	      downstreamPath,
	      downstreamApiKeyId,
	    });
	    const excludeChannelIds: number[] = [];
	    let retryCount = 0;
    let lastCompatibilityUnavailable: ReturnType<typeof buildEndpointCompatibilityUnavailableResponse> | null = null;

    while (retryCount <= maxRetries) {
	      const selected = await selectSurfaceChannelForAttempt({
	        requestedModel,
	        downstreamPolicy,
	        excludeChannelIds,
	        retryCount,
	        stickySessionKey,
	      });

      if (!selected) {
        if (lastCompatibilityUnavailable) {
          return reply.code(lastCompatibilityUnavailable.statusCode).send(lastCompatibilityUnavailable.payload);
        }
        await reportProxyAllFailed({
          model: requestedModel,
          reason: 'No available channels after retries',
        });
        return reply.code(503).send({
          error: { message: 'No available channels for this model', type: 'server_error' },
        });
      }

      excludeChannelIds.push(selected.channel.id);

      const modelName = selected.actualModel || requestedModel;
      const oauth = getOauthInfoFromAccount(selected.account);
      const isCodexSite = String(selected.site.platform || '').trim().toLowerCase() === 'codex';
      const codexSessionId = isCodexSite
        ? getCodexSessionHeaderValue(request.headers as Record<string, string>)
        : '';
      const codexSessionStoreKey = (
        isCodexSite
        && codexSessionId
      )
        ? buildCodexSessionResponseStoreKey({
          sessionId: codexSessionId,
          siteId: selected.site.id,
          accountId: selected.account.id,
          channelId: selected.channel.id,
        })
        : '';
      const owner = getProxyResourceOwner(request);
      let normalizedResponsesBody: Record<string, unknown> = {
        ...requestEnvelope.parsed.normalizedBody,
        model: modelName,
        stream: isStream,
      };
      if (body.generate === false) {
        normalizedResponsesBody.generate = false;
      }
      if (owner) {
        try {
          normalizedResponsesBody = await resolveResponsesBodyInputFiles(normalizedResponsesBody, owner);
        } catch (error) {
          if (error instanceof ProxyInputFileResolutionError) {
            return reply.code(error.statusCode).send(error.payload);
          }
          throw error;
        }
      }
      const openAiBody = openAiResponsesTransformer.inbound.toOpenAiBody(
        normalizedResponsesBody,
        modelName,
        isStream,
        { defaultEncryptedReasoningInclude },
      );
      const conversationFileSummary = summarizeConversationFileInputsInOpenAiBody(openAiBody);
      const hasNonImageFileInput = conversationFileSummary.hasDocument;
      const prefersNativeResponsesReasoning = wantsNativeResponsesReasoning(normalizedResponsesBody);
      const responsesConversationFileSummary = summarizeConversationFileInputsInResponsesBody(normalizedResponsesBody);
      const requiresNativeResponsesFileUrl = responsesConversationFileSummary.hasRemoteDocumentUrl
        || carriesResponsesFileUrlInput(normalizedResponsesBody.input);
      const endpointCandidates = await resolveUpstreamEndpointCandidates(
        {
          site: selected.site,
          account: selected.account,
          token: selected.token,
        },
        modelName,
        'responses',
        requestedModel,
        {
          hasNonImageFileInput,
          conversationFileSummary,
          wantsNativeResponsesReasoning: prefersNativeResponsesReasoning,
        },
        isCompactRequest ? ['responses'] : undefined,
      );
      if (endpointCandidates.length === 0) {
        lastCompatibilityUnavailable = buildEndpointCompatibilityUnavailableResponse(
          isCompactRequest
            ? 'Responses compact compatibility is not implemented for this upstream'
            : 'Responses compatibility is not implemented for this upstream',
        );
        if (retryCount < maxRetries) {
          retryCount += 1;
          continue;
        }
        return reply.code(lastCompatibilityUnavailable.statusCode).send(lastCompatibilityUnavailable.payload);
      }
      const endpointRuntimeContext = {
        siteId: selected.site.id,
        modelName,
        downstreamFormat: 'responses' as const,
        requestedModelHint: requestedModel,
        requestCapabilities: {
          hasNonImageFileInput,
          conversationFileSummary,
          wantsNativeResponsesReasoning: prefersNativeResponsesReasoning,
        },
      };
      const buildProviderHeaders = () => (
        buildOauthProviderHeaders({
          account: selected.account,
          downstreamHeaders: request.headers as Record<string, unknown>,
        })
      );
      const forceCodexUpstreamStream = isCodexSite && !isCompactRequest;
      const buildEndpointRequest = (endpoint: 'chat' | 'messages' | 'responses') => {
        const upstreamStream = isStream || (forceCodexUpstreamStream && endpoint === 'responses');
        const responsesOriginalBody = (
          endpoint === 'responses'
          && isCodexSite
          && codexSessionStoreKey
          && shouldInferResponsesPreviousResponseId(
            normalizedResponsesBody,
            getCodexSessionResponseId(codexSessionStoreKey),
          )
        )
          ? withResponsesPreviousResponseId(
            normalizedResponsesBody,
            getCodexSessionResponseId(codexSessionStoreKey)!,
          )
          : normalizedResponsesBody;
        const endpointRequest = buildUpstreamEndpointRequest({
          endpoint,
          modelName,
          stream: upstreamStream,
          tokenValue: selected.tokenValue,
          oauthProvider: oauth?.provider,
          oauthProjectId: oauth?.projectId,
          sitePlatform: selected.site.platform,
          siteUrl: selected.site.url,
          openaiBody: openAiBody,
          downstreamFormat: 'responses',
          responsesOriginalBody,
          downstreamHeaders: request.headers as Record<string, unknown>,
          providerHeaders: buildProviderHeaders(),
        });
        const upstreamPath = (
          isCompactRequest && endpoint === 'responses'
            ? `${endpointRequest.path}/compact`
            : endpointRequest.path
        );
        const requestBody = (
          isCompactRequest && endpoint === 'responses'
            ? sanitizeCompactResponsesRequestBody(endpointRequest.body as Record<string, unknown>)
            : endpointRequest.body as Record<string, unknown>
        );
        return {
          endpoint,
          path: upstreamPath,
          headers: endpointRequest.headers,
          body: requestBody,
          runtime: endpointRequest.runtime,
        };
      };
      const baseDispatchRequest = createSurfaceDispatchRequest({
        site: selected.site,
        accountExtraConfig: selected.account.extraConfig,
      });
      const firstByteTimeoutMs = resolveProxyFirstByteTimeoutMs(config.proxyFirstByteTimeoutSec);
      const dispatchRequest = (
        endpointRequest: BuiltEndpointRequest,
        targetUrl?: string,
        signal?: AbortSignal,
      ) => {
        if (!isCodexSite || endpointRequest.path !== '/responses') {
          return baseDispatchRequest(endpointRequest, targetUrl, signal);
        }
        const sessionId = getCodexSessionHeaderValue(endpointRequest.headers);
        return runCodexHttpSessionTask(
          codexSessionStoreKey || sessionId,
          () => baseDispatchRequest(endpointRequest, targetUrl, signal),
        );
      };
      const endpointStrategy = openAiResponsesTransformer.compatibility.createEndpointStrategy({
        isStream: isStream || forceCodexUpstreamStream,
        requiresNativeResponsesFileUrl,
        dispatchRequest,
      });
      const tryRecover = async (ctx: Parameters<NonNullable<typeof endpointStrategy.tryRecover>>[0]) => {
        if (oauth && shouldRefreshOauthResponsesRequest({
          oauthProvider: oauth.provider,
          status: ctx.response.status,
          response: ctx.response,
          rawErrText: ctx.rawErrText || '',
        })) {
          const recovered = await trySurfaceOauthRefreshRecovery({
            ctx,
            selected,
            siteUrl: selected.site.url,
            buildRequest: (endpoint) => buildEndpointRequest(endpoint),
            dispatchRequest,
          });
          if (recovered?.upstream?.ok) {
            return recovered;
          }
        }
        if (
          ctx.request.endpoint === 'responses'
          && isResponsesPreviousResponseNotFoundError({
            rawErrText: ctx.rawErrText,
          })
        ) {
          if (codexSessionStoreKey) {
            clearCodexSessionResponseId(codexSessionStoreKey);
          }
          const previousResponseRecovery = stripResponsesPreviousResponseId(ctx.request.body);
          if (previousResponseRecovery.removed) {
            const recoveredRequest = {
              ...ctx.request,
              body: previousResponseRecovery.body,
            };
            const recoveredResponse = await dispatchRequest(recoveredRequest, ctx.targetUrl);
            if (recoveredResponse.ok) {
              return {
                upstream: recoveredResponse,
                upstreamPath: recoveredRequest.path,
                request: recoveredRequest,
                targetUrl: ctx.targetUrl,
              };
            }
            ctx.request = recoveredRequest;
            ctx.response = recoveredResponse;
            ctx.rawErrText = await readRuntimeResponseText(recoveredResponse).catch(() => 'unknown error');
          }
        }
        if (
          isCompactRequest
          && config.responsesCompactFallbackToResponsesEnabled
          && ctx.request.endpoint === 'responses'
          && ctx.request.path.endsWith('/responses/compact')
          && shouldFallbackCompactResponsesToResponses({
            status: ctx.response.status,
            rawErrText: ctx.rawErrText,
          })
        ) {
          const recoveredRequest = {
            ...ctx.request,
            path: ctx.request.path.replace(/\/compact$/, ''),
          };
          const recoveredResponse = await dispatchRequest(recoveredRequest);
          if (recoveredResponse.ok) {
            return {
              upstream: recoveredResponse,
              upstreamPath: recoveredRequest.path,
              request: recoveredRequest,
            };
          }
          ctx.request = recoveredRequest;
          ctx.response = recoveredResponse;
          ctx.rawErrText = await readRuntimeResponseText(recoveredResponse).catch(() => 'unknown error');
        }
        return endpointStrategy.tryRecover(ctx);
      };

	      const startTime = Date.now();
	      const leaseResult = await acquireSurfaceChannelLease({
	        stickySessionKey,
	        selected,
	      });
	      if (leaseResult.status === 'timeout') {
	        clearSurfaceStickyChannel({
	          stickySessionKey,
	          selected,
	        });
	        const busyMessage = buildSurfaceChannelBusyMessage(leaseResult.waitMs);
	        await failureToolkit.log({
	          selected,
	          modelRequested: requestedModel,
	          status: 'failed',
	          httpStatus: 503,
	          latencyMs: leaseResult.waitMs,
	          errorMessage: busyMessage,
	          retryCount,
	        });
	        retryCount += 1;
	        if (retryCount <= maxRetries) {
	          continue;
	        }
	        return reply.code(503).send({
	          error: {
	            message: busyMessage,
	            type: 'server_error',
	          },
	        });
	      }
	      const channelLease = leaseResult.lease;

	      try {
        const endpointResult = await executeEndpointFlow({
          siteUrl: selected.site.url,
          endpointCandidates,
          buildRequest: (endpoint) => buildEndpointRequest(endpoint),
          dispatchRequest,
          firstByteTimeoutMs,
          tryRecover,
          onAttemptFailure: (ctx) => {
            recordUpstreamEndpointFailure({
              ...endpointRuntimeContext,
              endpoint: ctx.request.endpoint,
              status: ctx.response.status,
              errorText: ctx.rawErrText,
            });
          },
          onAttemptSuccess: (ctx) => {
            recordUpstreamEndpointSuccess({
              ...endpointRuntimeContext,
              endpoint: ctx.request.endpoint,
            });
          },
          shouldDowngrade: endpointStrategy.shouldDowngrade,
        });

	        if (!endpointResult.ok) {
	          clearSurfaceStickyChannel({
	            stickySessionKey,
	            selected,
	          });
	          const failureOutcome = await failureToolkit.handleUpstreamFailure({
	            selected,
	            requestedModel,
            modelName,
            status: endpointResult.status || 502,
            errText: endpointResult.errText || 'unknown error',
            rawErrText: endpointResult.rawErrText,
            isStream,
            latencyMs: Date.now() - startTime,
            retryCount,
          });
          if (failureOutcome.action === 'retry') {
            retryCount += 1;
            continue;
          }
          return reply.code(failureOutcome.status).send(failureOutcome.payload);
        }

      const upstream = endpointResult.upstream;
      const observedMeta = getObservedResponseMeta(upstream);
      const successfulUpstreamPath = endpointResult.upstreamPath;
      if (endpointResult.downgraded) {
        recordSuccessfulEndpointDowngrades({
          attempts: endpointResult.attempts,
          successfulEndpoint: endpointResult.successfulEndpoint,
          siteId: endpointRuntimeContext.siteId,
          modelName,
          requestedModelHint: requestedModel,
          requestCapabilities: endpointRuntimeContext.requestCapabilities,
        });
      }
      const finalizeStreamSuccess = async (
        parsedUsage: UsageSummary,
        latency: number,
        upstreamUsagePresent: boolean,
      ) => {
        try {
          await recordSurfaceSuccess({
            selected,
            requestedModel,
            modelName,
            parsedUsage,
            upstreamUsagePresent,
            requestStartedAtMs: startTime,
            latencyMs: latency,
            retryCount,
            isStream: true,
            firstByteLatencyMs: observedMeta?.firstByteLatencyMs ?? null,
            upstreamPath: successfulUpstreamPath,
            logSuccess: failureToolkit.log,
            recordDownstreamCost: (estimatedCost) => {
              recordDownstreamCostUsage(request, estimatedCost);
            },
            bestEffortMetrics: {
              errorLabel: '[responses] post-stream bookkeeping failed:',
            },
          });
        } catch (error) {
          console.error('[responses] post-stream success logging failed:', error);
        }
      };

        if (isStream) {
          const upstreamContentType = (upstream.headers.get('content-type') || '').toLowerCase();
          const startSseResponse = () => {
            reply.hijack();
            reply.raw.statusCode = 200;
            reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
            reply.raw.setHeader('Connection', 'keep-alive');
            reply.raw.setHeader('X-Accel-Buffering', 'no');
          };

          let parsedUsage: UsageSummary = {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            promptTokensIncludeCache: null,
          };
          let upstreamUsagePresent = false;
          const writeLines = (lines: string[]) => {
            for (const line of lines) reply.raw.write(line);
          };
          const websocketTransportRequest = isResponsesWebsocketTransportRequest(request.headers as Record<string, unknown>);
          const streamSession = openAiResponsesTransformer.proxyStream.createSession({
            modelName,
            successfulUpstreamPath,
            getUsage: () => parsedUsage,
            onParsedPayload: (payload) => {
              if (payload && typeof payload === 'object') {
                upstreamUsagePresent = upstreamUsagePresent || hasProxyUsagePayload(payload);
                parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(payload));
                if (codexSessionStoreKey) {
                  rememberCodexSessionResponseId(codexSessionStoreKey, payload);
                }
              }
            },
            writeLines,
            writeRaw: (chunk) => {
              reply.raw.write(chunk);
            },
          });
          if (!upstreamContentType.includes('text/event-stream')) {
            const rawText = await readRuntimeResponseText(upstream);
            if (looksLikeResponsesSseText(rawText)) {
              startSseResponse();
              const streamResult = await streamSession.run(
                createSingleChunkStreamReader(rawText),
                reply.raw,
              );
              const latency = Date.now() - startTime;
	              if (streamResult.status === 'failed') {
	                clearSurfaceStickyChannel({
	                  stickySessionKey,
	                  selected,
	                });
	                await failureToolkit.recordStreamFailure({
	                  selected,
	                  requestedModel,
                  modelName,
                  errorMessage: streamResult.errorMessage,
                  isStream: true,
                  firstByteLatencyMs: observedMeta?.firstByteLatencyMs ?? null,
                  latencyMs: latency,
                  retryCount,
                  promptTokens: parsedUsage.promptTokens,
                  completionTokens: parsedUsage.completionTokens,
                  totalTokens: parsedUsage.totalTokens,
                  upstreamPath: successfulUpstreamPath,
                });
                return;
	              }

	              await finalizeStreamSuccess(parsedUsage, latency, upstreamUsagePresent);
	              bindSurfaceStickyChannel({
	                stickySessionKey,
	                selected,
	              });
	              return;
	            }
            let upstreamData: unknown = rawText;
            try {
              upstreamData = JSON.parse(rawText);
            } catch {
              upstreamData = rawText;
            }
            if (String(selected.site.platform || '').trim().toLowerCase() === 'gemini-cli') {
              upstreamData = unwrapGeminiCliPayload(upstreamData);
            }
            if (codexSessionStoreKey) {
              rememberCodexSessionResponseId(codexSessionStoreKey, upstreamData);
            }

            parsedUsage = parseProxyUsage(upstreamData);
            upstreamUsagePresent = upstreamUsagePresent || hasProxyUsagePayload(upstreamData);
            const latency = Date.now() - startTime;
            const failure = detectProxyFailure({ rawText, usage: parsedUsage });
	            if (failure) {
	              clearSurfaceStickyChannel({
	                stickySessionKey,
	                selected,
	              });
	              const failureOutcome = await failureToolkit.handleDetectedFailure({
	                selected,
	                requestedModel,
                modelName,
                failure,
                isStream: true,
                firstByteLatencyMs: observedMeta?.firstByteLatencyMs ?? null,
                latencyMs: latency,
                retryCount,
                promptTokens: parsedUsage.promptTokens,
                completionTokens: parsedUsage.completionTokens,
                totalTokens: parsedUsage.totalTokens,
                upstreamPath: successfulUpstreamPath,
              });
              if (failureOutcome.action === 'retry') {
                retryCount += 1;
                continue;
              }
              return reply.code(failureOutcome.status).send(failureOutcome.payload);
            }

            startSseResponse();
            const streamResult = streamSession.consumeUpstreamFinalPayload(upstreamData, rawText, reply.raw);
	            if (streamResult.status === 'failed') {
	              clearSurfaceStickyChannel({
	                stickySessionKey,
	                selected,
	              });
	              await failureToolkit.recordStreamFailure({
	                selected,
	                requestedModel,
                modelName,
                errorMessage: streamResult.errorMessage,
                isStream: true,
                firstByteLatencyMs: observedMeta?.firstByteLatencyMs ?? null,
                latencyMs: latency,
                retryCount,
                promptTokens: parsedUsage.promptTokens,
                completionTokens: parsedUsage.completionTokens,
                totalTokens: parsedUsage.totalTokens,
                upstreamPath: successfulUpstreamPath,
                runtimeFailureStatus: 502,
              });
              return;
	            }

	            await finalizeStreamSuccess(parsedUsage, latency, upstreamUsagePresent);
	            bindSurfaceStickyChannel({
	              stickySessionKey,
	              selected,
	            });
	            return;
	          }

          startSseResponse();

          let replayReader: ReturnType<typeof createSingleChunkStreamReader> | null = null;
          if (websocketTransportRequest) {
            const rawText = await readRuntimeResponseText(upstream);
            if (looksLikeResponsesSseText(rawText)) {
              try {
                const collectedPayload = collectResponsesFinalPayloadFromSseText(rawText, modelName).payload;
                upstreamUsagePresent = upstreamUsagePresent || hasProxyUsagePayload(collectedPayload);
                parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(collectedPayload));
                const createdPayload = {
                  ...collectedPayload,
                  status: 'in_progress',
                  output: [],
                  output_text: '',
                };
                const terminalEventType = String(collectedPayload.status || '').trim().toLowerCase() === 'incomplete'
                  ? 'response.incomplete'
                  : 'response.completed';
                writeLines([
                  `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: createdPayload })}\n\n`,
                  `event: ${terminalEventType}\ndata: ${JSON.stringify({ type: terminalEventType, response: collectedPayload })}\n\n`,
                  'data: [DONE]\n\n',
                ]);
                if (codexSessionStoreKey) {
                  rememberCodexSessionResponseId(codexSessionStoreKey, collectedPayload);
                }
                reply.raw.end();
                const latency = Date.now() - startTime;
	                await finalizeStreamSuccess(
	                  parsedUsage,
	                  latency,
	                  upstreamUsagePresent,
	                );
	                bindSurfaceStickyChannel({
	                  stickySessionKey,
	                  selected,
	                });
	                return;
              } catch {
                // Fall through to the generic stream session for response.failed/error terminals.
              }

              const streamResult = await streamSession.run(
                createSingleChunkStreamReader(rawText),
                reply.raw,
              );
              const latency = Date.now() - startTime;
              if (streamResult.status === 'failed') {
                await failureToolkit.recordStreamFailure({
                  selected,
                  requestedModel,
                  modelName,
                  errorMessage: streamResult.errorMessage,
                  isStream: true,
                  firstByteLatencyMs: observedMeta?.firstByteLatencyMs ?? null,
                  latencyMs: latency,
                  retryCount,
                  promptTokens: parsedUsage.promptTokens,
                  completionTokens: parsedUsage.completionTokens,
                  totalTokens: parsedUsage.totalTokens,
                  upstreamPath: successfulUpstreamPath,
                  runtimeFailureStatus: 502,
                });
                return;
              }

	              await finalizeStreamSuccess(
	                parsedUsage,
	                latency,
	                upstreamUsagePresent,
	              );
	              return;
            }

            replayReader = createSingleChunkStreamReader(rawText);
          }

          const upstreamReader = replayReader ?? getRuntimeResponseReader(upstream);
          const baseReader = String(selected.site.platform || '').trim().toLowerCase() === 'gemini-cli' && upstreamReader
            ? createGeminiCliStreamReader(upstreamReader)
            : upstreamReader;
          let rawText = '';
          const decoder = new TextDecoder();
          const reader = baseReader
            ? {
              async read() {
                const result = await baseReader.read();
                if (result.value) {
                  rawText += decoder.decode(result.value, { stream: true });
                }
                return result;
              },
              async cancel(reason?: unknown) {
                return baseReader.cancel(reason);
              },
              releaseLock() {
                return baseReader.releaseLock();
              },
            }
            : baseReader;
          const streamResult = await streamSession.run(reader, reply.raw);
          rawText += decoder.decode();

          const latency = Date.now() - startTime;
	          if (streamResult.status === 'failed') {
	            clearSurfaceStickyChannel({
	              stickySessionKey,
	              selected,
	            });
	            await failureToolkit.recordStreamFailure({
	              selected,
	              requestedModel,
              modelName,
              errorMessage: streamResult.errorMessage,
              isStream: true,
              firstByteLatencyMs: observedMeta?.firstByteLatencyMs ?? null,
              latencyMs: latency,
              retryCount,
              promptTokens: parsedUsage.promptTokens,
              completionTokens: parsedUsage.completionTokens,
              totalTokens: parsedUsage.totalTokens,
              upstreamPath: successfulUpstreamPath,
              runtimeFailureStatus: 502,
            });
            return;
          }

          // Once SSE has been hijacked and bytes may already be on the wire, we
          // must not attempt to convert stream failures into a fresh HTTP error
          // response or retry on another channel. Responses stream failures are
	          // handled in-band by the proxy stream session.

	          await finalizeStreamSuccess(
	              parsedUsage,
	              latency,
	              upstreamUsagePresent,
	            );
	          bindSurfaceStickyChannel({
	            stickySessionKey,
	            selected,
	          });
	          return;
	        }

        const upstreamContentType = (upstream.headers.get('content-type') || '').toLowerCase();
        let rawText = '';
        let upstreamData: unknown;
        if (
          upstreamContentType.includes('text/event-stream')
          && (
            successfulUpstreamPath.endsWith('/responses')
            || successfulUpstreamPath.endsWith('/responses/compact')
          )
        ) {
          const collected = await collectResponsesFinalPayloadFromSse(upstream, modelName);
          rawText = collected.rawText;
          upstreamData = collected.payload;
        } else {
          rawText = await readRuntimeResponseText(upstream);
          if (looksLikeResponsesSseText(rawText)) {
            upstreamData = collectResponsesFinalPayloadFromSseText(rawText, modelName).payload;
          } else {
            upstreamData = rawText;
            try {
              upstreamData = JSON.parse(rawText);
            } catch {
              upstreamData = rawText;
            }
          }
        }
        if (String(selected.site.platform || '').trim().toLowerCase() === 'gemini-cli') {
          upstreamData = unwrapGeminiCliPayload(upstreamData);
        }
        if (codexSessionStoreKey) {
          rememberCodexSessionResponseId(codexSessionStoreKey, upstreamData);
        }
        const latency = Date.now() - startTime;
        const parsedUsage = parseProxyUsage(upstreamData);
        const upstreamUsagePresent = hasProxyUsagePayload(upstreamData);
        const failure = detectProxyFailure({ rawText, usage: parsedUsage });
	        if (failure) {
	          clearSurfaceStickyChannel({
	            stickySessionKey,
	            selected,
	          });
	          const failureOutcome = await failureToolkit.handleDetectedFailure({
	            selected,
	            requestedModel,
            modelName,
            failure,
            isStream: false,
            firstByteLatencyMs: observedMeta?.firstByteLatencyMs ?? null,
            latencyMs: latency,
            retryCount,
            promptTokens: parsedUsage.promptTokens,
            completionTokens: parsedUsage.completionTokens,
            totalTokens: parsedUsage.totalTokens,
            upstreamPath: successfulUpstreamPath,
          });
          if (failureOutcome.action === 'retry') {
            retryCount += 1;
            continue;
          }
          return reply.code(failureOutcome.status).send(failureOutcome.payload);
        }
        const normalized = openAiResponsesTransformer.transformFinalResponse(
          upstreamData,
          modelName,
          rawText,
        );
        const downstreamData = openAiResponsesTransformer.outbound.serializeFinal({
          upstreamPayload: upstreamData,
          normalized,
          usage: parsedUsage,
          serializationMode: isCompactRequest ? 'compact' : 'response',
        });
        try {
          await recordSurfaceSuccess({
            selected,
            requestedModel,
            modelName,
            parsedUsage,
            upstreamUsagePresent,
            requestStartedAtMs: startTime,
            latencyMs: latency,
            retryCount,
            isStream: false,
            firstByteLatencyMs: observedMeta?.firstByteLatencyMs ?? null,
            upstreamPath: successfulUpstreamPath,
            logSuccess: failureToolkit.log,
            recordDownstreamCost: (estimatedCost) => {
              recordDownstreamCostUsage(request, estimatedCost);
            },
            bestEffortMetrics: {
              errorLabel: '[responses] post-response bookkeeping failed:',
            },
          });
        } catch (error) {
          console.error('[responses] post-response success logging failed:', error);
        }
        bindSurfaceStickyChannel({
          stickySessionKey,
          selected,
        });
        return reply.send(downstreamData);
      } catch (err: any) {
        clearSurfaceStickyChannel({
          stickySessionKey,
          selected,
        });
        const failureOutcome = await failureToolkit.handleExecutionError({
          selected,
          requestedModel,
          modelName,
          errorMessage: err?.message || 'network failure',
          isStream,
          latencyMs: Date.now() - startTime,
          retryCount,
        });
        if (failureOutcome.action === 'retry') {
          retryCount += 1;
          continue;
	        }
	        return reply.code(failureOutcome.status).send(failureOutcome.payload);
	      } finally {
	        channelLease.release();
	      }
	    }
}

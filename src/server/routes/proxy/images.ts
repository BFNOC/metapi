import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fetch } from 'undici';
import { config } from '../../config.js';
import { tokenRouter } from '../../services/tokenRouter.js';
import * as routeRefreshWorkflow from '../../services/routeRefreshWorkflow.js';
import { reportProxyAllFailed, reportTokenExpired } from '../../services/alertService.js';
import { isTokenExpiredError } from '../../services/alertRules.js';
import { estimateProxyCost } from '../../services/modelPricingService.js';
import { shouldRetryProxyRequest } from '../../services/proxyRetryPolicy.js';
import { ensureModelAllowedForDownstreamKey, getDownstreamRoutingPolicy, recordDownstreamCostUsage } from './downstreamPolicy.js';
import { withSiteRecordProxyRequestInit } from '../../services/siteProxy.js';
import { getProxyUrlFromExtraConfig } from '../../services/accountExtraConfig.js';
import { composeProxyLogMessage } from './logPathMeta.js';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { cloneFormDataWithOverrides, ensureMultipartBufferParser, parseMultipartFormData } from './multipart.js';
import { getProxyAuthContext } from '../../middleware/auth.js';
import { buildUpstreamUrl } from './upstreamUrl.js';
import { detectDownstreamClientContext, type DownstreamClientContext } from './downstreamClientContext.js';
import { insertProxyLog } from '../../services/proxyLogStore.js';
import { canRetryProxyChannel, getProxyMaxChannelRetries } from '../../services/proxyChannelRetry.js';
import {
  fetchWithObservedFirstByte,
  getObservedResponseMeta,
  resolveProxyFirstByteTimeoutMs,
} from '../../proxy-core/firstByteTimeout.js';
import { readRuntimeResponseText } from '../../proxy-core/executors/types.js';

export async function imagesProxyRoute(app: FastifyInstance) {
  ensureMultipartBufferParser(app);

  app.post('/v1/images/generations', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    const requestedModel = body?.model || 'gpt-image-1';
    if (!await ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;
    const downstreamPolicy = getDownstreamRoutingPolicy(request);
    const downstreamApiKeyId = getProxyAuthContext(request)?.keyId ?? null;
    const downstreamPath = '/v1/images/generations';
    const clientContext = detectDownstreamClientContext({
      downstreamPath,
      headers: request.headers as Record<string, unknown>,
      body,
    });
    const firstByteTimeoutMs = resolveProxyFirstByteTimeoutMs(config.proxyFirstByteTimeoutSec);
    const excludeChannelIds: number[] = [];
    let retryCount = 0;

    while (retryCount <= getProxyMaxChannelRetries()) {
      let selected = retryCount === 0
        ? await tokenRouter.selectChannel(requestedModel, downstreamPolicy)
        : await tokenRouter.selectNextChannel(requestedModel, excludeChannelIds, downstreamPolicy);

      if (!selected && retryCount === 0) {
        await routeRefreshWorkflow.refreshModelsAndRebuildRoutes();
        selected = await tokenRouter.selectChannel(requestedModel, downstreamPolicy);
      }

      if (!selected) {
        await reportProxyAllFailed({
          model: requestedModel,
          reason: 'No available channels after retries',
        });
        return reply.code(503).send({
          error: { message: 'No available channels for this model', type: 'server_error' },
        });
      }

      excludeChannelIds.push(selected.channel.id);

      const targetUrl = buildUpstreamUrl(selected.site.url, '/v1/images/generations');
      const upstreamModel = selected.actualModel || requestedModel;
      const forwardBody = { ...body, model: upstreamModel };
      const startTime = Date.now();

      try {
        const attemptStartedAtMs = Date.now();
        const upstream = await fetchWithObservedFirstByte(
          async (signal) => fetch(targetUrl, withSiteRecordProxyRequestInit(selected.site, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${selected.tokenValue}`,
            },
            body: JSON.stringify(forwardBody),
            signal,
          }, getProxyUrlFromExtraConfig(selected.account.extraConfig))),
          {
            firstByteTimeoutMs,
            startedAtMs: attemptStartedAtMs,
          },
        );
        const firstByteLatencyMs = getObservedResponseMeta(upstream)?.firstByteLatencyMs ?? null;
        const text = await readRuntimeResponseText(upstream);
        if (!upstream.ok) {
          await recordTokenRouterEventBestEffort('record channel failure', () => tokenRouter.recordFailure(selected.channel.id, {
            status: upstream.status,
            errorText: text,
            modelName: upstreamModel,
          }));
          logProxy(
            selected,
            requestedModel,
            'failed',
            upstream.status,
            Date.now() - startTime,
            text,
            retryCount,
            downstreamApiKeyId,
            0,
            false,
            firstByteLatencyMs,
            downstreamPath,
            clientContext,
          );
          if (isTokenExpiredError({ status: upstream.status, message: text })) {
            await reportTokenExpired({
              accountId: selected.account.id,
              username: selected.account.username,
              siteName: selected.site.name,
              detail: `HTTP ${upstream.status}`,
            });
          }
          if (shouldRetryProxyRequest(upstream.status, text) && canRetryProxyChannel(retryCount)) {
            retryCount++;
            continue;
          }
          await reportProxyAllFailed({
            model: requestedModel,
            reason: `upstream returned HTTP ${upstream.status}`,
          });
          return reply.code(upstream.status).send({ error: { message: text, type: 'upstream_error' } });
        }

        const data = parseUpstreamImageResponse(text);
        if (!data.ok) {
          await recordTokenRouterEventBestEffort('record malformed upstream response', () => tokenRouter.recordFailure(selected.channel.id, {
            status: 502,
            errorText: data.message,
            modelName: upstreamModel,
          }));
          logProxy(
            selected,
            requestedModel,
            'failed',
            502,
            Date.now() - startTime,
            data.message,
            retryCount,
            downstreamApiKeyId,
            0,
            false,
            firstByteLatencyMs,
            downstreamPath,
            clientContext,
          );
          if (canRetryProxyChannel(retryCount)) {
            retryCount++;
            continue;
          }
          await reportProxyAllFailed({
            model: requestedModel,
            reason: data.message,
          });
          return reply.code(502).send({
            error: { message: data.message, type: 'upstream_error' },
          });
        }

        const latency = Date.now() - startTime;
        let estimatedCost = 0;
        await recordTokenRouterEventBestEffort('estimate proxy cost', async () => {
          estimatedCost = await estimateProxyCost({
            site: selected.site,
            account: selected.account,
            modelName: upstreamModel,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
          });
        });
        await recordTokenRouterEventBestEffort('record channel success', () => (
          tokenRouter.recordSuccess(selected.channel.id, latency, estimatedCost, upstreamModel)
        ));
        await recordTokenRouterEventBestEffort('record downstream cost usage', () => (
          recordDownstreamCostUsage(request, estimatedCost)
        ));
        logProxy(selected, requestedModel, 'success', upstream.status, latency, null, retryCount, downstreamApiKeyId, estimatedCost, false, firstByteLatencyMs, downstreamPath, clientContext);
        return reply.code(upstream.status).send(data.value);
      } catch (err: any) {
        await recordTokenRouterEventBestEffort('record channel failure', () => tokenRouter.recordFailure(selected.channel.id, {
          status: 0,
          errorText: err.message,
          modelName: upstreamModel,
        }));
        logProxy(
          selected,
          requestedModel,
          'failed',
          0,
          Date.now() - startTime,
          err.message,
          retryCount,
          downstreamApiKeyId,
          0,
          false,
          null,
          downstreamPath,
          clientContext,
        );
        if (canRetryProxyChannel(retryCount)) {
          retryCount++;
          continue;
        }
        await reportProxyAllFailed({
          model: requestedModel,
          reason: err.message || 'network failure',
        });
        return reply.code(502).send({
          error: { message: `Upstream error: ${err.message}`, type: 'upstream_error' },
        });
      }
    }
  });

  app.post('/v1/images/edits', async (request: FastifyRequest, reply: FastifyReply) => {
    const multipartForm = await parseMultipartFormData(request);
    const jsonBody = (!multipartForm && request.body && typeof request.body === 'object')
      ? request.body as Record<string, unknown>
      : null;
    const requestedModel = typeof multipartForm?.get('model') === 'string'
      ? String(multipartForm.get('model')).trim()
      : (typeof jsonBody?.model === 'string' ? jsonBody.model.trim() : '') || 'gpt-image-1';

    if (!await ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;
    const downstreamPolicy = getDownstreamRoutingPolicy(request);
    const downstreamApiKeyId = getProxyAuthContext(request)?.keyId ?? null;
    const downstreamPath = '/v1/images/edits';
    const clientContext = detectDownstreamClientContext({
      downstreamPath,
      headers: request.headers as Record<string, unknown>,
      body: jsonBody || Object.fromEntries(multipartForm?.entries?.() || []),
    });
    const firstByteTimeoutMs = resolveProxyFirstByteTimeoutMs(config.proxyFirstByteTimeoutSec);
    const excludeChannelIds: number[] = [];
    let retryCount = 0;

    while (retryCount <= getProxyMaxChannelRetries()) {
      let selected = retryCount === 0
        ? await tokenRouter.selectChannel(requestedModel, downstreamPolicy)
        : await tokenRouter.selectNextChannel(requestedModel, excludeChannelIds, downstreamPolicy);

      if (!selected && retryCount === 0) {
        await routeRefreshWorkflow.refreshModelsAndRebuildRoutes();
        selected = await tokenRouter.selectChannel(requestedModel, downstreamPolicy);
      }

      if (!selected) {
        await reportProxyAllFailed({
          model: requestedModel,
          reason: 'No available channels after retries',
        });
        return reply.code(503).send({
          error: { message: 'No available channels for this model', type: 'server_error' },
        });
      }

      excludeChannelIds.push(selected.channel.id);
      const targetUrl = buildUpstreamUrl(selected.site.url, '/v1/images/edits');
      const upstreamModel = selected.actualModel || requestedModel;
      const startTime = Date.now();

      try {
        const requestInit = multipartForm
          ? withSiteRecordProxyRequestInit(selected.site, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${selected.tokenValue}`,
            },
            body: cloneFormDataWithOverrides(multipartForm, {
              model: upstreamModel,
            }) as any,
          }, getProxyUrlFromExtraConfig(selected.account.extraConfig))
          : withSiteRecordProxyRequestInit(selected.site, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${selected.tokenValue}`,
            },
            body: JSON.stringify({
              ...(jsonBody || {}),
              model: upstreamModel,
            }),
          }, getProxyUrlFromExtraConfig(selected.account.extraConfig));

        const attemptStartedAtMs = Date.now();
        const upstream = await fetchWithObservedFirstByte(
          async (signal) => fetch(targetUrl, {
            ...requestInit,
            ...(signal ? { signal } : {}),
          }),
          {
            firstByteTimeoutMs,
            startedAtMs: attemptStartedAtMs,
          },
        );
        const firstByteLatencyMs = getObservedResponseMeta(upstream)?.firstByteLatencyMs ?? null;
        const text = await readRuntimeResponseText(upstream);
        if (!upstream.ok) {
          await recordTokenRouterEventBestEffort('record channel failure', () => tokenRouter.recordFailure(selected.channel.id, {
            status: upstream.status,
            errorText: text,
            modelName: upstreamModel,
          }));
          logProxy(
            selected,
            requestedModel,
            'failed',
            upstream.status,
            Date.now() - startTime,
            text,
            retryCount,
            downstreamApiKeyId,
            0,
            false,
            firstByteLatencyMs,
            downstreamPath,
            clientContext,
          );
          if (isTokenExpiredError({ status: upstream.status, message: text })) {
            await reportTokenExpired({
              accountId: selected.account.id,
              username: selected.account.username,
              siteName: selected.site.name,
              detail: `HTTP ${upstream.status}`,
            });
          }
          if (shouldRetryProxyRequest(upstream.status, text) && canRetryProxyChannel(retryCount)) {
            retryCount++;
            continue;
          }
          await reportProxyAllFailed({
            model: requestedModel,
            reason: `upstream returned HTTP ${upstream.status}`,
          });
          return reply.code(upstream.status).send({ error: { message: text, type: 'upstream_error' } });
        }

        const data = parseUpstreamImageResponse(text);
        if (!data.ok) {
          await recordTokenRouterEventBestEffort('record malformed upstream response', () => tokenRouter.recordFailure(selected.channel.id, {
            status: 502,
            errorText: data.message,
            modelName: upstreamModel,
          }));
          logProxy(
            selected,
            requestedModel,
            'failed',
            502,
            Date.now() - startTime,
            data.message,
            retryCount,
            downstreamApiKeyId,
            0,
            false,
            firstByteLatencyMs,
            downstreamPath,
            clientContext,
          );
          if (canRetryProxyChannel(retryCount)) {
            retryCount++;
            continue;
          }
          await reportProxyAllFailed({
            model: requestedModel,
            reason: data.message,
          });
          return reply.code(502).send({
            error: { message: data.message, type: 'upstream_error' },
          });
        }

        const latency = Date.now() - startTime;
        let estimatedCost = 0;
        await recordTokenRouterEventBestEffort('estimate proxy cost', async () => {
          estimatedCost = await estimateProxyCost({
            site: selected.site,
            account: selected.account,
            modelName: upstreamModel,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
          });
        });
        await recordTokenRouterEventBestEffort('record channel success', () => (
          tokenRouter.recordSuccess(selected.channel.id, latency, estimatedCost, upstreamModel)
        ));
        await recordTokenRouterEventBestEffort('record downstream cost usage', () => (
          recordDownstreamCostUsage(request, estimatedCost)
        ));
        logProxy(selected, requestedModel, 'success', upstream.status, latency, null, retryCount, downstreamApiKeyId, estimatedCost, false, firstByteLatencyMs, downstreamPath, clientContext);
        return reply.code(upstream.status).send(data.value);
      } catch (err: any) {
        await recordTokenRouterEventBestEffort('record channel failure', () => tokenRouter.recordFailure(selected.channel.id, {
          status: 0,
          errorText: err.message,
          modelName: upstreamModel,
        }));
        logProxy(
          selected,
          requestedModel,
          'failed',
          0,
          Date.now() - startTime,
          err.message,
          retryCount,
          downstreamApiKeyId,
          0,
          false,
          null,
          downstreamPath,
          clientContext,
        );
        if (canRetryProxyChannel(retryCount)) {
          retryCount++;
          continue;
        }
        await reportProxyAllFailed({
          model: requestedModel,
          reason: err.message || 'network failure',
        });
        return reply.code(502).send({
          error: { message: `Upstream error: ${err.message}`, type: 'upstream_error' },
        });
      }
    }
  });

  app.post('/v1/images/variations', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(400).send({
      error: {
        message: 'Image variations are not supported',
        type: 'invalid_request_error',
      },
    });
  });
}

async function logProxy(
  selected: any,
  modelRequested: string,
  status: string,
  httpStatus: number,
  latencyMs: number,
  errorMessage: string | null,
  retryCount: number,
  downstreamApiKeyId: number | null = null,
  estimatedCost = 0,
  isStream: boolean,
  firstByteLatencyMs: number | null,
  downstreamPath: string,
  clientContext: DownstreamClientContext | null,
) {
  try {
    const createdAt = formatUtcSqlDateTime(new Date());
    const normalizedErrorMessage = composeProxyLogMessage({
      clientKind: clientContext?.clientKind && clientContext.clientKind !== 'generic'
        ? clientContext.clientKind
        : null,
      sessionId: clientContext?.sessionId || null,
      traceHint: clientContext?.traceHint || null,
      downstreamPath,
      errorMessage,
    });
    await insertProxyLog({
      routeId: selected.channel.routeId,
      channelId: selected.channel.id,
      accountId: selected.account.id,
      downstreamApiKeyId,
      modelRequested,
      modelActual: selected.actualModel || modelRequested,
      status,
      httpStatus,
      isStream,
      firstByteLatencyMs,
      latencyMs,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCost,
      clientFamily: clientContext?.clientKind || null,
      clientAppId: clientContext?.clientAppId || null,
      clientAppName: clientContext?.clientAppName || null,
      clientConfidence: clientContext?.clientConfidence || null,
      errorMessage: normalizedErrorMessage,
      retryCount,
      createdAt,
    });
  } catch (error) {
    console.warn('[proxy/images] failed to write proxy log', error);
  }
}

async function recordTokenRouterEventBestEffort(
  label: string,
  operation: () => Promise<unknown> | unknown,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    console.warn(`[proxy/images] failed to ${label}`, error);
  }
}

function parseUpstreamImageResponse(text: string): { ok: true; value: any } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, message: text || 'Upstream returned malformed JSON' };
  }
}

import { beforeEach, describe, expect, it, vi } from 'vitest';

const reportProxyAllFailedMock = vi.fn();
const hasProxyUsagePayloadMock = vi.fn(() => false);
const parseProxyUsageMock = vi.fn(() => ({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  promptTokensIncludeCache: null,
}));
const mergeProxyUsageMock = vi.fn((_current, next) => next);
const transformRequestMock = vi.fn();
const createEndpointStrategyMock = vi.fn();
const transformFinalResponseMock = vi.fn();
const serializeFinalMock = vi.fn();
const buildUpstreamEndpointRequestMock = vi.fn();
const recordUpstreamEndpointDowngradeMock = vi.fn();
const recordUpstreamEndpointFailureMock = vi.fn();
const recordUpstreamEndpointSuccessMock = vi.fn();
const resolveUpstreamEndpointCandidatesMock = vi.fn();
const ensureModelAllowedForDownstreamKeyMock = vi.fn();
const getDownstreamRoutingPolicyMock = vi.fn();
const recordDownstreamCostUsageMock = vi.fn();
const executeEndpointFlowMock = vi.fn();
const detectProxyFailureMock = vi.fn();
const getProxyAuthContextMock = vi.fn();
const getProxyResourceOwnerMock = vi.fn();
const normalizeInputFileBlockMock = vi.fn();
const resolveResponsesBodyInputFilesMock = vi.fn();
const buildOauthProviderHeadersMock = vi.fn();
const getOauthInfoFromAccountMock = vi.fn();
const collectResponsesFinalPayloadFromSseMock = vi.fn();
const collectResponsesFinalPayloadFromSseTextMock = vi.fn();
const createSingleChunkStreamReaderMock = vi.fn();
const looksLikeResponsesSseTextMock = vi.fn();
const createGeminiCliStreamReaderMock = vi.fn();
const unwrapGeminiCliPayloadMock = vi.fn((value) => value);
const isCodexResponsesSurfaceMock = vi.fn();
const getRuntimeResponseReaderMock = vi.fn();
const readRuntimeResponseTextMock = vi.fn();
const runCodexHttpSessionTaskMock = vi.fn();
const summarizeConversationFileInputsInOpenAiBodyMock = vi.fn();
const summarizeConversationFileInputsInResponsesBodyMock = vi.fn();
const detectDownstreamClientContextMock = vi.fn();
const getProxyMaxChannelRetriesMock = vi.fn();
const acquireSurfaceChannelLeaseMock = vi.fn();
const bindSurfaceStickyChannelMock = vi.fn();
const buildSurfaceChannelBusyMessageMock = vi.fn();
const buildSurfaceStickySessionKeyMock = vi.fn();
const clearSurfaceStickyChannelMock = vi.fn();
const createSurfaceFailureToolkitMock = vi.fn();
const createSurfaceDispatchRequestMock = vi.fn();
const recordSurfaceSuccessMock = vi.fn();
const selectSurfaceChannelForAttemptMock = vi.fn();
const trySurfaceOauthRefreshRecoveryMock = vi.fn();

vi.mock('../../services/alertService.js', () => ({
  reportProxyAllFailed: (...args: unknown[]) => reportProxyAllFailedMock(...args),
}));

vi.mock('../../services/proxyUsageParser.js', () => ({
  hasProxyUsagePayload: (...args: unknown[]) => hasProxyUsagePayloadMock(...args),
  mergeProxyUsage: (...args: unknown[]) => mergeProxyUsageMock(...args),
  parseProxyUsage: (...args: unknown[]) => parseProxyUsageMock(...args),
}));

vi.mock('../../transformers/openai/responses/index.js', () => ({
  openAiResponsesTransformer: {
    transformRequest: (...args: unknown[]) => transformRequestMock(...args),
    inbound: {
      toOpenAiBody: vi.fn((body) => body),
    },
    compatibility: {
      createEndpointStrategy: (...args: unknown[]) => createEndpointStrategyMock(...args),
    },
    transformFinalResponse: (...args: unknown[]) => transformFinalResponseMock(...args),
    outbound: {
      serializeFinal: (...args: unknown[]) => serializeFinalMock(...args),
    },
    proxyStream: {
      createSession: vi.fn(),
    },
  },
}));

vi.mock('../../routes/proxy/upstreamEndpoint.js', () => ({
  buildUpstreamEndpointRequest: (...args: unknown[]) => buildUpstreamEndpointRequestMock(...args),
  recordUpstreamEndpointDowngrade: (...args: unknown[]) => recordUpstreamEndpointDowngradeMock(...args),
  recordUpstreamEndpointFailure: (...args: unknown[]) => recordUpstreamEndpointFailureMock(...args),
  recordUpstreamEndpointSuccess: (...args: unknown[]) => recordUpstreamEndpointSuccessMock(...args),
  resolveUpstreamEndpointCandidates: (...args: unknown[]) => resolveUpstreamEndpointCandidatesMock(...args),
}));

vi.mock('../../routes/proxy/downstreamPolicy.js', () => ({
  ensureModelAllowedForDownstreamKey: (...args: unknown[]) => ensureModelAllowedForDownstreamKeyMock(...args),
  getDownstreamRoutingPolicy: (...args: unknown[]) => getDownstreamRoutingPolicyMock(...args),
  recordDownstreamCostUsage: (...args: unknown[]) => recordDownstreamCostUsageMock(...args),
}));

vi.mock('../../routes/proxy/endpointFlow.js', () => ({
  executeEndpointFlow: (...args: unknown[]) => executeEndpointFlowMock(...args),
}));

vi.mock('../../routes/proxy/proxyFailureJudge.js', () => ({
  detectProxyFailure: (...args: unknown[]) => detectProxyFailureMock(...args),
}));

vi.mock('../../middleware/auth.js', () => ({
  getProxyAuthContext: (...args: unknown[]) => getProxyAuthContextMock(...args),
  getProxyResourceOwner: (...args: unknown[]) => getProxyResourceOwnerMock(...args),
}));

vi.mock('../../transformers/shared/inputFile.js', () => ({
  normalizeInputFileBlock: (...args: unknown[]) => normalizeInputFileBlockMock(...args),
}));

vi.mock('../../services/proxyInputFileResolver.js', () => ({
  ProxyInputFileResolutionError: class ProxyInputFileResolutionError extends Error {},
  resolveResponsesBodyInputFiles: (...args: unknown[]) => resolveResponsesBodyInputFilesMock(...args),
}));

vi.mock('../../services/oauth/service.js', () => ({
  buildOauthProviderHeaders: (...args: unknown[]) => buildOauthProviderHeadersMock(...args),
}));

vi.mock('../../services/oauth/oauthAccount.js', () => ({
  getOauthInfoFromAccount: (...args: unknown[]) => getOauthInfoFromAccountMock(...args),
}));

vi.mock('../../routes/proxy/responsesSseFinal.js', () => ({
  collectResponsesFinalPayloadFromSse: (...args: unknown[]) => collectResponsesFinalPayloadFromSseMock(...args),
  collectResponsesFinalPayloadFromSseText: (...args: unknown[]) => collectResponsesFinalPayloadFromSseTextMock(...args),
  createSingleChunkStreamReader: (...args: unknown[]) => createSingleChunkStreamReaderMock(...args),
  looksLikeResponsesSseText: (...args: unknown[]) => looksLikeResponsesSseTextMock(...args),
}));

vi.mock('../../routes/proxy/geminiCliCompat.js', () => ({
  createGeminiCliStreamReader: (...args: unknown[]) => createGeminiCliStreamReaderMock(...args),
  unwrapGeminiCliPayload: (...args: unknown[]) => unwrapGeminiCliPayloadMock(...args),
}));

vi.mock('../cliProfiles/codexProfile.js', () => ({
  isCodexResponsesSurface: (...args: unknown[]) => isCodexResponsesSurfaceMock(...args),
}));

vi.mock('../executors/types.js', () => ({
  getRuntimeResponseReader: (...args: unknown[]) => getRuntimeResponseReaderMock(...args),
  readRuntimeResponseText: (...args: unknown[]) => readRuntimeResponseTextMock(...args),
}));

vi.mock('../runtime/codexHttpSessionQueue.js', () => ({
  runCodexHttpSessionTask: (...args: unknown[]) => runCodexHttpSessionTaskMock(...args),
}));

vi.mock('../capabilities/conversationFileCapabilities.js', () => ({
  summarizeConversationFileInputsInOpenAiBody: (...args: unknown[]) => summarizeConversationFileInputsInOpenAiBodyMock(...args),
  summarizeConversationFileInputsInResponsesBody: (...args: unknown[]) => summarizeConversationFileInputsInResponsesBodyMock(...args),
}));

vi.mock('../../routes/proxy/downstreamClientContext.js', () => ({
  detectDownstreamClientContext: (...args: unknown[]) => detectDownstreamClientContextMock(...args),
}));

vi.mock('../../services/proxyChannelRetry.js', () => ({
  getProxyMaxChannelRetries: (...args: unknown[]) => getProxyMaxChannelRetriesMock(...args),
}));

vi.mock('./sharedSurface.js', () => ({
  acquireSurfaceChannelLease: (...args: unknown[]) => acquireSurfaceChannelLeaseMock(...args),
  bindSurfaceStickyChannel: (...args: unknown[]) => bindSurfaceStickyChannelMock(...args),
  buildSurfaceChannelBusyMessage: (...args: unknown[]) => buildSurfaceChannelBusyMessageMock(...args),
  buildSurfaceStickySessionKey: (...args: unknown[]) => buildSurfaceStickySessionKeyMock(...args),
  clearSurfaceStickyChannel: (...args: unknown[]) => clearSurfaceStickyChannelMock(...args),
  createSurfaceFailureToolkit: (...args: unknown[]) => createSurfaceFailureToolkitMock(...args),
  createSurfaceDispatchRequest: (...args: unknown[]) => createSurfaceDispatchRequestMock(...args),
  recordSurfaceSuccess: (...args: unknown[]) => recordSurfaceSuccessMock(...args),
  selectSurfaceChannelForAttempt: (...args: unknown[]) => selectSurfaceChannelForAttemptMock(...args),
  trySurfaceOauthRefreshRecovery: (...args: unknown[]) => trySurfaceOauthRefreshRecoveryMock(...args),
}));

describe('handleOpenAiResponsesSurfaceRequest', () => {
  beforeEach(() => {
    reportProxyAllFailedMock.mockReset();
    hasProxyUsagePayloadMock.mockReset();
    hasProxyUsagePayloadMock.mockReturnValue(false);
    parseProxyUsageMock.mockClear();
    mergeProxyUsageMock.mockClear();
    transformRequestMock.mockReset();
    createEndpointStrategyMock.mockReset();
    transformFinalResponseMock.mockReset();
    serializeFinalMock.mockReset();
    buildUpstreamEndpointRequestMock.mockReset();
    recordUpstreamEndpointDowngradeMock.mockReset();
    recordUpstreamEndpointFailureMock.mockReset();
    recordUpstreamEndpointSuccessMock.mockReset();
    resolveUpstreamEndpointCandidatesMock.mockReset();
    ensureModelAllowedForDownstreamKeyMock.mockReset();
    getDownstreamRoutingPolicyMock.mockReset();
    recordDownstreamCostUsageMock.mockReset();
    executeEndpointFlowMock.mockReset();
    detectProxyFailureMock.mockReset();
    getProxyAuthContextMock.mockReset();
    getProxyResourceOwnerMock.mockReset();
    normalizeInputFileBlockMock.mockReset();
    resolveResponsesBodyInputFilesMock.mockReset();
    buildOauthProviderHeadersMock.mockReset();
    getOauthInfoFromAccountMock.mockReset();
    collectResponsesFinalPayloadFromSseMock.mockReset();
    collectResponsesFinalPayloadFromSseTextMock.mockReset();
    createSingleChunkStreamReaderMock.mockReset();
    looksLikeResponsesSseTextMock.mockReset();
    createGeminiCliStreamReaderMock.mockReset();
    unwrapGeminiCliPayloadMock.mockClear();
    isCodexResponsesSurfaceMock.mockReset();
    getRuntimeResponseReaderMock.mockReset();
    readRuntimeResponseTextMock.mockReset();
    runCodexHttpSessionTaskMock.mockReset();
    summarizeConversationFileInputsInOpenAiBodyMock.mockReset();
    summarizeConversationFileInputsInResponsesBodyMock.mockReset();
    detectDownstreamClientContextMock.mockReset();
    getProxyMaxChannelRetriesMock.mockReset();
    acquireSurfaceChannelLeaseMock.mockReset();
    bindSurfaceStickyChannelMock.mockReset();
    buildSurfaceChannelBusyMessageMock.mockReset();
    buildSurfaceStickySessionKeyMock.mockReset();
    clearSurfaceStickyChannelMock.mockReset();
    createSurfaceFailureToolkitMock.mockReset();
    createSurfaceDispatchRequestMock.mockReset();
    recordSurfaceSuccessMock.mockReset();
    selectSurfaceChannelForAttemptMock.mockReset();
    trySurfaceOauthRefreshRecoveryMock.mockReset();
  });

  it('treats downgraded endpoint success as a single final success without failure handling', async () => {
    transformRequestMock.mockReturnValue({
      value: {
        model: 'gpt-5.4',
        stream: false,
        parsed: {
          normalizedBody: {
            input: 'hello',
          },
        },
      },
    });
    ensureModelAllowedForDownstreamKeyMock.mockResolvedValue(true);
    getDownstreamRoutingPolicyMock.mockReturnValue({});
    getProxyAuthContextMock.mockReturnValue(null);
    getProxyResourceOwnerMock.mockReturnValue(null);
    detectDownstreamClientContextMock.mockReturnValue({
      clientKind: 'generic',
    });
    getProxyMaxChannelRetriesMock.mockReturnValue(0);
    buildSurfaceStickySessionKeyMock.mockReturnValue('sticky-responses');
    summarizeConversationFileInputsInOpenAiBodyMock.mockReturnValue({
      hasImage: false,
      hasAudio: false,
      hasDocument: false,
      hasRemoteDocumentUrl: false,
    });
    summarizeConversationFileInputsInResponsesBodyMock.mockReturnValue({
      hasImage: false,
      hasAudio: false,
      hasDocument: false,
      hasRemoteDocumentUrl: false,
    });
    resolveUpstreamEndpointCandidatesMock.mockResolvedValue(['responses', 'chat']);
    selectSurfaceChannelForAttemptMock.mockResolvedValue({
      channel: { id: 11, routeId: 22 },
      account: { id: 33, extraConfig: null },
      site: { id: 44, url: 'https://upstream.example.com', platform: 'openai' },
      tokenValue: 'token-demo',
      actualModel: 'upstream-model',
    });
    acquireSurfaceChannelLeaseMock.mockResolvedValue({
      status: 'acquired',
      lease: { release: vi.fn() },
    });
    createSurfaceFailureToolkitMock.mockReturnValue({
      log: vi.fn().mockResolvedValue(undefined),
      handleUpstreamFailure: vi.fn().mockResolvedValue({
        action: 'respond',
        status: 502,
        payload: { error: { message: 'upstream failed', type: 'upstream_error' } },
      }),
      handleDetectedFailure: vi.fn().mockResolvedValue({
        action: 'respond',
        status: 502,
        payload: { error: { message: 'detected failure', type: 'upstream_error' } },
      }),
      handleExecutionError: vi.fn().mockResolvedValue({
        action: 'respond',
        status: 502,
        payload: { error: { message: 'execution failed', type: 'upstream_error' } },
      }),
      recordStreamFailure: vi.fn(),
    });
    createSurfaceDispatchRequestMock.mockReturnValue(vi.fn());
    createEndpointStrategyMock.mockReturnValue({
      shouldDowngrade: vi.fn(() => true),
      tryRecover: vi.fn(async () => null),
    });
    buildOauthProviderHeadersMock.mockReturnValue({});
    getOauthInfoFromAccountMock.mockReturnValue(null);
    isCodexResponsesSurfaceMock.mockReturnValue(false);
    executeEndpointFlowMock.mockResolvedValue({
      ok: true,
      upstream: new Response(JSON.stringify({ id: 'resp_1', output: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      upstreamPath: '/v1/chat/completions',
      successfulEndpoint: 'chat',
      downgraded: true,
      attempts: [
        { endpoint: 'responses', path: '/v1/responses', status: 502, errText: 'bad gateway' },
        { endpoint: 'chat', path: '/v1/chat/completions', status: 200, errText: null },
      ],
    });
    detectProxyFailureMock.mockReturnValue(null);
    readRuntimeResponseTextMock.mockResolvedValue(JSON.stringify({ id: 'resp_1', output: [] }));
    transformFinalResponseMock.mockReturnValue({ id: 'normalized' });
    serializeFinalMock.mockReturnValue({ id: 'downstream_resp_1' });
    recordSurfaceSuccessMock.mockResolvedValue(undefined);

    const { handleOpenAiResponsesSurfaceRequest } = await import('./openAiResponsesSurface.js');

    const request = {
      body: { model: 'gpt-5.4', input: 'hello' },
      headers: {},
    } as any;
    const reply = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn(),
      hijack: vi.fn(),
      raw: {
        statusCode: 200,
        setHeader: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      },
    } as any;

    await handleOpenAiResponsesSurfaceRequest(request, reply, '/v1/responses');

    expect(executeEndpointFlowMock).toHaveBeenCalledTimes(1);
    expect(executeEndpointFlowMock.mock.calls[0]?.[0]?.onDowngrade).toBeUndefined();
    const failureToolkit = createSurfaceFailureToolkitMock.mock.results[0]?.value;
    expect(failureToolkit.handleUpstreamFailure).not.toHaveBeenCalled();
    expect(failureToolkit.log).not.toHaveBeenCalled();
    expect(recordUpstreamEndpointDowngradeMock).toHaveBeenCalledWith(expect.objectContaining({
      failedEndpoint: 'responses',
      recoveredEndpoint: 'chat',
      downstreamFormat: 'responses',
      modelName: 'upstream-model',
      requestedModelHint: 'gpt-5.4',
    }));
    expect(recordSurfaceSuccessMock).toHaveBeenCalledTimes(1);
    expect(reply.send).toHaveBeenCalledWith({ id: 'downstream_resp_1' });
  });
});

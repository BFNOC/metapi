import { beforeEach, describe, expect, it, vi } from 'vitest';

const tokenRouterRecordSuccessMock = vi.fn();
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
const transformRequestMock = vi.fn();
const transformFinalResponseMock = vi.fn();
const serializeFinalResponseMock = vi.fn();
const anthropicTransformRequestMock = vi.fn();
const anthropicTransformFinalResponseMock = vi.fn();
const anthropicSerializeFinalResponseMock = vi.fn();
const getProxyAuthContextMock = vi.fn();
const getProxyResourceOwnerMock = vi.fn();
const resolveOpenAiBodyInputFilesMock = vi.fn();
const buildOauthProviderHeadersMock = vi.fn();
const getOauthInfoFromAccountMock = vi.fn();
const collectResponsesFinalPayloadFromSseMock = vi.fn();
const collectResponsesFinalPayloadFromSseTextMock = vi.fn();
const createSingleChunkStreamReaderMock = vi.fn();
const looksLikeResponsesSseTextMock = vi.fn();
const createGeminiCliStreamReaderMock = vi.fn();
const unwrapGeminiCliPayloadMock = vi.fn((value) => value);
const summarizeConversationFileInputsInOpenAiBodyMock = vi.fn();
const getRuntimeResponseReaderMock = vi.fn();
const readRuntimeResponseTextMock = vi.fn();
const detectDownstreamClientContextMock = vi.fn();
const canRetryProxyChannelMock = vi.fn();
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

vi.mock('../../services/tokenRouter.js', () => ({
  tokenRouter: {
    recordSuccess: (...args: unknown[]) => tokenRouterRecordSuccessMock(...args),
  },
}));

vi.mock('../../services/alertService.js', () => ({
  reportProxyAllFailed: (...args: unknown[]) => reportProxyAllFailedMock(...args),
}));

vi.mock('../../services/proxyUsageParser.js', () => ({
  hasProxyUsagePayload: (...args: any[]) => (hasProxyUsagePayloadMock as any)(...args),
  mergeProxyUsage: (...args: any[]) => (mergeProxyUsageMock as any)(...args),
  parseProxyUsage: (...args: any[]) => (parseProxyUsageMock as any)(...args),
}));

vi.mock('../../routes/proxy/upstreamEndpoint.js', () => ({
  buildClaudeCountTokensUpstreamRequest: vi.fn(),
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

vi.mock('../../transformers/openai/chat/index.js', () => ({
  openAiChatTransformer: {
    transformRequest: (...args: unknown[]) => transformRequestMock(...args),
    transformFinalResponse: (...args: unknown[]) => transformFinalResponseMock(...args),
    serializeFinalResponse: (...args: unknown[]) => serializeFinalResponseMock(...args),
    compatibility: {
      createEndpointStrategy: vi.fn(() => ({
        shouldDowngrade: vi.fn(() => true),
        tryRecover: vi.fn(async () => null),
      })),
    },
  },
}));

vi.mock('../../transformers/anthropic/messages/index.js', () => ({
  anthropicMessagesTransformer: {
    transformRequest: (...args: unknown[]) => anthropicTransformRequestMock(...args),
    transformFinalResponse: (...args: unknown[]) => anthropicTransformFinalResponseMock(...args),
    serializeFinalResponse: (...args: unknown[]) => anthropicSerializeFinalResponseMock(...args),
    compatibility: {
      createEndpointStrategy: vi.fn(() => ({
        shouldDowngrade: vi.fn(() => true),
        tryRecover: vi.fn(async () => null),
      })),
    },
  },
}));

vi.mock('../../middleware/auth.js', () => ({
  getProxyAuthContext: (...args: unknown[]) => getProxyAuthContextMock(...args),
  getProxyResourceOwner: (...args: unknown[]) => getProxyResourceOwnerMock(...args),
}));

vi.mock('../../services/proxyInputFileResolver.js', () => ({
  ProxyInputFileResolutionError: class ProxyInputFileResolutionError extends Error {},
  resolveOpenAiBodyInputFiles: (...args: unknown[]) => resolveOpenAiBodyInputFilesMock(...args),
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
  unwrapGeminiCliPayload: (...args: unknown[]) => (unwrapGeminiCliPayloadMock as any)(...args),
}));

vi.mock('../capabilities/conversationFileCapabilities.js', () => ({
  summarizeConversationFileInputsInOpenAiBody: (...args: any[]) => summarizeConversationFileInputsInOpenAiBodyMock(...args),
}));

vi.mock('../executors/types.js', () => ({
  getRuntimeResponseReader: (...args: unknown[]) => getRuntimeResponseReaderMock(...args),
  readRuntimeResponseText: (...args: unknown[]) => readRuntimeResponseTextMock(...args),
}));

vi.mock('../../routes/proxy/downstreamClientContext.js', () => ({
  detectDownstreamClientContext: (...args: unknown[]) => detectDownstreamClientContextMock(...args),
}));

vi.mock('../../services/proxyChannelRetry.js', () => ({
  canRetryProxyChannel: (...args: unknown[]) => canRetryProxyChannelMock(...args),
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

describe('handleChatSurfaceRequest', () => {
  beforeEach(() => {
    tokenRouterRecordSuccessMock.mockReset();
    reportProxyAllFailedMock.mockReset();
    hasProxyUsagePayloadMock.mockReset();
    hasProxyUsagePayloadMock.mockReturnValue(false);
    parseProxyUsageMock.mockClear();
    mergeProxyUsageMock.mockClear();
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
    transformRequestMock.mockReset();
    transformFinalResponseMock.mockReset();
    serializeFinalResponseMock.mockReset();
    anthropicTransformRequestMock.mockReset();
    anthropicTransformFinalResponseMock.mockReset();
    anthropicSerializeFinalResponseMock.mockReset();
    getProxyAuthContextMock.mockReset();
    getProxyResourceOwnerMock.mockReset();
    resolveOpenAiBodyInputFilesMock.mockReset();
    buildOauthProviderHeadersMock.mockReset();
    getOauthInfoFromAccountMock.mockReset();
    collectResponsesFinalPayloadFromSseMock.mockReset();
    collectResponsesFinalPayloadFromSseTextMock.mockReset();
    createSingleChunkStreamReaderMock.mockReset();
    looksLikeResponsesSseTextMock.mockReset();
    createGeminiCliStreamReaderMock.mockReset();
    unwrapGeminiCliPayloadMock.mockClear();
    summarizeConversationFileInputsInOpenAiBodyMock.mockReset();
    getRuntimeResponseReaderMock.mockReset();
    readRuntimeResponseTextMock.mockReset();
    detectDownstreamClientContextMock.mockReset();
    canRetryProxyChannelMock.mockReset();
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
        parsed: {
          requestedModel: 'gpt-5.4',
          isStream: false,
          upstreamBody: { messages: [{ role: 'user', content: 'hello' }] },
          claudeOriginalBody: undefined,
        },
      },
    });
    ensureModelAllowedForDownstreamKeyMock.mockResolvedValue(true);
    getDownstreamRoutingPolicyMock.mockReturnValue({});
    getProxyResourceOwnerMock.mockReturnValue(null);
    getProxyAuthContextMock.mockReturnValue(null);
    detectDownstreamClientContextMock.mockReturnValue({ clientKind: 'generic' });
    summarizeConversationFileInputsInOpenAiBodyMock.mockReturnValue({
      hasImage: false,
      hasAudio: false,
      hasDocument: false,
      hasRemoteDocumentUrl: false,
    });
    getProxyMaxChannelRetriesMock.mockReturnValue(0);
    buildSurfaceStickySessionKeyMock.mockReturnValue('sticky-chat');
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
    getOauthInfoFromAccountMock.mockReturnValue(null);
    buildOauthProviderHeadersMock.mockReturnValue({});
    resolveUpstreamEndpointCandidatesMock.mockResolvedValue(['chat', 'responses']);
    executeEndpointFlowMock.mockResolvedValue({
      ok: true,
      upstream: new Response(JSON.stringify({ id: 'chatcmpl_1', choices: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      upstreamPath: '/v1/responses',
      successfulEndpoint: 'responses',
      downgraded: true,
      attempts: [
        { endpoint: 'chat', path: '/v1/chat/completions', status: 502, errText: 'bad gateway' },
        { endpoint: 'responses', path: '/v1/responses', status: 200, errText: null },
      ],
    });
    detectProxyFailureMock.mockReturnValue(null);
    readRuntimeResponseTextMock.mockResolvedValue(JSON.stringify({ id: 'chatcmpl_1', choices: [] }));
    transformFinalResponseMock.mockReturnValue({ id: 'normalized' });
    serializeFinalResponseMock.mockReturnValue({ id: 'downstream_chatcmpl_1' });
    recordSurfaceSuccessMock.mockResolvedValue(undefined);

    const { handleChatSurfaceRequest } = await import('./chatSurface.js');

    const request = {
      body: { model: 'gpt-5.4', messages: [{ role: 'user', content: 'hello' }] },
      headers: {},
    } as any;
    const reply = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn(),
      raw: {
        statusCode: 200,
        setHeader: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      },
    } as any;

    await handleChatSurfaceRequest(request, reply, 'openai');

    expect(executeEndpointFlowMock).toHaveBeenCalledTimes(1);
    expect(executeEndpointFlowMock.mock.calls[0]?.[0]?.onDowngrade).toBeUndefined();
    const failureToolkit = createSurfaceFailureToolkitMock.mock.results[0]?.value;
    expect(failureToolkit.handleUpstreamFailure).not.toHaveBeenCalled();
    expect(failureToolkit.log).not.toHaveBeenCalled();
    expect(recordUpstreamEndpointDowngradeMock).toHaveBeenCalledWith(expect.objectContaining({
      failedEndpoint: 'chat',
      recoveredEndpoint: 'responses',
      downstreamFormat: 'openai',
      modelName: 'upstream-model',
      requestedModelHint: 'gpt-5.4',
    }));
    expect(recordSurfaceSuccessMock).toHaveBeenCalledTimes(1);
    expect(reply.send).toHaveBeenCalledWith({ id: 'downstream_chatcmpl_1' });
  });
});

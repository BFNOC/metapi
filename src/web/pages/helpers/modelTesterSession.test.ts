import { describe, expect, it } from 'vitest';
import {
  DEBUG_TABS,
  DEFAULT_INPUTS,
  DEFAULT_PARAMETER_ENABLED,
  MESSAGE_STATUS,
  buildApiPayload,
  collectModelTesterModelNames,
  countConversationTurns,
  filterModelTesterModelNames,
  parseCustomRequestBody,
  parseModelTesterSession,
  serializeModelTesterSession,
  syncMessagesToCustomRequestBody,
  toApiMessages,
  type ModelTesterSessionState,
} from './modelTesterSession.js';

describe('modelTesterSession', () => {
  it('counts only user messages as turns', () => {
    const turns = countConversationTurns([
      { id: '1', role: 'user', content: 'hello', createAt: 1 },
      { id: '2', role: 'assistant', content: 'hi', createAt: 2 },
      { id: '3', role: 'system', content: 'meta', createAt: 3 },
      { id: '4', role: 'user', content: 'again', createAt: 4 },
    ]);
    expect(turns).toBe(2);
  });

  it('serializes and parses full playground session state', () => {
    const state: ModelTesterSessionState = {
      input: 'draft',
      inputs: {
        ...DEFAULT_INPUTS,
        model: 'gpt-4o-mini',
        temperature: 0.6,
        top_p: 0.9,
        max_tokens: 2048,
        frequency_penalty: 0.1,
        presence_penalty: 0.2,
        seed: 12,
        stream: true,
      },
      parameterEnabled: {
        ...DEFAULT_PARAMETER_ENABLED,
        max_tokens: true,
        seed: true,
      },
      messages: [
        { id: 'm1', role: 'user', content: 'hello', createAt: 1 },
        { id: 'm2', role: 'assistant', content: 'hi', createAt: 2, status: MESSAGE_STATUS.COMPLETE },
      ],
      pendingPayload: {
        model: 'gpt-4o-mini',
        stream: true,
        temperature: 0.6,
        top_p: 0.9,
        messages: [{ role: 'user', content: 'hello' }],
      },
      pendingJobId: 'job-1',
      customRequestMode: true,
      customRequestBody: '{"model":"gpt-4o-mini","messages":[]}',
      showDebugPanel: true,
      activeDebugTab: DEBUG_TABS.REQUEST,
    };

    const serialized = serializeModelTesterSession(state);
    const restored = parseModelTesterSession(serialized);

    expect(restored).toEqual(state);
  });

  it('supports parsing legacy session format', () => {
    const restored = parseModelTesterSession(JSON.stringify({
      model: 'gpt-4o',
      temperature: 0.5,
      input: 'legacy',
      messages: [{ role: 'user', content: 'hello' }],
      pendingPayload: null,
    }));

    expect(restored?.inputs.model).toBe('gpt-4o');
    expect(restored?.inputs.temperature).toBe(0.5);
    expect(restored?.parameterEnabled).toEqual(DEFAULT_PARAMETER_ENABLED);
  });

  it('defaults top_p to disabled when parameter switches are missing', () => {
    const restored = parseModelTesterSession(JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
      pendingPayload: null,
    }));

    expect(restored?.parameterEnabled.top_p).toBe(false);
  });

  it('returns null for malformed or missing session payload', () => {
    expect(parseModelTesterSession(null)).toBeNull();
    expect(parseModelTesterSession('not-json')).toBeNull();
    expect(parseModelTesterSession(JSON.stringify({ messages: [] }))).toBeNull();
  });

  it('sanitizes invalid message entries and invalid pending payload', () => {
    const restored = parseModelTesterSession(JSON.stringify({
      inputs: { model: 'gpt-4o', temperature: 99 },
      parameterEnabled: {},
      input: 123,
      messages: [
        { role: 'user', content: 'ok' },
        { role: 'assistant', content: 123 },
        { role: 'unknown', content: 'bad role' },
        { content: 'missing role' },
      ],
      pendingPayload: {
        model: 123,
        messages: [{ role: 'user', content: 'still here' }],
      },
    }));

    expect(restored?.inputs.model).toBe('gpt-4o');
    expect(restored?.input).toBe('');
    expect(restored?.pendingPayload).toBeNull();
    expect(restored?.messages).toHaveLength(1);
    expect(restored?.messages[0]).toMatchObject({ role: 'user', content: 'ok' });
  });

  it('finalizes loading messages if no pending job remains', () => {
    const restored = parseModelTesterSession(JSON.stringify({
      inputs: { ...DEFAULT_INPUTS, model: 'gpt-4o' },
      parameterEnabled: DEFAULT_PARAMETER_ENABLED,
      input: '',
      messages: [{
        id: 'm-loading',
        role: 'assistant',
        content: '<think>reasoning...</think>final',
        createAt: 1,
        status: 'loading',
      }],
      pendingPayload: null,
      pendingJobId: null,
    }));

    expect(restored?.messages[0].status).toBe(MESSAGE_STATUS.COMPLETE);
    expect(restored?.messages[0].content).toBe('final');
  });

  it('drops loading assistant placeholders when building API payload messages', () => {
    const payloadMessages = toApiMessages([
      { id: '1', role: 'user', content: 'hello', createAt: 1 },
      { id: '2', role: 'assistant', content: '', createAt: 2, status: MESSAGE_STATUS.LOADING },
      { id: '3', role: 'assistant', content: 'done', createAt: 3, status: MESSAGE_STATUS.COMPLETE },
    ]);

    expect(payloadMessages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'done' },
    ]);
  });

  it('builds payload with parameter enable switches', () => {
    const payload = buildApiPayload(
      [{ id: 'u1', role: 'user', content: 'hello', createAt: 1 }],
      {
        ...DEFAULT_INPUTS,
        model: 'gpt-4o-mini',
        temperature: 0.5,
        top_p: 0.8,
        max_tokens: 200,
        frequency_penalty: 0.2,
        presence_penalty: 0.3,
        seed: 42,
        stream: true,
      },
      {
        temperature: true,
        top_p: false,
        max_tokens: true,
        frequency_penalty: true,
        presence_penalty: false,
        seed: true,
      },
    );

    expect(payload).toEqual({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
      targetFormat: 'openai',
      stream: true,
      temperature: 0.5,
      max_tokens: 200,
      frequency_penalty: 0.2,
      seed: 42,
    });
  });

  it('parses and syncs custom request body', () => {
    const parsed = parseCustomRequestBody('{"model":"gpt-4o","messages":[{"role":"user","content":"x"}],"stream":true}');
    expect(parsed?.model).toBe('gpt-4o');
    expect(parsed?.stream).toBe(true);

    const synced = syncMessagesToCustomRequestBody(
      '{"model":"legacy"}',
      [{ id: '1', role: 'user', content: 'new', createAt: 1 }],
      { ...DEFAULT_INPUTS, model: 'gpt-4o' },
    );

    const syncedJson = JSON.parse(synced);
    expect(syncedJson.model).toBe('legacy');
    expect(syncedJson.messages).toEqual([{ role: 'user', content: 'new' }]);
  });

  it('keeps responses target format in custom payload sync', () => {
    const synced = syncMessagesToCustomRequestBody(
      '{"model":"gpt-5.2","targetFormat":"responses"}',
      [{ id: '1', role: 'user', content: 'hello', createAt: 1 }],
      { ...DEFAULT_INPUTS, model: 'gpt-5.2', targetFormat: 'openai' },
    );

    const syncedJson = JSON.parse(synced);
    expect(syncedJson.targetFormat).toBe('responses');
  });

  it('merges marketplace models with exact enabled route models for tester options', () => {
    const modelNames = collectModelTesterModelNames(
      {
        models: [
          { name: 'gpt-4o-mini' },
          { name: 'bge-large-en-v1.5' },
        ],
      },
      [
        { modelPattern: 'BAAI/bge-large-en-v1.5', enabled: true },
        { modelPattern: 'claude-*', enabled: true },
        { modelPattern: 'gemini-2.5-pro', enabled: false },
      ],
    );

    expect(modelNames).toEqual([
      'gpt-4o-mini',
      'bge-large-en-v1.5',
      'BAAI/bge-large-en-v1.5',
    ]);
  });

  it('deduplicates repeated model names when merging model sources', () => {
    const modelNames = collectModelTesterModelNames(
      {
        models: [
          { name: 'gpt-4o-mini' },
          { name: 'gpt-4o-mini' },
        ],
      },
      [
        { modelPattern: 'gpt-4o-mini', enabled: true },
      ],
    );

    expect(modelNames).toEqual(['gpt-4o-mini']);
  });

  it('filters models by keyword and keeps best matches first', () => {
    const filtered = filterModelTesterModelNames(
      [
        'BAAI/bge-large-en-v1.5',
        'text-embedding-3-large',
        'bge-m3',
      ],
      'bge',
    );

    expect(filtered).toEqual([
      'bge-m3',
      'BAAI/bge-large-en-v1.5',
    ]);
  });

  it('returns all models unchanged when keyword is empty', () => {
    const filtered = filterModelTesterModelNames(
      ['gpt-4o', 'claude-3-5-haiku-20241022'],
      '   ',
    );

    expect(filtered).toEqual(['gpt-4o', 'claude-3-5-haiku-20241022']);
  });
});

import { describe, expect, it } from 'vitest';

import {
  convertOpenAiBodyToResponsesBody,
  convertResponsesBodyToOpenAiBody,
  sanitizeResponsesBodyForProxy,
} from './conversion.js';

describe('sanitizeResponsesBodyForProxy', () => {
  it('preserves newer Responses request fields needed by the proxy', () => {
    const result = sanitizeResponsesBodyForProxy(
      {
        model: 'gpt-5',
        input: 'hello',
        safety_identifier: 'safe-user-1',
        max_tool_calls: 3,
        prompt_cache_key: 'cache-key',
        prompt_cache_retention: { scope: 'session' },
        stream_options: { include_obfuscation: true },
        background: true,
        text: { format: { type: 'text' }, verbosity: 'high' },
        top_logprobs: 2,
      },
      'gpt-5',
      true,
    );

    expect(result).toMatchObject({
      model: 'gpt-5',
      stream: true,
      safety_identifier: 'safe-user-1',
      max_tool_calls: 3,
      prompt_cache_key: 'cache-key',
      prompt_cache_retention: { scope: 'session' },
      stream_options: { include_obfuscation: true },
      background: true,
      text: { format: { type: 'text' }, verbosity: 'high' },
      top_logprobs: 2,
    });
  });

  it('normalizes current Responses inbound parity fields', () => {
    const result = sanitizeResponsesBodyForProxy(
      {
        input: 'hello',
        safety_identifier: '  safe-user-4  ',
        max_tool_calls: '5',
        prompt_cache_key: '  cache-key-2 ',
        prompt_cache_retention: ' 24h ',
        stream_options: { include_obfuscation: 'true', extra: 'keep-me' },
        background: 'false',
        text: { format: { type: 'text' }, verbosity: ' high ' },
        truncation: ' auto ',
        previous_response_id: ' resp_prev_2 ',
        include: [' reasoning.encrypted_content ', '', 123, 'message.input_image.image_url'],
        top_logprobs: '7',
        user: '  user-456 ',
        service_tier: ' priority ',
      },
      'gpt-5',
      false,
    );

    expect(result).toMatchObject({
      model: 'gpt-5',
      stream: false,
      safety_identifier: 'safe-user-4',
      max_tool_calls: 5,
      prompt_cache_key: 'cache-key-2',
      prompt_cache_retention: '24h',
      stream_options: { include_obfuscation: true, extra: 'keep-me' },
      background: false,
      text: { format: { type: 'text' }, verbosity: 'high' },
      truncation: 'auto',
      previous_response_id: 'resp_prev_2',
      include: ['reasoning.encrypted_content', 'message.input_image.image_url'],
      top_logprobs: 7,
      user: 'user-456',
      service_tier: 'priority',
    });
  });
});

describe('convertOpenAiBodyToResponsesBody', () => {
  it('maps extra request fields and preserves custom/image_generation tools', () => {
    const result = convertOpenAiBodyToResponsesBody(
      {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'draw a cat' }],
        safety_identifier: 'safe-user-2',
        max_tool_calls: 2,
        prompt_cache_key: 'prompt-key',
        prompt_cache_retention: { scope: 'workspace' },
        stream_options: { include_obfuscation: true },
        background: false,
        verbosity: 'low',
        tools: [
          {
            type: 'custom',
            name: 'browser',
            description: 'browse the web',
            format: { type: 'text' },
          },
          {
            type: 'image_generation',
            background: 'transparent',
            size: '1024x1024',
          },
        ],
      },
      'gpt-5',
      false,
    );

    expect(result).toMatchObject({
      model: 'gpt-5',
      stream: false,
      safety_identifier: 'safe-user-2',
      max_tool_calls: 2,
      prompt_cache_key: 'prompt-key',
      prompt_cache_retention: { scope: 'workspace' },
      stream_options: { include_obfuscation: true },
      background: false,
      text: { verbosity: 'low' },
      tools: [
        {
          type: 'custom',
          name: 'browser',
          description: 'browse the web',
          format: { type: 'text' },
        },
        {
          type: 'image_generation',
          background: 'transparent',
          size: '1024x1024',
        },
      ],
    });
  });

  it('maps OpenAI response_format into Responses text.format while preserving verbosity', () => {
    const result = convertOpenAiBodyToResponsesBody(
      {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'return structured data' }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'payload',
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
              },
              required: ['name'],
            },
          },
        },
        verbosity: 'high',
      },
      'gpt-5',
      false,
    );

    expect(result).toMatchObject({
      text: {
        format: {
          type: 'json_schema',
          json_schema: {
            name: 'payload',
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
              },
              required: ['name'],
            },
          },
        },
        verbosity: 'high',
      },
    });
  });

  it('normalizes and preserves field parity when converting from OpenAI-compatible input', () => {
    const result = convertOpenAiBodyToResponsesBody(
      {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hello' }],
        safety_identifier: '  safe-user-5 ',
        max_tool_calls: '6',
        prompt_cache_key: '  cache-key-3 ',
        prompt_cache_retention: ' in-memory ',
        stream_options: { include_obfuscation: 'false' },
        background: 'true',
        verbosity: ' medium ',
        truncation: ' disabled ',
        previous_response_id: ' resp_prev_3 ',
        include: 'reasoning.encrypted_content',
        top_logprobs: '4',
        user: ' user-789 ',
        service_tier: ' flex ',
      },
      'gpt-5',
      true,
    );

    expect(result).toMatchObject({
      model: 'gpt-5',
      stream: true,
      safety_identifier: 'safe-user-5',
      max_tool_calls: 6,
      prompt_cache_key: 'cache-key-3',
      prompt_cache_retention: 'in-memory',
      stream_options: { include_obfuscation: false },
      background: true,
      text: { verbosity: 'medium' },
      truncation: 'disabled',
      previous_response_id: 'resp_prev_3',
      include: ['reasoning.encrypted_content'],
      top_logprobs: 4,
      user: 'user-789',
      service_tier: 'flex',
    });
  });
});

describe('convertResponsesBodyToOpenAiBody', () => {
  it('preserves richer Responses request fields back onto the OpenAI-compatible body', () => {
    const result = convertResponsesBodyToOpenAiBody(
      {
        model: 'gpt-5',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
        safety_identifier: 'safe-user-3',
        max_tool_calls: 4,
        prompt_cache_key: 'prompt-key-2',
        prompt_cache_retention: { scope: 'project' },
        stream_options: { include_obfuscation: true },
        background: true,
        text: { format: { type: 'json_object' }, verbosity: 'high' },
        tools: [
          {
            type: 'custom',
            name: 'browser',
            format: { type: 'grammar', syntax: 'lark' },
          },
          {
            type: 'image_generation',
            background: 'transparent',
            partial_images: 2,
            output_format: 'png',
          },
        ],
      },
      'gpt-5',
      true,
    );

    expect(result).toMatchObject({
      model: 'gpt-5',
      stream: true,
      safety_identifier: 'safe-user-3',
      max_tool_calls: 4,
      prompt_cache_key: 'prompt-key-2',
      prompt_cache_retention: { scope: 'project' },
      stream_options: { include_obfuscation: true },
      background: true,
      verbosity: 'high',
      tools: [
        {
          type: 'custom',
          name: 'browser',
          format: { type: 'grammar', syntax: 'lark' },
        },
        {
          type: 'image_generation',
          background: 'transparent',
          partial_images: 2,
          output_format: 'png',
        },
      ],
    });
  });

  it('converts custom tool calls and outputs into OpenAI-compatible tool messages', () => {
    const result = convertResponsesBodyToOpenAiBody(
      {
        model: 'gpt-5',
        input: [
          {
            type: 'custom_tool_call',
            id: 'ct_1',
            call_id: 'ct_1',
            name: 'browser',
            input: 'open example.com',
          },
          {
            type: 'custom_tool_call_output',
            call_id: 'ct_1',
            output: 'done',
          },
        ],
      },
      'gpt-5',
      false,
    );

    expect(result.messages).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'ct_1',
            type: 'function',
            function: {
              name: 'browser',
              arguments: 'open example.com',
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'ct_1',
        content: 'done',
      },
    ]);
  });

  it('converts reasoning items back into assistant content instead of dropping them', () => {
    const result = convertResponsesBodyToOpenAiBody(
      {
        model: 'gpt-5',
        input: [
          {
            type: 'reasoning',
            id: 'rs_1',
            status: 'completed',
            summary: [
              { type: 'summary_text', text: 'Think step by step' },
            ],
          },
        ],
      },
      'gpt-5',
      false,
    );

    expect(result.messages).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Think step by step',
          },
        ],
      },
    ]);
  });

  it('preserves remaining request fields needed for OpenAI-compatible downstream fallback', () => {
    const result = convertResponsesBodyToOpenAiBody(
      {
        model: 'gpt-5',
        input: 'hello',
        user: 'user-123',
        include: ['reasoning.encrypted_content'],
        previous_response_id: 'resp_prev',
        truncation: 'auto',
        service_tier: 'priority',
        top_logprobs: 4,
      },
      'gpt-5',
      true,
    );

    expect(result).toMatchObject({
      model: 'gpt-5',
      stream: true,
      user: 'user-123',
      include: ['reasoning.encrypted_content'],
      previous_response_id: 'resp_prev',
      truncation: 'auto',
      service_tier: 'priority',
      top_logprobs: 4,
    });
  });

  it('maps Responses text.format back into OpenAI response_format', () => {
    const result = convertResponsesBodyToOpenAiBody(
      {
        model: 'gpt-5',
        input: 'hello',
        text: {
          format: {
            type: 'json_schema',
            json_schema: {
              name: 'payload',
              schema: {
                type: 'object',
                properties: {
                  value: { type: 'string' },
                },
              },
            },
          },
          verbosity: 'medium',
        },
      },
      'gpt-5',
      false,
    );

    expect(result).toMatchObject({
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'payload',
          schema: {
            type: 'object',
            properties: {
              value: { type: 'string' },
            },
          },
        },
      },
      verbosity: 'medium',
    });
  });

  it('normalizes field parity when converting Responses input back to OpenAI-compatible input', () => {
    const result = convertResponsesBodyToOpenAiBody(
      {
        model: 'gpt-5',
        input: 'hello',
        safety_identifier: '  safe-user-6 ',
        max_tool_calls: '8',
        prompt_cache_key: '  cache-key-4 ',
        prompt_cache_retention: ' 24h ',
        stream_options: { include_obfuscation: 'true' },
        background: 'false',
        text: { verbosity: ' low ' },
        truncation: ' auto ',
        previous_response_id: ' resp_prev_4 ',
        include: [' reasoning.encrypted_content ', ''],
        top_logprobs: '9',
        user: ' user-999 ',
        service_tier: ' default ',
      },
      'gpt-5',
      false,
    );

    expect(result).toMatchObject({
      model: 'gpt-5',
      stream: false,
      safety_identifier: 'safe-user-6',
      max_tool_calls: 8,
      prompt_cache_key: 'cache-key-4',
      prompt_cache_retention: '24h',
      stream_options: { include_obfuscation: true },
      background: false,
      verbosity: 'low',
      truncation: 'auto',
      previous_response_id: 'resp_prev_4',
      include: ['reasoning.encrypted_content'],
      top_logprobs: 9,
      user: 'user-999',
      service_tier: 'default',
    });
  });
});

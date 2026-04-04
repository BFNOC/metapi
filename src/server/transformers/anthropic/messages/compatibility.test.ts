import { describe, expect, it } from 'vitest';

import { shouldPreferResponsesForAnthropicContinuation } from './compatibility.js';

describe('anthropic continuation compatibility', () => {
  it('prefers responses for continuation requests with orphan tool_result blocks', () => {
    expect(shouldPreferResponsesForAnthropicContinuation({
      previous_response_id: 'resp_prev_1',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_1',
              content: 'done',
            },
          ],
        },
      ],
    })).toBe(true);
  });

  it('accepts prompt_cache_key or metadata.user_id as continuation hints', () => {
    expect(shouldPreferResponsesForAnthropicContinuation({
      prompt_cache_key: 'cache-key-1',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_2',
              content: 'done',
            },
          ],
        },
      ],
    })).toBe(true);

    expect(shouldPreferResponsesForAnthropicContinuation({
      metadata: { user_id: 'user-1' },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_3',
              content: 'done',
            },
          ],
        },
      ],
    })).toBe(true);
  });

  it('does not prefer responses without a continuation hint', () => {
    expect(shouldPreferResponsesForAnthropicContinuation({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_1',
              content: 'done',
            },
          ],
        },
      ],
    })).toBe(false);
  });

  it('does not treat matched assistant tool_use blocks as orphan tool results', () => {
    expect(shouldPreferResponsesForAnthropicContinuation({
      previous_response_id: 'resp_prev_1',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool_1',
              name: 'lookup',
              input: { topic: 'cat' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_1',
              content: 'done',
            },
          ],
        },
      ],
    })).toBe(false);
  });
});

import {
  createClaudeDownstreamContext,
  createStreamTransformContext,
  normalizeUpstreamStreamEvent,
  pullSseEventsWithDone,
  serializeNormalizedStreamEvent,
  serializeStreamDone,
  type ClaudeDownstreamContext,
  type StreamTransformContext,
} from '../../shared/normalized.js';
import { extractChatChoiceEvents, extractChatResponseExtras } from './helpers.js';
import type { OpenAiChatNormalizedStreamEvent } from './model.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseSerializedSse(lines: string[]): Array<{ index: number; payload: Record<string, unknown> }> {
  return lines
    .map((line, index) => {
      if (!line.startsWith('data: ') || line.trim() === 'data: [DONE]') return null;
      try {
        return {
          index,
          payload: JSON.parse(line.slice(6)) as Record<string, unknown>,
        };
      } catch {
        return null;
      }
    })
    .filter((item): item is { index: number; payload: Record<string, unknown> } => !!item);
}

export const openAiChatStream = {
  createContext(modelName: string): StreamTransformContext {
    return createStreamTransformContext(modelName);
  },
  normalizeEvent(payload: unknown, context: StreamTransformContext, modelName: string): OpenAiChatNormalizedStreamEvent {
    const choiceEvents = extractChatChoiceEvents(payload);
    const primaryChoice = choiceEvents[0];
    return {
      ...normalizeUpstreamStreamEvent(payload, context, modelName),
      ...(primaryChoice
        ? {
          choiceIndex: primaryChoice.index,
          role: primaryChoice.role,
          contentDelta: primaryChoice.contentDelta,
          reasoningDelta: primaryChoice.reasoningDelta,
          toolCallDeltas: primaryChoice.toolCallDeltas,
          finishReason: primaryChoice.finishReason,
          annotations: primaryChoice.annotations,
          citations: primaryChoice.citations,
        }
        : {}),
      ...(choiceEvents.length > 0 ? { choiceEvents } : {}),
      ...extractChatResponseExtras(payload),
    };
  },
  serializeEvent(
    event: OpenAiChatNormalizedStreamEvent,
    context: StreamTransformContext,
    downstreamContext?: ClaudeDownstreamContext,
  ): string[] {
    if (
      Array.isArray(event.choiceEvents)
      && event.choiceEvents.length > 0
      && (event.choiceEvents.length > 1 || event.choiceEvents[0]?.index !== 0)
    ) {
      const usagePayload = event.usagePayload
        ? {
          ...(isRecord(event.usagePayload) ? event.usagePayload : {}),
          ...(event.usageDetails?.prompt_tokens_details
            ? { prompt_tokens_details: event.usageDetails.prompt_tokens_details }
            : {}),
          ...(event.usageDetails?.completion_tokens_details
            ? { completion_tokens_details: event.usageDetails.completion_tokens_details }
            : {}),
        }
        : undefined;
      return [`data: ${JSON.stringify({
        id: context.id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: context.created,
        model: context.model,
        choices: event.choiceEvents
          .map((choiceEvent) => {
            const delta: Record<string, unknown> = {};
            if (choiceEvent.role) delta.role = choiceEvent.role;
            if (choiceEvent.contentDelta !== undefined) delta.content = choiceEvent.contentDelta;
            if (choiceEvent.reasoningDelta) delta.reasoning_content = choiceEvent.reasoningDelta;
            if (Array.isArray(choiceEvent.toolCallDeltas) && choiceEvent.toolCallDeltas.length > 0) {
              delta.tool_calls = choiceEvent.toolCallDeltas.map((toolCall) => ({
                index: toolCall.index,
                ...(toolCall.id ? { id: toolCall.id } : {}),
                type: 'function',
                function: {
                  ...(toolCall.name ? { name: toolCall.name } : {}),
                  ...(toolCall.argumentsDelta !== undefined ? { arguments: toolCall.argumentsDelta } : {}),
                },
              }));
            }
            if (Array.isArray(choiceEvent.annotations) && choiceEvent.annotations.length > 0) {
              delta.annotations = choiceEvent.annotations;
            }

            return {
              index: choiceEvent.index,
              delta,
              finish_reason: choiceEvent.finishReason ?? null,
            };
          })
          .sort((left, right) => left.index - right.index),
        ...(Array.isArray(event.citations) && event.citations.length > 0 ? { citations: event.citations } : {}),
        ...(usagePayload && Object.keys(usagePayload).length > 0 ? { usage: usagePayload } : {}),
      })}\n\n`];
    }

    const lines = serializeNormalizedStreamEvent(
      'openai',
      event,
      context,
      downstreamContext ?? createClaudeDownstreamContext(),
    );

    if (
      (!Array.isArray(event.annotations) || event.annotations.length <= 0)
      && (!Array.isArray(event.citations) || event.citations.length <= 0)
      && !event.usagePayload
      && !event.usageDetails
    ) {
      return lines;
    }

    const parsedEvents = parseSerializedSse(lines);
    if (parsedEvents.length <= 0) return lines;

    for (const parsed of parsedEvents) {
      const payload = parsed.payload;
      if (Array.isArray(event.citations) && event.citations.length > 0) {
        payload.citations = event.citations;
      }

      const firstChoice = Array.isArray(payload.choices) ? payload.choices[0] : null;
      if (Array.isArray(event.annotations) && event.annotations.length > 0 && isRecord(firstChoice) && isRecord(firstChoice.delta)) {
        firstChoice.delta.annotations = event.annotations;
      }

      if (event.usagePayload || event.usageDetails) {
        payload.usage = {
          ...(isRecord(event.usagePayload) ? event.usagePayload : {}),
          ...(event.usageDetails?.prompt_tokens_details
            ? { prompt_tokens_details: event.usageDetails.prompt_tokens_details }
            : {}),
          ...(event.usageDetails?.completion_tokens_details
            ? { completion_tokens_details: event.usageDetails.completion_tokens_details }
            : {}),
        };
      }

      lines[parsed.index] = `data: ${JSON.stringify(payload)}\n\n`;
    }

    return lines;
  },
  serializeDone(
    context: StreamTransformContext,
    downstreamContext?: ClaudeDownstreamContext,
  ): string[] {
    return serializeStreamDone(
      'openai',
      context,
      downstreamContext ?? createClaudeDownstreamContext(),
    );
  },
  pullSseEvents(buffer: string) {
    return pullSseEventsWithDone(buffer);
  },
};

import type { DownstreamFormat } from '../transformers/shared/normalized.js';

export const ALL_UPSTREAM_ENDPOINTS = ['chat', 'messages', 'responses'] as const;

export type UpstreamEndpoint = (typeof ALL_UPSTREAM_ENDPOINTS)[number];
export type EndpointPreference = DownstreamFormat | 'responses';

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeUpstreamEndpointTypes(value: unknown): UpstreamEndpoint[] {
  const raw = asTrimmedString(value).toLowerCase();
  if (!raw) return [];

  const normalized = new Set<UpstreamEndpoint>();

  if (
    raw.includes('/v1/messages')
    || raw === 'messages'
    || raw.includes('anthropic')
    || raw.includes('claude')
  ) {
    normalized.add('messages');
  }

  if (
    raw.includes('/v1/responses')
    || raw === 'responses'
    || raw.includes('response')
  ) {
    normalized.add('responses');
  }

  if (
    raw.includes('/v1/chat/completions')
    || raw.includes('chat/completions')
    || raw === 'chat'
    || raw === 'chat_completions'
    || raw === 'completions'
    || raw.includes('chat')
  ) {
    normalized.add('chat');
  }

  // Some upstreams report protocol families instead of concrete endpoint paths.
  if (raw === 'openai' || raw.includes('openai')) {
    normalized.add('chat');
    normalized.add('responses');
  }

  return Array.from(normalized);
}

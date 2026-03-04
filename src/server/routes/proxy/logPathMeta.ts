type ComposeProxyLogMessageArgs = {
  downstreamPath?: string | null;
  upstreamPath?: string | null;
  errorMessage?: string | null;
};

type ParsedPathMeta = {
  downstreamPath: string | null;
  upstreamPath: string | null;
  messageText: string;
};

function parseExistingPathMeta(rawMessage: string): ParsedPathMeta {
  const downstreamMatch = rawMessage.match(/\[downstream:([^\]]+)\]/i);
  const upstreamMatch = rawMessage.match(/\[upstream:([^\]]+)\]/i);
  const messageText = rawMessage.replace(/^\s*(?:\[(?:downstream|upstream):[^\]]+\]\s*)+/i, '').trim();
  return {
    downstreamPath: downstreamMatch?.[1]?.trim() || null,
    upstreamPath: upstreamMatch?.[1]?.trim() || null,
    messageText,
  };
}

export function composeProxyLogMessage({
  downstreamPath,
  upstreamPath,
  errorMessage,
}: ComposeProxyLogMessageArgs): string | null {
  const rawMessage = typeof errorMessage === 'string' ? errorMessage.trim() : '';
  const parsed = parseExistingPathMeta(rawMessage);
  const finalDownstreamPath = (downstreamPath || parsed.downstreamPath || '').trim();
  const finalUpstreamPath = (upstreamPath || parsed.upstreamPath || '').trim();
  const finalMessageText = parsed.messageText.trim();

  const prefixParts: string[] = [];
  if (finalDownstreamPath) prefixParts.push(`[downstream:${finalDownstreamPath}]`);
  if (finalUpstreamPath) prefixParts.push(`[upstream:${finalUpstreamPath}]`);

  if (prefixParts.length === 0 && !finalMessageText) return null;
  if (finalMessageText) return `${prefixParts.join(' ')} ${finalMessageText}`.trim();
  return prefixParts.join(' ');
}

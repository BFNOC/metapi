import { fetch } from 'undici';

export type ProbeResult = {
  modelName: string;
  status: 'ok' | 'timeout' | 'error';
  ttftMs: number | null;
  httpStatus: number | null;
  error: string | null;
  responseText: string | null;
};

export type ProbeInput = {
  siteUrl: string;
  apiToken: string;
  modelNames: string[];
  prompt: string;
  concurrency: number;
  timeoutMs: number;
  delayMs: number;
};

export type ProbeCallbacks = {
  onResult?: (result: ProbeResult) => void;
};

function extractSseContentTokens(raw: string): string {
  let result = '';
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data: ')) continue;
    const payload = trimmed.slice(6);
    if (payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload);
      const delta = parsed?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') result += delta;
    } catch { /* skip malformed */ }
  }
  return result;
}

async function probeSingleModel(
  siteUrl: string,
  apiToken: string,
  modelName: string,
  prompt: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startTime = Date.now();

  try {
    const normalizedBase = siteUrl.replace(/\/+$/, '');
    const response = await fetch(`${normalizedBase}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      clearTimeout(timer);
      let errorBody: string | null = null;
      try {
        const raw = await response.text();
        if (raw) {
          // Try to extract message from JSON error responses (NewAPI style)
          try {
            const parsed = JSON.parse(raw);
            const msg = parsed?.error?.message || parsed?.message || parsed?.error;
            if (typeof msg === 'string') {
              errorBody = msg.slice(0, 350);
            }
          } catch { /* not JSON */ }
          if (!errorBody) {
            errorBody = raw.slice(0, 350);
          }
        }
      } catch { /* ignore read errors */ }
      return {
        modelName,
        status: 'error',
        ttftMs: Date.now() - startTime,
        httpStatus: response.status,
        error: errorBody || `HTTP ${response.status}`,
        responseText: errorBody,
      };
    }

    const reader = response.body?.getReader();
    if (!reader) {
      clearTimeout(timer);
      return {
        modelName,
        status: 'error',
        ttftMs: Date.now() - startTime,
        httpStatus: response.status,
        error: 'No response body',
        responseText: null,
      };
    }

    // Read the full stream and extract response content
    const decoder = new TextDecoder();
    let ttftMs: number | null = null;
    let gotData = false;
    let rawStream = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (ttftMs === null) {
          ttftMs = Date.now() - startTime;
        }
        if (done) break;
        gotData = true;
        rawStream += decoder.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }

    clearTimeout(timer);

    const responseText = extractSseContentTokens(rawStream) || null;

    return {
      modelName,
      status: gotData ? 'ok' : 'error',
      ttftMs,
      httpStatus: response.status,
      error: gotData ? null : 'Stream ended immediately',
      responseText,
    };
  } catch (error: any) {
    clearTimeout(timer);
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
      return {
        modelName,
        status: 'timeout',
        ttftMs: timeoutMs,
        httpStatus: null,
        error: `Timeout after ${timeoutMs}ms`,
        responseText: null,
      };
    }
    return {
      modelName,
      status: 'error',
      ttftMs: Date.now() - startTime,
      httpStatus: null,
      error: error?.message || 'Unknown error',
      responseText: null,
    };
  }
}

export async function probeModels(input: ProbeInput, callbacks?: ProbeCallbacks): Promise<ProbeResult[]> {
  const {
    siteUrl,
    apiToken,
    modelNames,
    prompt = 'hi',
    concurrency = 3,
    timeoutMs = 15000,
    delayMs = 0,
  } = input;

  const clampedConcurrency = Math.max(1, Math.min(10, concurrency));
  const clampedTimeout = Math.max(1000, Math.min(60000, timeoutMs));
  const clampedDelay = Math.max(0, Math.min(10000, delayMs));
  const results: ProbeResult[] = [];

  for (let offset = 0; offset < modelNames.length; offset += clampedConcurrency) {
    if (offset > 0 && clampedDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, clampedDelay));
    }
    const batch = modelNames.slice(offset, offset + clampedConcurrency);
    const batchResults = await Promise.all(
      batch.map((modelName) =>
        probeSingleModel(siteUrl, apiToken, modelName, prompt, clampedTimeout),
      ),
    );
    for (const r of batchResults) {
      results.push(r);
      callbacks?.onResult?.(r);
    }
  }

  return results;
}

import { fetch, type Dispatcher } from 'undici';
import { pickRandomProbePrompt } from '../../shared/probePrompts.js';

export type ProbeResult = {
  modelName: string;
  status: 'supported' | 'unsupported' | 'inconclusive' | 'skipped';
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
  signal?: AbortSignal;
  /** Optional undici Dispatcher (e.g. ProxyAgent) resolved from site proxy config */
  dispatcher?: Dispatcher;
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

function isUnsupportedModelError(status: number, errorBody: string | null): boolean {
  if (status === 404) return true;
  if (!errorBody) return false;
  const normalized = errorBody.toLowerCase();
  return (
    normalized.includes('model not found')
    || normalized.includes('unsupported model')
    || normalized.includes('does not exist')
    || normalized.includes('not support this model')
    || normalized.includes('not a supported model')
    || normalized.includes('model_not_found')
    || normalized.includes('unsupported_model')
  );
}

function classifyHttpFailure(status: number, errorBody: string | null): ProbeResult['status'] {
  if (status === 401 || status === 403 || status === 429) return 'skipped';
  if (isUnsupportedModelError(status, errorBody)) return 'unsupported';
  if (status >= 500) return 'inconclusive';
  return 'inconclusive';
}

async function probeSingleModel(
  siteUrl: string,
  apiToken: string,
  modelName: string,
  prompt: string,
  timeoutMs: number,
  externalSignal?: AbortSignal,
  dispatcher?: Dispatcher,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startTime = Date.now();

  // Track whether abort was caused by external signal (client disconnect)
  // vs internal timeout — avoids race window when checking externalSignal.aborted
  let abortedByExternal = false;
  let cleanupExternalSignal = () => {};
  if (externalSignal) {
    if (externalSignal.aborted) {
      abortedByExternal = true;
      controller.abort();
    } else {
      const abortHandler = () => {
        abortedByExternal = true;
        controller.abort();
      };
      externalSignal.addEventListener('abort', abortHandler, { once: true });
      cleanupExternalSignal = () => externalSignal.removeEventListener('abort', abortHandler);
    }
  }

  try {
    const normalizedBase = siteUrl.replace(/\/+$/, '');
    const fetchOptions: Parameters<typeof fetch>[1] = {
      method: 'POST',
      headers: {
        'accept': '*/*',
        'accept-language': 'zh-CN',
        'content-type': 'application/json',
        'authorization': `Bearer ${apiToken}`,
        'x-api-key': apiToken,
        'http-referer': 'https://cherry-ai.com',
        'x-title': 'Cherry Studio',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) CherryStudio/1.8.1 Chrome/144.0.7559.236 Electron/40.8.0 Safari/537.36',
        'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Linux"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'cross-site',
        'priority': 'u=1, i',
      },
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
      }),
      signal: controller.signal,
    };
    if (dispatcher) {
      (fetchOptions as any).dispatcher = dispatcher;
    }
    const response = await fetch(`${normalizedBase}/v1/chat/completions`, fetchOptions);

    if (!response.ok) {
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
        status: classifyHttpFailure(response.status, errorBody),
        ttftMs: Date.now() - startTime,
        httpStatus: response.status,
        error: errorBody || `HTTP ${response.status}`,
        responseText: errorBody,
      };
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return {
        modelName,
        status: 'inconclusive',
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

    const responseText = extractSseContentTokens(rawStream) || null;

    return {
      modelName,
      status: gotData ? 'supported' : 'inconclusive',
      ttftMs,
      httpStatus: response.status,
      error: gotData ? null : 'Stream ended immediately',
      responseText,
    };
  } catch (error: any) {
    // Distinguish external abort (client disconnect) from timeout
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
      if (abortedByExternal) {
        return {
          modelName,
          status: 'skipped',
          ttftMs: Date.now() - startTime,
          httpStatus: null,
          error: 'Client disconnected',
          responseText: null,
        };
      }
      return {
        modelName,
        status: 'inconclusive',
        ttftMs: timeoutMs,
        httpStatus: null,
        error: `Timeout after ${timeoutMs}ms`,
        responseText: null,
      };
    }
    return {
      modelName,
      status: 'inconclusive',
      ttftMs: Date.now() - startTime,
      httpStatus: null,
      error: error?.message || 'Unknown error',
      responseText: null,
    };
  } finally {
    clearTimeout(timer);
    cleanupExternalSignal();
  }
}

export async function probeModels(input: ProbeInput, callbacks?: ProbeCallbacks): Promise<ProbeResult[]> {
  const {
    siteUrl,
    apiToken,
    modelNames,
    prompt = pickRandomProbePrompt(),
    concurrency = 3,
    timeoutMs = 30000,
    delayMs = 0,
    signal,
  } = input;

  const clampedConcurrency = Math.max(1, Math.min(10, concurrency));
  const clampedTimeout = Math.max(1000, Math.min(60000, timeoutMs));
  const clampedDelay = Math.max(0, Math.min(10000, delayMs));
  const results: ProbeResult[] = [];

  for (let offset = 0; offset < modelNames.length; offset += clampedConcurrency) {
    // Stop probing if the caller (client) disconnected
    if (signal?.aborted) break;

    if (offset > 0 && clampedDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, clampedDelay));
    }

    // Re-check after delay
    if (signal?.aborted) break;

    const batch = modelNames.slice(offset, offset + clampedConcurrency);
    const batchResults = await Promise.all(
      batch.map((modelName) =>
        probeSingleModel(siteUrl, apiToken, modelName, prompt, clampedTimeout, signal, input.dispatcher),
      ),
    );
    for (const r of batchResults) {
      results.push(r);
      callbacks?.onResult?.(r);
    }
  }

  return results;
}

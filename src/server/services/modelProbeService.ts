import { fetch } from 'undici';

export type ProbeResult = {
  modelName: string;
  status: 'ok' | 'timeout' | 'error';
  ttftMs: number | null;
  httpStatus: number | null;
  error: string | null;
};

export type ProbeInput = {
  siteUrl: string;
  apiToken: string;
  modelNames: string[];
  prompt: string;
  concurrency: number;
  timeoutMs: number;
};

export type ProbeCallbacks = {
  onResult?: (result: ProbeResult) => void;
};

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
        max_tokens: 16,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      clearTimeout(timer);
      return {
        modelName,
        status: 'error',
        ttftMs: Date.now() - startTime,
        httpStatus: response.status,
        error: `HTTP ${response.status}`,
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
      };
    }

    // Read the full stream like a normal client would
    let ttftMs: number | null = null;
    let gotData = false;
    try {
      for (;;) {
        const { done } = await reader.read();
        if (ttftMs === null) {
          ttftMs = Date.now() - startTime;
        }
        if (done) break;
        gotData = true;
      }
    } finally {
      reader.releaseLock();
    }

    clearTimeout(timer);

    return {
      modelName,
      status: gotData ? 'ok' : 'error',
      ttftMs,
      httpStatus: response.status,
      error: gotData ? null : 'Stream ended immediately',
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
      };
    }
    return {
      modelName,
      status: 'error',
      ttftMs: Date.now() - startTime,
      httpStatus: null,
      error: error?.message || 'Unknown error',
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
  } = input;

  const clampedConcurrency = Math.max(1, Math.min(10, concurrency));
  const clampedTimeout = Math.max(1000, Math.min(60000, timeoutMs));
  const results: ProbeResult[] = [];

  for (let offset = 0; offset < modelNames.length; offset += clampedConcurrency) {
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

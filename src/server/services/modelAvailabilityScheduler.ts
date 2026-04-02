import { and, eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { PROBE_PROMPTS, pickRandomProbePrompt } from '../../shared/probePrompts.js';
import { isUsableAccountToken } from './accountTokenService.js';
import { probeModels, type ProbeResult } from './modelProbeService.js';
import { getDispatcherForProxyUrl, resolveChannelProxyUrl } from './siteProxy.js';

const MODEL_AVAILABILITY_SCHEDULER_TIMEOUT_MS = 15_000;
const MODEL_AVAILABILITY_SCHEDULER_CONCURRENCY = 1;

type SchedulerCandidate = {
  tokenId: number;
  accountId: number;
  siteId: number;
  site: typeof schema.sites.$inferSelect;
  accountExtraConfig: string | null;
  apiToken: string;
  modelNames: string[];
};

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let schedulerRunning = false;

function resolveAvailabilityFromProbeResult(result: ProbeResult): boolean | null {
  if (result.status === 'supported') return true;
  if (result.status === 'unsupported') return false;
  return null;
}

async function persistTokenProbeResults(tokenId: number, results: ProbeResult[]): Promise<void> {
  const now = new Date().toISOString();
  for (const result of results) {
    const nextAvailability = resolveAvailabilityFromProbeResult(result);
    if (nextAvailability === null) {
      const existing = await db.select()
        .from(schema.tokenModelAvailability)
        .where(and(
          eq(schema.tokenModelAvailability.tokenId, tokenId),
          eq(schema.tokenModelAvailability.modelName, result.modelName),
        ))
        .get();
      if (!existing) {
        await db.insert(schema.tokenModelAvailability).values({
          tokenId,
          modelName: result.modelName,
          available: null,
          latencyMs: result.ttftMs,
          checkedAt: now,
        }).run();
        continue;
      }
      await db.update(schema.tokenModelAvailability)
        .set({
          latencyMs: result.ttftMs,
          checkedAt: now,
        })
        .where(eq(schema.tokenModelAvailability.id, existing.id))
        .run();
      continue;
    }

    await db.insert(schema.tokenModelAvailability).values({
      tokenId,
      modelName: result.modelName,
      available: nextAvailability,
      latencyMs: result.ttftMs,
      checkedAt: now,
    }).onConflictDoUpdate({
      target: [schema.tokenModelAvailability.tokenId, schema.tokenModelAvailability.modelName],
      set: {
        available: nextAvailability,
        latencyMs: result.ttftMs,
        checkedAt: now,
      },
    }).run();
  }
}

async function promoteSupportedProbeResultsToAccountAvailability(
  accountId: number,
  results: ProbeResult[],
): Promise<void> {
  const now = new Date().toISOString();
  for (const result of results.filter((item) => item.status === 'supported')) {
    const existing = await db.select()
      .from(schema.modelAvailability)
      .where(and(
        eq(schema.modelAvailability.accountId, accountId),
        eq(schema.modelAvailability.modelName, result.modelName),
      ))
      .get();
    if (!existing) {
      await db.insert(schema.modelAvailability).values({
        accountId,
        modelName: result.modelName,
        available: true,
        latencyMs: result.ttftMs,
        checkedAt: now,
      }).run();
      continue;
    }
    if (!existing.available) {
      await db.update(schema.modelAvailability)
        .set({
          available: true,
          latencyMs: result.ttftMs,
          checkedAt: now,
        })
        .where(eq(schema.modelAvailability.id, existing.id))
        .run();
    }
  }
}

function buildCandidateModelList(input: {
  tokenRows: Array<{ modelName: string; available: boolean | null }>;
  accountRows: Array<{ modelName: string; available: boolean | null }>;
  maxModels: number;
}): string[] {
  const ordered = [
    ...input.tokenRows.filter((row) => row.available === true),
    ...input.tokenRows.filter((row) => row.available !== true),
    ...input.accountRows.filter((row) => row.available === true),
    ...input.accountRows.filter((row) => row.available !== true),
  ].map((row) => row.modelName.trim()).filter((value) => value.length > 0);

  const deduped = new Set<string>();
  const result: string[] = [];
  for (const modelName of ordered) {
    if (deduped.has(modelName)) continue;
    deduped.add(modelName);
    result.push(modelName);
    if (result.length >= input.maxModels) break;
  }
  return result;
}

async function loadSchedulerCandidates(): Promise<SchedulerCandidate[]> {
  const tokenRows = await db.select()
    .from(schema.accountTokens)
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .all();

  const candidates: SchedulerCandidate[] = [];
  const maxModelsPerToken = Math.max(1, Math.trunc(config.modelAvailabilitySchedulerMaxModelsPerToken || 0));

  for (const row of tokenRows) {
    if (!isUsableAccountToken(row.account_tokens)) continue;
    if (row.accounts.status !== 'active') continue;
    if (row.sites.status !== 'active') continue;
    if (row.sites.probeDisabled) continue;

    const [tokenAvailabilityRows, accountAvailabilityRows] = await Promise.all([
      db.select({
        modelName: schema.tokenModelAvailability.modelName,
        available: schema.tokenModelAvailability.available,
      }).from(schema.tokenModelAvailability)
        .where(eq(schema.tokenModelAvailability.tokenId, row.account_tokens.id))
        .all(),
      db.select({
        modelName: schema.modelAvailability.modelName,
        available: schema.modelAvailability.available,
      }).from(schema.modelAvailability)
        .where(eq(schema.modelAvailability.accountId, row.accounts.id))
        .all(),
    ]);

    const modelNames = buildCandidateModelList({
      tokenRows: tokenAvailabilityRows,
      accountRows: accountAvailabilityRows,
      maxModels: maxModelsPerToken,
    });
    if (modelNames.length <= 0) continue;

    const apiToken = row.account_tokens.token?.trim();
    if (!apiToken) continue;

    candidates.push({
      tokenId: row.account_tokens.id,
      accountId: row.accounts.id,
      siteId: row.sites.id,
      site: row.sites,
      accountExtraConfig: row.accounts.extraConfig,
      apiToken,
      modelNames,
    });
  }

  return candidates.slice(0, Math.max(1, Math.trunc(config.modelAvailabilitySchedulerMaxTokensPerSweep || 0)));
}

export async function runModelAvailabilitySchedulerSweep(): Promise<{
  enabled: boolean;
  tokensScanned: number;
  modelsScanned: number;
}> {
  if (!config.modelAvailabilitySchedulerEnabled) {
    return {
      enabled: false,
      tokensScanned: 0,
      modelsScanned: 0,
    };
  }

  const candidates = await loadSchedulerCandidates();
  let tokensScanned = 0;
  let modelsScanned = 0;

  for (const candidate of candidates) {
    const proxyUrl = resolveChannelProxyUrl(candidate.site, candidate.accountExtraConfig);
    const dispatcher = proxyUrl ? getDispatcherForProxyUrl(proxyUrl) : undefined;
    const prompt = pickRandomProbePrompt();
    const results = await probeModels({
      siteUrl: candidate.site.url,
      apiToken: candidate.apiToken,
      modelNames: candidate.modelNames,
      prompt,
      concurrency: MODEL_AVAILABILITY_SCHEDULER_CONCURRENCY,
      timeoutMs: MODEL_AVAILABILITY_SCHEDULER_TIMEOUT_MS,
      delayMs: 0,
      dispatcher,
    });

    await persistTokenProbeResults(candidate.tokenId, results);
    await promoteSupportedProbeResultsToAccountAvailability(candidate.accountId, results);
    tokensScanned += 1;
    modelsScanned += results.length;
  }

  return {
    enabled: true,
    tokensScanned,
    modelsScanned,
  };
}

export function startModelAvailabilityScheduler(): void {
  if (schedulerTimer || !config.modelAvailabilitySchedulerEnabled) return;

  const intervalMs = Math.max(60_000, Math.trunc(config.modelAvailabilitySchedulerIntervalMs || 0));
  const runOnce = async () => {
    if (schedulerRunning || !config.modelAvailabilitySchedulerEnabled) return;
    schedulerRunning = true;
    try {
      const result = await runModelAvailabilitySchedulerSweep();
      if (result.tokensScanned > 0 || result.modelsScanned > 0) {
        console.info(
          `[model-availability-scheduler] tokens=${result.tokensScanned} models=${result.modelsScanned}`,
        );
      }
    } catch (error) {
      console.warn('[model-availability-scheduler] sweep failed', error);
    } finally {
      schedulerRunning = false;
    }
  };

  void runOnce();
  schedulerTimer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  schedulerTimer.unref?.();
}

export function stopModelAvailabilityScheduler(): void {
  if (!schedulerTimer) return;
  clearInterval(schedulerTimer);
  schedulerTimer = null;
}

export function resetModelAvailabilitySchedulerState(): void {
  stopModelAvailabilityScheduler();
  schedulerRunning = false;
}

export const __modelAvailabilitySchedulerTestUtils = {
  MODEL_AVAILABILITY_SCHEDULER_TIMEOUT_MS,
  MODEL_AVAILABILITY_SCHEDULER_CONCURRENCY,
  PROBE_PROMPTS,
};

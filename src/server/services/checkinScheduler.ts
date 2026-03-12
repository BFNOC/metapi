import cron from 'node-cron';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { refreshAllBalances } from './balanceService.js';
import { checkinAll } from './checkinService.js';
import { refreshModelsAndRebuildRoutes } from './modelService.js';
import { sendNotification } from './notifyService.js';
import { buildDailySummaryNotification, collectDailySummaryMetrics } from './dailySummaryService.js';
import { cleanupConfiguredLogs, normalizeLogCleanupRetentionDays } from './logCleanupService.js';

let checkinTask: cron.ScheduledTask | null = null;
let balanceTask: cron.ScheduledTask | null = null;
let dailySummaryTask: cron.ScheduledTask | null = null;
let logCleanupTask: cron.ScheduledTask | null = null;

const DAILY_SUMMARY_DEFAULT_CRON = '58 23 * * *';
const LOG_CLEANUP_DEFAULT_CRON = '0 6 * * *';

async function resolveJsonSetting<T>(
  settingKey: string,
  isValid: (value: unknown) => value is T,
  fallback: T,
): Promise<T> {
  try {
    const row = await db.select().from(schema.settings).where(eq(schema.settings.key, settingKey)).get();
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      if (isValid(parsed)) {
        return parsed;
      }
    }
  } catch {}
  return fallback;
}

async function resolveCronSetting(settingKey: string, fallback: string): Promise<string> {
  return resolveJsonSetting(settingKey, (value): value is string => typeof value === 'string' && cron.validate(value), fallback);
}

async function resolveBooleanSetting(settingKey: string, fallback: boolean): Promise<boolean> {
  return resolveJsonSetting(settingKey, (value): value is boolean => typeof value === 'boolean', fallback);
}

async function resolvePositiveIntegerSetting(settingKey: string, fallback: number): Promise<number> {
  return resolveJsonSetting(
    settingKey,
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 1,
    fallback,
  );
}

function createCheckinTask(cronExpr: string) {
  return cron.schedule(cronExpr, async () => {
    console.log(`[Scheduler] Running check-in at ${new Date().toISOString()}`);
    try {
      const results = await checkinAll();
      const success = results.filter((r) => r.result.success).length;
      const failed = results.length - success;
      console.log(`[Scheduler] Check-in complete: ${success} success, ${failed} failed`);
    } catch (err) {
      console.error('[Scheduler] Check-in error:', err);
    }
  });
}

function createBalanceTask(cronExpr: string) {
  return cron.schedule(cronExpr, async () => {
    console.log(`[Scheduler] Refreshing balances at ${new Date().toISOString()}`);
    try {
      await refreshAllBalances();
      await refreshModelsAndRebuildRoutes();
      console.log('[Scheduler] Balance refresh complete');
    } catch (err) {
      console.error('[Scheduler] Balance refresh error:', err);
    }
  });
}

function createDailySummaryTask(cronExpr: string) {
  return cron.schedule(cronExpr, async () => {
    console.log(`[Scheduler] Sending daily summary at ${new Date().toISOString()}`);
    try {
      const metrics = await collectDailySummaryMetrics();
      const { title, message } = buildDailySummaryNotification(metrics);
      await sendNotification(title, message, 'info', {
        bypassThrottle: true,
        requireChannel: true,
        throwOnFailure: true,
      });
      console.log(`[Scheduler] Daily summary sent: ${title}`);
    } catch (err) {
      console.error('[Scheduler] Daily summary error:', err);
    }
  });
}

function createLogCleanupTask(cronExpr: string) {
  return cron.schedule(cronExpr, async () => {
    if (!config.logCleanupConfigured) {
      console.log('[Scheduler] Log cleanup skipped: legacy fallback mode is active');
      return;
    }
    console.log(`[Scheduler] Running log cleanup at ${new Date().toISOString()}`);
    try {
      const result = await cleanupConfiguredLogs();
      if (!result.enabled) {
        console.log('[Scheduler] Log cleanup skipped: no log target enabled');
        return;
      }
      console.log(
        `[Scheduler] Log cleanup complete: usage=${result.usageLogsDeleted}, program=${result.programLogsDeleted}, cutoff=${result.cutoffUtc}`,
      );
    } catch (err) {
      console.error('[Scheduler] Log cleanup error:', err);
    }
  });
}

export async function startScheduler() {
  const activeCheckinCron = await resolveCronSetting('checkin_cron', config.checkinCron);
  const activeBalanceCron = await resolveCronSetting('balance_refresh_cron', config.balanceRefreshCron);
  const activeDailySummaryCron = await resolveCronSetting('daily_summary_cron', DAILY_SUMMARY_DEFAULT_CRON);
  const activeLogCleanupCron = await resolveCronSetting('log_cleanup_cron', config.logCleanupCron || LOG_CLEANUP_DEFAULT_CRON);
  const activeLogCleanupUsageLogsEnabled = await resolveBooleanSetting(
    'log_cleanup_usage_logs_enabled',
    config.logCleanupUsageLogsEnabled,
  );
  const activeLogCleanupProgramLogsEnabled = await resolveBooleanSetting(
    'log_cleanup_program_logs_enabled',
    config.logCleanupProgramLogsEnabled,
  );
  const activeLogCleanupRetentionDays = await resolvePositiveIntegerSetting(
    'log_cleanup_retention_days',
    normalizeLogCleanupRetentionDays(config.logCleanupRetentionDays),
  );
  config.checkinCron = activeCheckinCron;
  config.balanceRefreshCron = activeBalanceCron;
  config.logCleanupCron = activeLogCleanupCron;
  config.logCleanupUsageLogsEnabled = activeLogCleanupUsageLogsEnabled;
  config.logCleanupProgramLogsEnabled = activeLogCleanupProgramLogsEnabled;
  config.logCleanupRetentionDays = activeLogCleanupRetentionDays;

  checkinTask?.stop();
  balanceTask?.stop();
  dailySummaryTask?.stop();
  logCleanupTask?.stop();
  checkinTask = createCheckinTask(activeCheckinCron);
  balanceTask = createBalanceTask(activeBalanceCron);
  dailySummaryTask = createDailySummaryTask(activeDailySummaryCron);
  logCleanupTask = createLogCleanupTask(activeLogCleanupCron);

  console.log(`[Scheduler] Check-in cron: ${activeCheckinCron}`);
  console.log(`[Scheduler] Balance refresh cron: ${activeBalanceCron}`);
  console.log(`[Scheduler] Daily summary cron: ${activeDailySummaryCron}`);
  console.log(
    `[Scheduler] Log cleanup cron: ${activeLogCleanupCron} (configured=${config.logCleanupConfigured}, usage=${activeLogCleanupUsageLogsEnabled}, program=${activeLogCleanupProgramLogsEnabled}, retentionDays=${activeLogCleanupRetentionDays})`,
  );
}

export function updateCheckinCron(cronExpr: string) {
  if (!cron.validate(cronExpr)) throw new Error(`Invalid cron: ${cronExpr}`);
  config.checkinCron = cronExpr;
  checkinTask?.stop();
  checkinTask = createCheckinTask(cronExpr);
}

export function updateBalanceRefreshCron(cronExpr: string) {
  if (!cron.validate(cronExpr)) throw new Error(`Invalid cron: ${cronExpr}`);
  config.balanceRefreshCron = cronExpr;
  balanceTask?.stop();
  balanceTask = createBalanceTask(cronExpr);
}

export function updateLogCleanupSettings(input: {
  cronExpr?: string;
  usageLogsEnabled?: boolean;
  programLogsEnabled?: boolean;
  retentionDays?: number;
}) {
  const cronExpr = input.cronExpr ?? config.logCleanupCron;
  if (!cron.validate(cronExpr)) throw new Error(`Invalid cron: ${cronExpr}`);

  const retentionDays = normalizeLogCleanupRetentionDays(input.retentionDays ?? config.logCleanupRetentionDays);

  config.logCleanupCron = cronExpr;
  if (input.usageLogsEnabled !== undefined) config.logCleanupUsageLogsEnabled = !!input.usageLogsEnabled;
  if (input.programLogsEnabled !== undefined) config.logCleanupProgramLogsEnabled = !!input.programLogsEnabled;
  config.logCleanupRetentionDays = retentionDays;

  logCleanupTask?.stop();
  logCleanupTask = createLogCleanupTask(cronExpr);
}

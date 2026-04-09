// ────────────────────────────────────────
// Cron scheduler — node-cron based, with setInterval fallback
// Replaces PHP crontab-based cron_handler.php
// ────────────────────────────────────────

import cron from 'node-cron';
import { runDailyReport } from './report.js';
import { runModelCheck } from './model-check.js';
import { runCleanup, type CleanupDeps } from './cleanup.js';
import { logger } from '../shared/logger.js';

export interface CronDeps {
  cleanupDeps?: CleanupDeps;
}

const tasks: cron.ScheduledTask[] = [];
let _started = false;
let _deps: CronDeps = {};

export function startCronJobs(deps?: CronDeps): void {
  if (_started) return;
  _started = true;
  if (deps) _deps = deps;

  const enabled = process.env['CRON_ENABLED'] !== 'false' && process.env['CRON_ENABLED'] !== '0';
  if (!enabled) {
    logger.info('Cron jobs disabled via CRON_ENABLED');
    return;
  }

  // Model status check — every 5 minutes
  tasks.push(cron.schedule('*/5 * * * *', () => {
    void safeRun('model-check', runModelCheck);
  }));

  // Daily report — every day at 23:55 Beijing time (15:55 UTC)
  tasks.push(cron.schedule('55 15 * * *', () => {
    void safeRun('daily-report', runDailyReport);
  }));

  // Cleanup — every 6 hours
  tasks.push(cron.schedule('0 */6 * * *', () => {
    void safeRun('cleanup', () => runCleanup(_deps.cleanupDeps));
  }));

  logger.info({ jobCount: tasks.length }, 'Cron jobs started');
}

export function stopCronJobs(): void {
  for (const task of tasks) {
    task.stop();
  }
  tasks.length = 0;
  _started = false;
  logger.info('Cron jobs stopped');
}

export function isStarted(): boolean {
  return _started;
}

async function safeRun(name: string, fn: () => Promise<void>): Promise<void> {
  const start = performance.now();
  try {
    await fn();
    const durationMs = Math.round(performance.now() - start);
    logger.debug({ name, durationMs }, 'Cron job completed');
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    logger.error({ err, name, durationMs }, 'Cron job failed');
  }
}

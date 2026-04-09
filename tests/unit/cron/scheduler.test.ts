// ────────────────────────────────────────
// Tests: Cron Scheduler — job registration, start/stop
// ────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node-cron
const mockSchedule = vi.fn();
const mockStop = vi.fn();

vi.mock('node-cron', () => ({
  default: {
    schedule: (...args: unknown[]) => {
      mockSchedule(...args);
      return { stop: mockStop };
    },
  },
}));

// Mock cron job modules
vi.mock('../../../src/cron/report.js', () => ({
  runDailyReport: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/cron/model-check.js', () => ({
  runModelCheck: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/cron/cleanup.js', () => ({
  runCleanup: vi.fn().mockResolvedValue(undefined),
}));

const { startCronJobs, stopCronJobs, isStarted } = await import(
  '../../../src/cron/scheduler.js'
);

describe('CronScheduler', () => {
  beforeEach(() => {
    mockSchedule.mockClear();
    mockStop.mockClear();
    // Ensure clean state
    stopCronJobs();
  });

  afterEach(() => {
    stopCronJobs();
  });

  it('should register cron jobs on start', () => {
    startCronJobs();

    // Should have registered 3 jobs: model-check, daily-report, cleanup
    expect(mockSchedule).toHaveBeenCalledTimes(3);
    expect(isStarted()).toBe(true);
  });

  it('should not register jobs twice', () => {
    startCronJobs();
    startCronJobs(); // second call should be no-op

    expect(mockSchedule).toHaveBeenCalledTimes(3);
  });

  it('should stop all jobs on stopCronJobs', () => {
    startCronJobs();
    stopCronJobs();

    expect(mockStop).toHaveBeenCalledTimes(3);
    expect(isStarted()).toBe(false);
  });

  it('should register with correct cron expressions', () => {
    startCronJobs();

    const schedules = mockSchedule.mock.calls.map(
      (call: unknown[]) => call[0] as string,
    );
    expect(schedules).toContain('*/5 * * * *');   // model check
    expect(schedules).toContain('55 15 * * *');   // daily report
    expect(schedules).toContain('0 */6 * * *');   // cleanup
  });

  it('should not start jobs when CRON_ENABLED is false', () => {
    process.env['CRON_ENABLED'] = 'false';
    stopCronJobs(); // reset state
    startCronJobs();

    expect(mockSchedule).toHaveBeenCalledTimes(0);
    process.env['CRON_ENABLED'] = undefined;
  });
});

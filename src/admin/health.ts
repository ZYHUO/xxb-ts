import type { Redis } from 'ioredis';
import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'error';
  uptime: number;
  checks: {
    redis: { ok: boolean; latency_ms: number };
    sqlite: { ok: boolean };
    timestamp: number;
  };
}

export async function checkHealth(redis: Redis): Promise<HealthStatus> {
  const checks = {
    redis: { ok: false, latency_ms: 0 },
    sqlite: { ok: false },
    timestamp: Date.now(),
  };

  // Redis check
  try {
    const start = Date.now();
    await redis.ping();
    checks.redis = { ok: true, latency_ms: Date.now() - start };
  } catch (err) {
    logger.warn({ err }, 'Health: Redis check failed');
  }

  // SQLite check
  try {
    const db = getDb();
    db.prepare('SELECT 1').get();
    checks.sqlite = { ok: true };
  } catch (err) {
    logger.warn({ err }, 'Health: SQLite check failed');
  }

  const allOk = checks.redis.ok && checks.sqlite.ok;
  const anyOk = checks.redis.ok || checks.sqlite.ok;

  return {
    status: allOk ? 'ok' : anyOk ? 'degraded' : 'error',
    uptime: process.uptime(),
    checks,
  };
}

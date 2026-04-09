// ────────────────────────────────────────
// Model health status check — ping AI endpoints
// Port of PHP cron_model_status.php
// ────────────────────────────────────────

import { env } from '../env.js';
import { getRedis } from '../db/redis.js';
import { classifyModelStatus } from '../tracking/model-status.js';
import { saveModelStatusSnapshot } from '../admin/model-status.js';
import type { ModelStatusSnapshot } from '../admin/model-status.js';
import { logger } from '../shared/logger.js';

// Map tracking status ('up'|'slow'|'down') to admin snapshot status
function toSnapshotStatus(s: string): 'ok' | 'error' | 'timeout' | 'slow' {
  if (s === 'up') return 'ok';
  if (s === 'slow') return 'slow';
  return 'error';
}

export async function runModelCheck(): Promise<void> {
  const e = env();
  const redis = getRedis();

  const models: Array<{ label: string; role: string }> = [
    { label: e.AI_MODEL_REPLY, role: 'main' },
    { label: e.AI_MODEL_REPLY_PRO, role: 'pro' },
    { label: e.AI_MODEL_JUDGE, role: 'judge' },
    { label: e.AI_MODEL_ALLOWLIST_REVIEW, role: 'review' },
  ];

  const snapshot: ModelStatusSnapshot = {
    ts: Math.floor(Date.now() / 1000),
    models: {},
  };

  for (const m of models) {
    const start = Date.now();
    let httpCode = 0;
    let error = '';
    let responseBody = '';

    try {
      const res = await fetch(`${e.AI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${e.AI_API_KEY}`,
        },
        body: JSON.stringify({
          model: m.label,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      httpCode = res.status;
      if (!res.ok) {
        responseBody = await res.text().catch(() => '');
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const latency = Date.now() - start;
    const result = classifyModelStatus(httpCode, error, latency, responseBody);

    snapshot.models[m.label] = {
      role: m.role,
      model: m.label,
      status: toSnapshotStatus(result.status),
      latency_ms: latency,
    };
  }

  await saveModelStatusSnapshot(redis, snapshot);
  logger.info({ modelCount: Object.keys(snapshot.models).length }, 'Model check completed');
}

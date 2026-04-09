// ────────────────────────────────────────
// 消息去重中间件 (Redis SET + TTL)
// ────────────────────────────────────────

import { getRedis } from '../../db/redis.js';
import { logger } from '../../shared/logger.js';

const DEDUP_PREFIX = 'xxb:dedup:';
const DEDUP_TTL = 300; // 5 minutes

export async function isDuplicate(chatId: number, messageId: number, isEdit = false): Promise<boolean> {
  const redis = getRedis();
  // Include event type in key so edits aren't blocked by original message
  const suffix = isEdit ? ':edit' : '';
  const key = `${DEDUP_PREFIX}${chatId}:${messageId}${suffix}`;

  // SET NX returns 'OK' if key was set (new), null if key already exists
  const result = await redis.set(key, '1', 'EX', DEDUP_TTL, 'NX');

  if (result === null) {
    logger.debug({ chatId, messageId, isEdit }, 'Duplicate message skipped');
    return true;
  }

  return false;
}

// ────────────────────────────────────────
// Per-user 频率限制中间件
// ────────────────────────────────────────

import { getRedis } from '../../db/redis.js';
import { logger } from '../../shared/logger.js';
import { env } from '../../env.js';

const RL_PREFIX = 'xxb:rl:';
const RL_WINDOW = 60; // 1 minute window

export async function isRateLimited(userId: number): Promise<boolean> {
  const redis = getRedis();
  const key = `${RL_PREFIX}${userId}`;
  const limit = env().RATE_LIMIT_PER_MIN;

  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, RL_WINDOW);
  }

  if (count > limit) {
    logger.warn({ userId, count, limit }, 'User rate limited');
    return true;
  }

  return false;
}

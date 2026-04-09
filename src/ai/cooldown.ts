// ────────────────────────────────────────
// Model 冷却追踪 (429 rate limit)
// ────────────────────────────────────────

import type Redis from 'ioredis';

const COOLDOWN_PREFIX = 'xxb:cooldown:';
const DEFAULT_COOLDOWN_SECONDS = 60;

export class CooldownTracker {
  constructor(private readonly redis: Redis) {}

  async setCooldown(model: string, ttlSeconds = DEFAULT_COOLDOWN_SECONDS): Promise<void> {
    await this.redis.set(COOLDOWN_PREFIX + model, '1', 'EX', ttlSeconds);
  }

  async isCoolingDown(model: string): Promise<boolean> {
    return (await this.redis.exists(COOLDOWN_PREFIX + model)) === 1;
  }

  async getRemainingSeconds(model: string): Promise<number> {
    const ttl = await this.redis.ttl(COOLDOWN_PREFIX + model);
    return ttl > 0 ? ttl : 0;
  }
}

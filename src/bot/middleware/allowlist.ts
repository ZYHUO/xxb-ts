import type { Context, NextFunction } from 'grammy';
import { getRedis } from '../../db/redis.js';
import * as allowlist from '../../allowlist/allowlist.js';
import type { AllowlistConfig } from '../../allowlist/types.js';

export function createAllowlistMiddleware(config: AllowlistConfig) {
  return async function allowlistMiddleware(
    ctx: Context,
    next: NextFunction,
  ): Promise<void> {
    const chatType = ctx.chat?.type;
    if (chatType !== 'group' && chatType !== 'supergroup') {
      return next();
    }

    if (!config.enabled) return next();

    const chatId = ctx.chat!.id;
    const redis = getRedis();
    const allowed = await allowlist.isGroupAllowed(redis, config, chatId);

    if (!allowed) return;

    return next();
  };
}

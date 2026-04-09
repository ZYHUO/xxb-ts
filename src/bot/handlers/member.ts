import type { Bot, Context } from 'grammy';
import { getRedis } from '../../db/redis.js';
import { logger } from '../../shared/logger.js';
import type { AllowlistConfig } from '../../allowlist/types.js';
import * as allowlist from '../../allowlist/allowlist.js';
import * as notify from '../../allowlist/notify.js';

export function registerMemberHandler(
  bot: Bot,
  config: AllowlistConfig,
): void {
  bot.on('my_chat_member', async (ctx: Context) => {
    const update = ctx.myChatMember;
    if (!update) return;

    const chatId = update.chat.id;
    const newStatus = update.new_chat_member.status;
    const chatType = update.chat.type;

    if (chatType !== 'group' && chatType !== 'supergroup') return;

    const redis = getRedis();

    if (newStatus === 'member' || newStatus === 'administrator') {
      logger.info({ chatId, status: newStatus }, 'Bot joined group');
      await notify.onBotJoinedGroup(bot, redis, config, chatId);
    } else if (newStatus === 'left' || newStatus === 'kicked') {
      logger.info({ chatId, status: newStatus }, 'Bot removed from group');
      const removed = await allowlist.removeGroup(redis, config, chatId);
      if (removed) {
        logger.info({ chatId }, 'Group auto-removed from allowlist');
      }
    }
  });
}

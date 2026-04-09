import type { Bot, Context } from 'grammy';
import { logger } from '../../shared/logger.js';
import { isDuplicate } from '../middleware/dedup.js';
import { isRateLimited } from '../middleware/rate-limit.js';
import { enqueue } from '../../queue/producer.js';

async function handleUpdate(ctx: Context): Promise<void> {
  const msg = ctx.message ?? ctx.editedMessage;
  if (!msg) return;

  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const userId = msg.from?.id;

  // Dedup
  if (await isDuplicate(chatId, messageId)) return;

  // Rate limit
  if (userId && (await isRateLimited(userId))) return;

  logger.info(
    {
      chatId,
      messageId,
      from: msg.from?.username ?? msg.from?.first_name ?? 'unknown',
      text: (msg.text ?? msg.caption)?.slice(0, 80),
    },
    'Message received',
  );

  // Enqueue for processing
  await enqueue({
    type: 'message',
    chatId,
    messageId,
    update: ctx.update as unknown as Record<string, unknown>,
    enqueuedAt: Date.now(),
  });
}

export function registerMessageHandler(bot: Bot): void {
  bot.on('message', handleUpdate);
  bot.on('edited_message', handleUpdate);
}

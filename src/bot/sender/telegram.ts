// ────────────────────────────────────────
// Telegram Sender — API wrapper with retry
// ────────────────────────────────────────

import { getBot } from '../bot.js';
import { logger } from '../../shared/logger.js';

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

async function withRetry<T>(
  fn: () => Promise<T>,
  operation: string,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const message = lastError.message;

      // Rate limit (429) — backoff
      if (message.includes('429') || message.includes('Too Many Requests')) {
        const retryAfter = extractRetryAfter(message);
        const waitMs = retryAfter ? retryAfter * 1000 : BASE_BACKOFF_MS * Math.pow(2, attempt);
        logger.warn({ attempt, waitMs, operation }, 'Telegram rate limited, backing off');
        await sleep(waitMs);
        continue;
      }

      // Transient network errors — retry
      if (
        message.includes('ETIMEDOUT') ||
        message.includes('ECONNRESET') ||
        message.includes('ECONNREFUSED') ||
        message.includes('network')
      ) {
        const waitMs = BASE_BACKOFF_MS * Math.pow(2, attempt);
        logger.warn({ attempt, waitMs, operation }, 'Telegram transient error, retrying');
        await sleep(waitMs);
        continue;
      }

      // Non-retryable error
      throw lastError;
    }
  }

  throw lastError ?? new Error(`${operation} failed after ${MAX_RETRIES} retries`);
}

function extractRetryAfter(message: string): number | null {
  const match = message.match(/retry after (\d+)/i);
  return match?.[1] ? parseInt(match[1], 10) : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send a text message to a chat.
 */
export async function sendMessage(
  chatId: number,
  text: string,
  replyToId?: number,
): Promise<number> {
  return withRetry(async () => {
    const bot = getBot();
    try {
      const result = await bot.api.sendMessage(chatId, text, {
        reply_parameters: replyToId ? { message_id: replyToId } : undefined,
      });
      return result.message_id;
    } catch (err) {
      // If reply target is invalid/deleted, retry without reply_to (matching PHP behavior)
      const msg = err instanceof Error ? err.message : String(err);
      if (replyToId && (msg.includes('replied message not found') || msg.includes('message to be replied not found'))) {
        logger.warn({ chatId, replyToId }, 'Reply target not found, sending without reply');
        const result = await bot.api.sendMessage(chatId, text);
        return result.message_id;
      }
      throw err;
    }
  }, 'sendMessage');
}

/**
 * Edit an existing message's text.
 */
export async function editMessage(
  chatId: number,
  messageId: number,
  text: string,
): Promise<void> {
  await withRetry(async () => {
    const bot = getBot();
    await bot.api.editMessageText(chatId, messageId, text);
  }, 'editMessage');
}

/**
 * Send a sticker to a chat.
 */
export async function sendSticker(
  chatId: number,
  stickerId: string,
): Promise<number> {
  return withRetry(async () => {
    const bot = getBot();
    const result = await bot.api.sendSticker(chatId, stickerId);
    return result.message_id;
  }, 'sendSticker');
}

/**
 * Send a chat action (e.g., 'typing').
 */
export async function sendChatAction(
  chatId: number,
  action: 'typing' | 'upload_photo' | 'record_voice',
): Promise<void> {
  try {
    const bot = getBot();
    await bot.api.sendChatAction(chatId, action);
  } catch (err) {
    // Chat actions are best-effort, don't throw on failure
    logger.debug({ chatId, action, err }, 'sendChatAction failed (non-critical)');
  }
}

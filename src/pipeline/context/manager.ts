// ────────────────────────────────────────
// Context 管理 (Redis)
// ────────────────────────────────────────

import type { FormattedMessage } from '../../shared/types.js';
import { getRedis } from '../../db/redis.js';
import { env } from '../../env.js';

const CTX_PREFIX = 'xxb:ctx:';
const TRUNCATE_SIZE = 50;

function key(chatId: number): string {
  return CTX_PREFIX + chatId;
}

export async function addMessage(chatId: number, message: FormattedMessage): Promise<void> {
  const redis = getRedis();
  const k = key(chatId);
  await redis.rpush(k, JSON.stringify(message));

  // Trim if exceeds max length
  const maxLen = env().CONTEXT_MAX_LENGTH;
  const len = await redis.llen(k);
  if (len > maxLen) {
    await redis.ltrim(k, len - (maxLen - TRUNCATE_SIZE), -1);
  }
}

export async function getRecent(chatId: number, count: number): Promise<FormattedMessage[]> {
  const redis = getRedis();
  const raw = await redis.lrange(key(chatId), -count, -1);
  return raw.map((r) => JSON.parse(r) as FormattedMessage);
}

/** Fetch a specific number of recent messages (for activity estimation, separate from judge window) */
export async function getRecentCount(chatId: number, count: number): Promise<FormattedMessage[]> {
  return getRecent(chatId, count);
}

export async function getAll(chatId: number): Promise<FormattedMessage[]> {
  const redis = getRedis();
  const raw = await redis.lrange(key(chatId), 0, -1);
  return raw.map((r) => JSON.parse(r) as FormattedMessage);
}

export async function addAssistant(chatId: number, reply: { textContent: string; messageId: number }): Promise<void> {
  const assistantMsg: FormattedMessage = {
    role: 'assistant',
    uid: 0,
    username: '',
    fullName: '',
    timestamp: Math.floor(Date.now() / 1000),
    messageId: reply.messageId,
    textContent: reply.textContent,
    isForwarded: false,
  };
  await addMessage(chatId, assistantMsg);
}

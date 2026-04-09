// ────────────────────────────────────────
// Context 管理 (Redis)
// ────────────────────────────────────────

import type { FormattedMessage } from '../../shared/types.js';
import { getRedis } from '../../db/redis.js';
import { env } from '../../env.js';

const CTX_PREFIX = 'xxb:ctx:';
const TRUNCATE_SIZE = 50;
const CTX_TTL = 7 * 86400; // 7 days rolling TTL

// Atomic rpush + trim + expire via Lua
const RPUSH_TRIM_LUA = `
local key = KEYS[1]
redis.call('RPUSH', key, ARGV[1])
local len = redis.call('LLEN', key)
local maxLen = tonumber(ARGV[2])
local trimSize = tonumber(ARGV[3])
if len > maxLen then
  redis.call('LTRIM', key, len - trimSize, -1)
end
redis.call('EXPIRE', key, tonumber(ARGV[4]))
return len
`;

function ctxKey(chatId: number): string {
  return CTX_PREFIX + chatId;
}

export async function addMessage(chatId: number, message: FormattedMessage): Promise<void> {
  const redis = getRedis();
  const maxLen = env().CONTEXT_MAX_LENGTH;
  await redis.eval(
    RPUSH_TRIM_LUA,
    1,
    ctxKey(chatId),
    JSON.stringify(message),
    String(maxLen),
    String(maxLen - TRUNCATE_SIZE),
    String(CTX_TTL),
  );
}

export async function getRecent(chatId: number, count: number): Promise<FormattedMessage[]> {
  const redis = getRedis();
  const raw = await redis.lrange(ctxKey(chatId), -count, -1);
  return raw.map((r) => JSON.parse(r) as FormattedMessage);
}

/** Fetch a specific number of recent messages (for activity estimation, separate from judge window) */
export async function getRecentCount(chatId: number, count: number): Promise<FormattedMessage[]> {
  return getRecent(chatId, count);
}

export async function getAll(chatId: number): Promise<FormattedMessage[]> {
  const redis = getRedis();
  const raw = await redis.lrange(ctxKey(chatId), 0, -1);
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

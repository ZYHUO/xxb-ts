// ────────────────────────────────────────
// Idle proactive messaging cron
// 群聊沉默超过 30 分钟时，随机主动发一句
// ────────────────────────────────────────

import { getRedis } from '../db/redis.js';
import { getRecent } from '../pipeline/context/manager.js';
import { StreamingSender } from '../bot/sender/streaming.js';
import { callWithFallback } from '../ai/fallback.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';

const IDLE_THRESHOLD_SEC = 60 * 60;  // 30 minutes of silence
const TRIGGER_PROBABILITY = 0.10;    // 30% chance to fire when idle
const HOUR_START = 10;               // 10:00 Beijing
const HOUR_END = 23;                 // 23:00 Beijing
const CTX_PREFIX = 'xxb:ctx:';
const LAST_POKE_PREFIX = 'xxb:last_poke:';
const MIN_PROACTIVE_INTERVAL = 3 * 60 * 60; // at least 90 min between proactive pokes per chat

const sender = new StreamingSender();

function isWithinActiveHours(): boolean {
  const now = new Date();
  const hour = parseInt(
    now.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }),
    10,
  );
  return hour >= HOUR_START && hour < HOUR_END;
}

/** Discover active group chat IDs by scanning Redis context keys. */
async function discoverActiveGroupChats(): Promise<number[]> {
  const redis = getRedis();
  const keys: string[] = [];

  // Use SCAN to avoid blocking
  let cursor = '0';
  do {
    const [nextCursor, found] = await redis.scan(cursor, 'MATCH', `${CTX_PREFIX}*`, 'COUNT', '200');
    cursor = nextCursor;
    keys.push(...found);
  } while (cursor !== '0');

  const chatIds: number[] = [];
  for (const key of keys) {
    const id = parseInt(key.slice(CTX_PREFIX.length), 10);
    if (!Number.isNaN(id) && id < 0) { // negative = group chat
      chatIds.push(id);
    }
  }
  return chatIds;
}

export async function runIdleCheck(): Promise<void> {
  if (!isWithinActiveHours()) {
    logger.debug('Idle check: outside active hours, skipping');
    return;
  }

  let chatIds: number[];
  try {
    chatIds = await discoverActiveGroupChats();
  } catch (err) {
    logger.warn({ err }, 'Idle check: failed to discover chats');
    return;
  }

  if (chatIds.length === 0) {
    logger.debug('Idle check: no active group chats found');
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const e = env();
  const redis = getRedis();

  for (const chatId of chatIds) {
    try {
      // Check if we sent a proactive message recently in this chat (Redis-persisted)
      const lastPokeRaw = await redis.get(LAST_POKE_PREFIX + chatId);
      const lastPoke = lastPokeRaw ? parseInt(lastPokeRaw, 10) : 0;
      if (now - lastPoke < MIN_PROACTIVE_INTERVAL) continue;

      // Get recent messages to check silence
      const recent = await getRecent(chatId, 20);
      if (recent.length === 0) continue;

      const lastMsg = recent[recent.length - 1]!;
      const silenceSec = now - lastMsg.timestamp;

      if (silenceSec < IDLE_THRESHOLD_SEC) continue;

      // Roll the dice — only trigger TRIGGER_PROBABILITY fraction of the time
      if (Math.random() > TRIGGER_PROBABILITY) continue;

      logger.info({ chatId, silenceSec }, 'Idle check: generating proactive message');

      // Build a short context excerpt for the AI
      const contextLines = recent.slice(-8).map((m) => {
        const name = m.fullName || m.username || (m.role === 'assistant' ? e.BOT_USERNAME : '?');
        const text = m.textContent || m.captionContent || '[sticker/media]';
        return `${name}: ${text.slice(0, 100)}`;
      }).join('\n');

      const result = await callWithFallback({
        usage: 'reply',
        messages: [
          {
            role: 'system',
            content: `你是${e.BOT_USERNAME}，一只活泼可爱的猫娘群友。群聊已经沉默超过30分钟了，请自然地发起一个话题或者说一句有趣的话来带动气氛。
要求：
- 短句，不超过30字
- 自然、随意，像真实群友主动说话
- 可以评论之前的话题，或者随机说点有意思的事
- 禁止自我介绍，禁止说"大家好"，禁止以"喵~"开头
- 只输出要发送的纯文本，不要任何解释或格式`,
          },
          {
            role: 'user',
            content: `最近的聊天记录：\n${contextLines}\n\n群聊已沉默${Math.floor(silenceSec / 60)}分钟，请发起话题：`,
          },
        ],
        maxTokens: 60,
        temperature: 1.1,
      });

      const text = result.content.trim().replace(/^["「『]|["」』]$/g, '');
      if (!text || text.length < 2) continue;

      await sender.sendDirect(chatId, text);
      await redis.set(LAST_POKE_PREFIX + chatId, String(now), 'EX', MIN_PROACTIVE_INTERVAL * 2);

      logger.info({ chatId, text, silenceSec }, 'Idle proactive message sent');
    } catch (err) {
      logger.warn({ err, chatId }, 'Idle check: failed for chat');
    }
  }
}

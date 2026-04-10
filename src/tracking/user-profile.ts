// ────────────────────────────────────────
// User Profile Tracker
// 每条消息更新用户 tag，积累消息日志
// 每小时 cron 用 Qwen3.6+ 生成用户画像 prompt
// ────────────────────────────────────────

import { getDb } from '../db/sqlite.js';
import { callWithFallback } from '../ai/fallback.js';
import { logger } from '../shared/logger.js';

const MAX_PENDING = 50;      // 积累多少条消息再总结
const MAX_PROMPT_CHARS = 600;

interface ProfileRow {
  chat_id: number;
  uid: number;
  username: string;
  full_name: string;
  sender_tag: string | null;
  profile_prompt: string | null;
  pending_messages: string;
  updated_at: number;
}

// ── 写入侧（每条消息调用，同步，极快）────────────────────

export function recordUserMessage(
  chatId: number,
  uid: number,
  username: string,
  fullName: string,
  senderTag: string | undefined,
  text: string,
): void {
  if (!text.trim()) return;
  const db = getDb();

  // Upsert row, append message to pending_messages
  db.prepare(`
    INSERT INTO user_profiles (chat_id, uid, username, full_name, sender_tag, pending_messages, updated_at)
    VALUES (?, ?, ?, ?, ?, json_array(?), unixepoch())
    ON CONFLICT(chat_id, uid) DO UPDATE SET
      username     = excluded.username,
      full_name    = excluded.full_name,
      sender_tag   = COALESCE(excluded.sender_tag, sender_tag),
      pending_messages = CASE
        WHEN json_array_length(pending_messages) >= ${MAX_PENDING}
        THEN json_insert(json_remove(pending_messages, '$[0]'), '$[#]', ?)
        ELSE json_insert(pending_messages, '$[#]', ?)
      END,
      updated_at   = unixepoch()
  `).run(chatId, uid, username, fullName, senderTag ?? null, text, text, text);
}

// ── 读取侧（reply 时注入，同步，极快）────────────────────

export function getUserProfilePrompt(chatId: number, uid: number): string | null {
  const row = getDb().prepare(
    'SELECT profile_prompt FROM user_profiles WHERE chat_id = ? AND uid = ?',
  ).get(chatId, uid) as { profile_prompt: string | null } | undefined;
  return row?.profile_prompt ?? null;
}

export function getUserTag(chatId: number, uid: number): string | null {
  const row = getDb().prepare(
    'SELECT sender_tag FROM user_profiles WHERE chat_id = ? AND uid = ?',
  ).get(chatId, uid) as { sender_tag: string | null } | undefined;
  return row?.sender_tag ?? null;
}

// ── Cron 侧（每小时，异步，用 Qwen3.6+）─────────────────

export async function runUserProfileSync(): Promise<void> {
  const db = getDb();

  // 只处理有 pending 消息的用户
  const rows = db.prepare(`
    SELECT * FROM user_profiles
    WHERE json_array_length(pending_messages) > 0
  `).all() as ProfileRow[];

  if (rows.length === 0) {
    logger.debug('User profile sync: no pending messages');
    return;
  }

  logger.info({ count: rows.length }, 'User profile sync: starting');

  for (const row of rows) {
    try {
      let pending: string[];
      try {
        pending = JSON.parse(row.pending_messages) as string[];
      } catch {
        logger.warn({ chatId: row.chat_id, uid: row.uid }, 'User profile: corrupt pending_messages, resetting');
        db.prepare('UPDATE user_profiles SET pending_messages = ? WHERE chat_id = ? AND uid = ?')
          .run('[]', row.chat_id, row.uid);
        continue;
      }
      if (pending.length === 0) continue;

      const existingPrompt = row.profile_prompt ?? '';
      const tagLine = row.sender_tag ? `用户标签(Tag): ${row.sender_tag}\n` : '';
      const messagesBlock = pending.map((m, i) => `${i + 1}. ${m}`).join('\n');

      const systemPrompt = `你是一个群聊用户画像分析师。根据用户最近的发言，更新对该用户的简短画像描述。
画像用于帮助群聊 bot 更好地理解和回应这个用户。
要求：
- 100字以内，中文
- 描述用户的兴趣、说话风格、情绪倾向、常见话题
- 如果有现有画像，在其基础上更新而非完全替换
- 只输出画像文本，不要有任何前缀或说明`;

      const userContent = `用户: ${row.full_name}(@${row.username})
${tagLine}${existingPrompt ? `现有画像:\n${existingPrompt}\n\n` : ''}最新发言(${pending.length}条):\n${messagesBlock}`;

      const result = await callWithFallback({
        usage: 'summarize',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        maxTokens: 200,
        temperature: 0.3,
      });

      const newPrompt = result.content.trim().slice(0, MAX_PROMPT_CHARS);
      if (!newPrompt) continue;

      db.prepare(`
        UPDATE user_profiles
        SET profile_prompt = ?, pending_messages = '[]', updated_at = unixepoch()
        WHERE chat_id = ? AND uid = ?
      `).run(newPrompt, row.chat_id, row.uid);

      logger.debug({ chatId: row.chat_id, uid: row.uid }, 'User profile updated');
    } catch (err) {
      logger.warn({ err, chatId: row.chat_id, uid: row.uid }, 'User profile sync failed for user');
    }

    // 每个用户之间稍作间隔，避免并发过多
    await new Promise((r) => setTimeout(r, 500));
  }

  logger.info({ count: rows.length }, 'User profile sync: done');
}

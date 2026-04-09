// ────────────────────────────────────────
// Reply Orchestrator — generate reply via AI
// ────────────────────────────────────────

import type { FormattedMessage, RetrievedContext, ReplyOutput } from '../../shared/types.js';
import type { JudgeAction } from '../../shared/types.js';
import { buildSystemPrompt, buildMessages } from './prompt-builder.js';
import { slimContextForAI } from '../context/slim.js';
import { compressContext } from '../context/compressor.js';
import { getKnowledge } from '../../knowledge/manager.js';
import { generateWithTools } from '../tools/executor.js';
import { parseReplyResponse } from './parser.js';
import { getRecent } from '../context/manager.js';
import { doCheckin } from '../checkin.js';
import { logger } from '../../shared/logger.js';

const MAX_DUPLICATE_RETRIES = 1;

/** Normalize text for duplicate comparison (matching PHP behavior) */
function normalizeForDuplicateCheck(text: string): string {
  return text
    .replace(/\s+/g, ' ')       // collapse all whitespace
    .replace(/\n{3,}/g, '\n\n') // compress 3+ newlines to 2
    .trim()
    .toLowerCase();
}

/**
 * Check if reply is a duplicate of recent assistant messages.
 */
async function isDuplicateReply(chatId: number, replyContent: string): Promise<boolean> {
  const recent = await getRecent(chatId, 10);
  const recentAssistant = recent
    .filter((m) => m.role === 'assistant')
    .slice(-3);

  const normalized = normalizeForDuplicateCheck(replyContent);
  return recentAssistant.some((m) => normalizeForDuplicateCheck(m.textContent) === normalized);
}

/**
 * Generate a reply using AI with proper context.
 */
export async function generateReply(
  message: FormattedMessage,
  retrievedContext: RetrievedContext,
  action: JudgeAction,
  chatId: number,
  botUid: number,
): Promise<ReplyOutput> {
  const start = performance.now();
  const replyAction = action === 'REPLY_PRO' ? 'REPLY_PRO' : 'REPLY';

  // 1. Build system prompt (5-layer)
  const systemPrompt = buildSystemPrompt(action);

  // 2. Compress and format context
  const compressed = compressContext(retrievedContext.merged, message, botUid);
  const contextStr = slimContextForAI(compressed, message, botUid);

  // 3. Load knowledge
  const knowledge = getKnowledge(chatId) || undefined;

  // 3.5 Checkin data injection — minimal real data, AI creates the rest
  let checkinData: string | undefined;
  const msgText = message.textContent || '';
  if (/^\/checkin(?:@\w+)?$/i.test(msgText.trim())) {
    try {
      const result = doCheckin(chatId, message.uid, message.username, message.fullName);
      checkinData = result.isNew
        ? `[签到系统] 签到成功！连续${result.streak}天，累计${result.totalCheckins}次，今日第${result.rank}个。请自由发挥奖励、运势等有趣内容。`
        : `[签到系统] 今天已经签过了！连续${result.streak}天，累计${result.totalCheckins}次，今日第${result.rank}个。提醒TA别重复签。`;
      logger.debug({ chatId, uid: message.uid, isNew: result.isNew, streak: result.streak }, 'Checkin data injected');
    } catch (err) {
      logger.error({ err, chatId }, 'Checkin failed');
    }
  }

  // 4. Build messages array
  const messages = buildMessages(systemPrompt, contextStr, message, knowledge, checkinData);

  // 5. Call AI (with tool support via Vercel AI SDK)
  const usage = replyAction === 'REPLY_PRO' ? 'reply_pro' : 'reply';

  let result = await generateWithTools(messages, chatId, message.uid, usage);

  // 6. Parse response
  let parsed = parseReplyResponse(result.content, message.messageId);

  // 7. Duplicate detection — retry once with different temperature
  if (await isDuplicateReply(chatId, parsed.replyContent)) {
    logger.info({ chatId }, 'Duplicate reply detected, regenerating');
    for (let i = 0; i < MAX_DUPLICATE_RETRIES; i++) {
      result = await generateWithTools(messages, chatId, message.uid, usage, {
        temperatureOverride: 1.2,
      });
      parsed = parseReplyResponse(result.content, message.messageId);
      if (!(await isDuplicateReply(chatId, parsed.replyContent))) break;
    }
  }

  const latencyMs = Math.round(performance.now() - start);
  logger.info({
    chatId,
    action: replyAction,
    model: result.model,
    tokens: result.tokenUsage.total,
    latencyMs,
    replyLength: parsed.replyContent.length,
  }, 'Reply generated');

  return {
    replyContent: parsed.replyContent,
    targetMessageId: parsed.targetMessageId,
    stickerIntent: parsed.stickerIntent,
  };
}

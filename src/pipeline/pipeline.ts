// ────────────────────────────────────────
// Pipeline Orchestrator — full message pipeline
// ────────────────────────────────────────

import type { ChatJob } from '../shared/types.js';
import { formatMessage } from './formatter.js';
import { addMessage, getRecent, getRecentCount, addAssistant } from './context/manager.js';
import { judge } from './judge/judge.js';
import { describeImage } from './vision.js';
import { retrieveContext } from './context/retriever.js';
import { generateReply } from './reply/reply.js';
import { StreamingSender } from '../bot/sender/streaming.js';
import { sendChatAction } from '../bot/sender/telegram.js';
import { getBotUid } from '../bot/bot.js';
import { recordMessage as recordActivity } from '../tracking/activity.js';
import { getBotTracker } from '../tracking/interaction.js';
import { recordReply, checkOutcome } from '../tracking/outcome.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';

const sender = new StreamingSender();

export async function processPipeline(job: ChatJob): Promise<void> {
  const start = performance.now();
  const timings: Record<string, number> = {};

  // 1. Format message
  const t0 = performance.now();
  const formatted = formatMessage(job.update);
  if (!formatted) {
    logger.debug({ chatId: job.chatId }, 'Skipping non-formattable update');
    return;
  }
  timings['format'] = Math.round(performance.now() - t0);

  // 2. Vision — if image present, describe it
  if (formatted.imageFileId) {
    const t1 = performance.now();
    try {
      const description = await describeImage(formatted.imageFileId);
      if (description) {
        formatted.imageDescriptions = [description];
      }
    } catch (err) {
      logger.warn({ err }, 'Vision failed, continuing without description');
    }
    timings['vision'] = Math.round(performance.now() - t1);
  }

  // 3. Save to context
  const t2 = performance.now();
  await addMessage(job.chatId, formatted);
  timings['save'] = Math.round(performance.now() - t2);

  const e = env();

  // 3.5 Record group activity
  recordActivity(job.chatId, formatted.messageId, formatted.uid).catch((err) => {
    logger.debug({ err, chatId: job.chatId }, 'Activity tracking failed (non-critical)');
  });

  // 3.6 Bot interaction tracking
  if (formatted.isBot && formatted.username) {
    try {
      getBotTracker()?.recordInteraction(job.chatId, {
        ts: formatted.timestamp,
        type: 'message',
        bot: formatted.username,
        uid: formatted.uid,
        text: formatted.textContent,
        mid: formatted.messageId,
      });
    } catch (err) {
      logger.debug({ err, chatId: job.chatId }, 'Bot interaction tracking failed (non-critical)');
    }
  }

  // 3.7 Check reply outcomes
  if (e.OUTCOME_TRACKING_ENABLED) {
    checkOutcome(job.chatId, formatted, e.BOT_USERNAME).catch((err) => {
      logger.debug({ err, chatId: job.chatId }, 'Outcome check failed (non-critical)');
    });
  }

  // 4. Judge (L0 → L1 → L2)
  const t3 = performance.now();
  const recentMessages = await getRecent(job.chatId, e.JUDGE_WINDOW_SIZE);

  const activityWindow = await getRecentCount(job.chatId, 30);
  const now = Math.floor(Date.now() / 1000);
  const fiveMinAgo = now - 300;
  const oneHourAgo = now - 3600;
  const messagesLast5Min = activityWindow.filter((m) => m.timestamp >= fiveMinAgo).length;
  const messagesLast1Hour = activityWindow.filter((m) => m.timestamp >= oneHourAgo).length;

  const judgeResult = await judge({
    message: formatted,
    recentMessages,
    botUid: getBotUid(),
    botUsername: e.BOT_USERNAME,
    botNicknames: e.BOT_NICKNAMES,
    chatId: job.chatId,
    groupActivity: { messagesLast5Min, messagesLast1Hour },
  });
  timings['judge'] = Math.round(performance.now() - t3);

  logger.info({
    chatId: job.chatId,
    messageId: formatted.messageId,
    from: formatted.username || formatted.fullName,
    action: judgeResult.action,
    level: judgeResult.level,
    rule: judgeResult.rule,
    confidence: judgeResult.confidence,
    judgeMs: judgeResult.latencyMs,
  }, `Judge: ${judgeResult.action}`);

  // 5. If IGNORE/REJECT → return
  if (judgeResult.action === 'IGNORE' || judgeResult.action === 'REJECT') {
    const totalMs = Math.round(performance.now() - start);
    logger.debug({ chatId: job.chatId, totalMs, timings }, 'Pipeline complete (no reply)');
    return;
  }

  // 6-10: Reply generation and send (with error recovery)
  try {
    // 6. Send typing indicator
    await sendChatAction(job.chatId, 'typing');

    // 7. 4-way context retrieval
    const t4 = performance.now();
    const retrievedContext = await retrieveContext(
      job.chatId,
      formatted,
      getBotUid(),
    );
    timings['retrieval'] = Math.round(performance.now() - t4);

    // 8. Generate reply (returns array for multi-reply support)
    const t5 = performance.now();
    const replies = await generateReply(
      formatted,
      retrievedContext,
      judgeResult.action,
      job.chatId,
      getBotUid(),
    );
    timings['reply'] = Math.round(performance.now() - t5);

    // 9. Send all replies to Telegram
    const t6 = performance.now();
    const sentMessages: Array<{ messageId: number; text: string }> = [];

    for (const reply of replies) {
      try {
        const sent = await sender.sendDirect(
          job.chatId,
          reply.replyContent,
          reply.targetMessageId,
        );
        sentMessages.push({ messageId: sent.messageId, text: reply.replyContent });
      } catch (err) {
        logger.error({ chatId: job.chatId, targetMessageId: reply.targetMessageId, err },
          'Failed to send reply in multi-reply sequence');
        // Continue sending remaining replies
      }
    }
    timings['send'] = Math.round(performance.now() - t6);

    if (sentMessages.length === 0) {
      throw new Error('All replies failed to send');
    }

    // 10. Save ALL sent assistant messages to context
    const t7 = performance.now();
    for (const sent of sentMessages) {
      await addAssistant(job.chatId, {
        textContent: sent.text,
        messageId: sent.messageId,
      });
    }
    timings['saveAssistant'] = Math.round(performance.now() - t7);

    // 11. Record reply outcome for FIRST reply (primary)
    if (e.OUTCOME_TRACKING_ENABLED && sentMessages.length > 0) {
      const first = sentMessages[0]!;
      recordReply(
        job.chatId,
        first.messageId,
        formatted.messageId,
        formatted.uid,
        formatted.textContent,
        first.text,
        judgeResult.action,
      ).catch((err) => {
        logger.debug({ err, chatId: job.chatId }, 'Outcome recording failed (non-critical)');
      });
    }

    const totalMs = Math.round(performance.now() - start);
    logger.info({
      chatId: job.chatId,
      messageId: formatted.messageId,
      action: judgeResult.action,
      replyCount: sentMessages.length,
      replyMsgIds: sentMessages.map(s => s.messageId),
      totalMs,
      timings,
    }, 'Pipeline complete');
  } catch (err) {
    const totalMs = Math.round(performance.now() - start);
    logger.error({
      chatId: job.chatId,
      messageId: formatted.messageId,
      action: judgeResult.action,
      totalMs,
      timings,
      err,
    }, 'Pipeline reply/send failed');

    // Attempt fallback error message (best-effort)
    try {
      await sender.sendDirect(job.chatId, '喵呜...本喵出了点小故障，稍后再试试吧 >_<');
    } catch {
      logger.warn({ chatId: job.chatId }, 'Fallback message also failed');
    }
  }
}

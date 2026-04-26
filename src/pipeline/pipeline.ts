// ────────────────────────────────────────
// Pipeline Orchestrator — full message pipeline
// ────────────────────────────────────────

import type {
  ChatJob,
  FormattedMessage,
  JudgeResult,
  ReplyPath,
  ReplyTier,
} from "../shared/types.js";
import { resolveReplyPath, resolveReplyTier } from "../shared/types.js";
import { formatMessage } from "./formatter.js";
import { addMessage, getRecent, addAssistant } from "./context/manager.js";
import { judge } from "./judge/judge.js";
import { describeImage, describeStickerCached } from "./vision.js";
import { retrieveContext } from "./context/retriever.js";
import { generateReply } from "./reply/reply.js";
import { applyChatPathPolicy, reflectChatPathPolicy } from "./path-policy.js";
import { StreamingSender } from "../bot/sender/streaming.js";
import {
  sendChatAction,
  sendMessage,
  sendSticker,
  deleteMessage,
  editMessage,
} from "../bot/sender/telegram.js";
import { getBotUid } from "../bot/bot.js";
import { recordMessage as recordActivity } from "../tracking/activity.js";
import { getBotTracker } from "../tracking/interaction.js";
import { tryGenerateDigest } from "../tracking/bot-digest.js";
import {
  recordReply,
  checkOutcome,
  generateReflection,
} from "../tracking/outcome.js";
import {
  recordUserMessage,
  saveUserPreference,
  getUserPreferences,
  getUserProfilePrompt,
  deleteUserPreference,
  getMuteState,
  muteUser,
  unmuteUser,
} from "../tracking/user-profile.js";
import { memorizeMessage } from "../memory/chroma.js";
import {
  getReadyStickersByIntent,
  recordStickerSent,
  lookupSentSticker,
  recordStickerDislike,
  getStickerScore,
} from "../knowledge/sticker/store.js";
import { loadOverrideCached } from "../admin/runtime-config.js";
import { getRedis } from "../db/redis.js";
import { callWithFallback } from "../ai/fallback.js";
import { detectDmIntentWithAI } from "./dm-relay/detector.js";
import {
  handleDmRelay,
  handlePendingGroupSelection,
} from "./dm-relay/relay.js";
import {
  getPendingGroupSelection,
  clearPendingGroupSelection,
} from "./dm-relay/group-resolver.js";
import { detectConsentReply, setConsent } from "./dm-relay/consent.js";
import {
  getRemainingMaxQuota,
  consumeMaxQuota,
} from "../tracking/reply-max-quota.js";
import { describeMultimodal } from "./multimodal.js";
import { acquireChatLock } from "../queue/chat-lock.js";
import { env } from "../env.js";
import { logger } from "../shared/logger.js";
import { parseMuteTimedRequest } from "./judge/rules.js";

const sender = new StreamingSender();
const _recentStickerIds = new Set<string>();
const _recentStickerQueue: string[] = [];
const MAX_RECENT_STICKERS = 50;
let _repliesSinceLastSticker = 0;
const STICKER_COOLDOWN_REPLIES = 6; // only allow sticker every N replies
function _trackRecentSticker(id: string): void {
  _recentStickerIds.add(id);
  _recentStickerQueue.push(id);
  if (_recentStickerQueue.length > MAX_RECENT_STICKERS) {
    const old = _recentStickerQueue.shift()!;
    _recentStickerIds.delete(old);
  }
  _repliesSinceLastSticker = 0;
}
const TEMP_MUTE_CLEAR_RULES = new Set([
  "reply_to_self",
  "reply_to_self_lookup",
  "reply_to_self_followup_lookup",
  "mention_self",
  "mention_self_lookup",
]);

const DIRECT_INTERACTION_RULES = new Set([
  "reply_to_self",
  "reply_to_self_lookup",
  "reply_to_self_followup_lookup",
  "mention_self",
  "mention_self_lookup",
  "whitelisted_command",
  "private_chat",
]);

function isAssistantTurn(
  message: { role: string; uid: number },
  botUid: number,
): boolean {
  return message.role === "assistant" || message.uid === botUid;
}

async function shouldSuppressStaleReply(
  chatId: number,
  message: { messageId: number; uid: number },
  judgeRule: string | undefined,
  botUid: number,
  recentWindow: number,
): Promise<boolean> {
  if (chatId > 0 || (judgeRule && DIRECT_INTERACTION_RULES.has(judgeRule))) {
    return false;
  }

  const recent = await getRecent(chatId, Math.max(recentWindow, 20));
  const currentIndex = recent.findIndex(
    (entry) =>
      entry.messageId === message.messageId && entry.uid === message.uid,
  );
  if (currentIndex < 0) return false;

  return recent
    .slice(currentIndex + 1)
    .some((entry) => isAssistantTurn(entry, botUid));
}

// Vision / sticker / multimodal processing — runs media branches in parallel
// and mutates `formatted` with descriptions. ReplyTo attachment handling is
// included so the orchestrator only sees a single media stage.
async function processMedia(formatted: FormattedMessage): Promise<void> {
  const hasMedia = !!(
    formatted.imageFileId ||
    formatted.sticker ||
    formatted.audioFileId ||
    formatted.voiceFileId ||
    formatted.documentFileId ||
    formatted.videoFileId ||
    formatted.videoNoteFileId
  );
  if (hasMedia) {
    await Promise.all([
      formatted.imageFileId
        ? describeImage(formatted.imageFileId)
            .then((d) => { if (d) formatted.imageDescriptions = [d]; })
            .catch((err) => logger.warn({ err }, "Vision failed, continuing"))
        : Promise.resolve(),
      formatted.sticker
        ? describeStickerCached(formatted.sticker.fileId, formatted.sticker.fileUniqueId)
            .then((d) => { if (d && d !== "[图片]") (formatted.sticker as { description?: string }).description = d; })
            .catch((err) => logger.warn({ err }, "Sticker description failed, continuing"))
        : Promise.resolve(),
      (formatted.audioFileId || formatted.voiceFileId || formatted.documentFileId || formatted.videoFileId || formatted.videoNoteFileId)
        ? describeMultimodal(formatted)
            .then((d) => { if (d) formatted.textContent = (formatted.textContent ? formatted.textContent + "\n" + d : d).trim(); })
            .catch((err) => logger.warn({ err }, "Multimodal processing failed, continuing"))
        : Promise.resolve(),
    ]);
  }

  // ReplyTo attachment — if user replies to a message with a file/image, process it
  if (formatted.replyTo && !formatted.documentFileId && !formatted.imageFileId) {
    if (formatted.replyTo.documentFileId) {
      formatted.documentFileId = formatted.replyTo.documentFileId;
      formatted.documentMimeType = formatted.replyTo.documentMimeType;
      formatted.documentFileName = formatted.replyTo.documentFileName;
      try {
        const desc = await describeMultimodal(formatted);
        if (desc) {
          formatted.textContent = (formatted.textContent ? formatted.textContent + "\n" + desc : desc).trim();
        }
      } catch (err) {
        logger.warn({ err }, "ReplyTo document processing failed, continuing");
      }
      formatted.documentFileId = undefined;
    } else if (formatted.replyTo.imageFileId) {
      try {
        const description = await describeImage(formatted.replyTo.imageFileId);
        if (description) {
          formatted.imageDescriptions = [description];
        }
      } catch (err) {
        logger.warn({ err }, "ReplyTo image processing failed, continuing");
      }
    }
  }
}

// Mute / unmute command interceptors — group only. Returns true when a command
// was handled (caller should early-return) and false when the message should
// continue down the pipeline.
async function tryMuteCommandIntercepts(
  chatId: number,
  formatted: FormattedMessage,
  judgeResult: JudgeResult,
): Promise<boolean> {
  if (formatted.isAnonymous) {
    if (
      judgeResult.rule === "self_mute_request" ||
      judgeResult.rule === "self_unmute_request"
    ) {
      await sender.sendDirect(
        chatId,
        "频道身份没法用这个命令喵，用个人身份试试~",
        formatted.messageId,
      );
      return true;
    }
    return false;
  }

  if (chatId >= 0) return false; // group-only

  const rule = judgeResult.rule;

  if (rule === "mute_hard_request") {
    muteUser(chatId, formatted.uid, 2);
    await sender.sendDirect(chatId, "好的，本喵完全闭嘴喵~", formatted.messageId);
    logger.info({ chatId, uid: formatted.uid, level: 2 }, "User hard-muted bot");
    return true;
  }

  if (rule === "mute_soft_request") {
    muteUser(chatId, formatted.uid, 1, { temporary: true });
    await sender.sendDirect(chatId, "好的，本喵不会主动找你说话了喵~", formatted.messageId);
    logger.info({ chatId, uid: formatted.uid, level: 1 }, "User soft-muted bot");
    return true;
  }

  if (rule === "mute_timed_request") {
    const text = formatted.textContent || formatted.captionContent || "";
    const durationMs = parseMuteTimedRequest(text);
    if (durationMs && durationMs > 0) {
      muteUser(chatId, formatted.uid, 1, { temporary: true, durationMs });
      const minutes = Math.round(durationMs / 60_000);
      await sender.sendDirect(chatId, `好的，本喵安静 ${minutes} 分钟喵~`, formatted.messageId);
      logger.info({ chatId, uid: formatted.uid, durationMs }, "User timed-muted bot");
      return true;
    }
    return false;
  }

  if (rule === "unmute_request") {
    unmuteUser(chatId, formatted.uid);
    await sender.sendDirect(chatId, "嗯！本喵又可以说话啦喵~", formatted.messageId);
    logger.info({ chatId, uid: formatted.uid }, "User unmuted bot");
    return true;
  }

  if (rule === "self_mute_request") {
    muteUser(chatId, formatted.uid, 2);
    await sender.sendDirect(
      chatId,
      "好的，以后本喵不回复你的消息了喵~（发 /unmuteme 取消）",
      formatted.messageId,
    );
    logger.info({ chatId, uid: formatted.uid }, "User self-muted (level 2)");
    return true;
  }

  if (rule === "self_unmute_request") {
    unmuteUser(chatId, formatted.uid);
    await sender.sendDirect(chatId, "好的，本喵又会回复你的消息了喵~", formatted.messageId);
    logger.info({ chatId, uid: formatted.uid }, "User self-unmuted");
    return true;
  }

  return false;
}

// Mutable holder for the per-chat lock that processPipeline acquires once,
// releases before slow AI work, and re-acquires before sending. The holder
// lets stage helpers update both fields in place without losing identity.
interface ChatLockState {
  release: () => Promise<void>;
  held: boolean;
}

// Reply generation, send, and post-send bookkeeping. Wraps everything in a
// try/catch with a fallback error message and reply_max placeholder cleanup.
async function generateAndSendReplies(args: {
  job: ChatJob;
  formatted: FormattedMessage;
  judgeResult: JudgeResult;
  botUid: number;
  effectiveReplyPath: ReplyPath;
  effectiveReplyTier: ReplyTier;
  e: ReturnType<typeof env>;
  start: number;
  timings: Record<string, number>;
  lockState: ChatLockState;
  releaseHeldChatLock: () => Promise<void>;
}): Promise<void> {
  const {
    job,
    formatted,
    judgeResult,
    botUid,
    effectiveReplyPath,
    effectiveReplyTier,
    e,
    start,
    timings,
    lockState,
    releaseHeldChatLock,
  } = args;

  let maxPlaceholderMsgId: number | undefined;
  try {
    // 6. reply_max: quota check + thinking placeholder
    if (effectiveReplyTier === "max") {
      const remaining = getRemainingMaxQuota(formatted.uid);
      if (remaining <= 0) {
        await sender.sendDirect(
          job.chatId,
          "今天的深度思考次数已用完喵（每人每天3次）~",
          formatted.messageId,
        );
        logger.info({ chatId: job.chatId, uid: formatted.uid }, "reply_max quota exhausted");
        return;
      }
      maxPlaceholderMsgId = await sendMessage(job.chatId, "💭 思考中…");
    }

    // 6b. Send typing indicator
    await sendChatAction(job.chatId, "typing");

    // 7. 4-way context retrieval
    const t4 = performance.now();
    const retrievalMode = effectiveReplyPath === "planned" ? "planned" : "direct";
    const retrievedContext = await retrieveContext(job.chatId, formatted, botUid, {
      mode: retrievalMode,
    });
    timings["retrieval"] = Math.round(performance.now() - t4);

    // 8. Generate reply (returns array for multi-reply support)
    const t5 = performance.now();
    const replyResult = await generateReply(
      formatted,
      retrievedContext,
      judgeResult.action,
      job.chatId,
      botUid,
      effectiveReplyPath,
      effectiveReplyTier,
    );
    const replies = replyResult.replies;
    timings["reply"] = Math.round(performance.now() - t5);

    lockState.release = await acquireChatLock(job.chatId);
    lockState.held = true;

    if (
      await shouldSuppressStaleReply(
        job.chatId,
        formatted,
        judgeResult.rule,
        botUid,
        e.JUDGE_WINDOW_SIZE,
      )
    ) {
      if (maxPlaceholderMsgId) {
        await deleteMessage(job.chatId, maxPlaceholderMsgId).catch(() => {});
      }
      logger.info(
        { chatId: job.chatId, messageId: formatted.messageId, rule: judgeResult.rule },
        "Concurrent reply suppressed after newer assistant turn",
      );
      return;
    }

    // 9. Send all replies to Telegram
    const t6 = performance.now();
    const sentMessages: Array<{ messageId: number; text: string }> = [];

    const override = await loadOverrideCached(getRedis()).catch(() => null);
    const stickerPolicy = {
      enabled: override?.sticker_policy?.enabled ?? true,
      mode: override?.sticker_policy?.mode ?? "ai",
      sendPosition: override?.sticker_policy?.send_position ?? "after",
    };
    const replyQuoteEnabled = override?.reply_quote !== false;

    const allSameTarget =
      replies.length > 1 &&
      replies.every((r) => r.targetMessageId === replies[0]!.targetMessageId);

    const sendResults = await Promise.allSettled(
      replies.map(async (reply, replyIdx) => {
        let stickerFileId: string | undefined;
        let stickerFileUniqueId: string | undefined;
        let stickerIntent: string | undefined;
        if (
          stickerPolicy.enabled &&
          stickerPolicy.mode !== "off" &&
          reply.stickerIntent &&
          reply.stickerIntent.length > 0 &&
          _repliesSinceLastSticker >= STICKER_COOLDOWN_REPLIES
        ) {
          const candidates = getReadyStickersByIntent(reply.stickerIntent);
          if (candidates.length > 0) {
            candidates.sort((a, b) => b.score - a.score);
            const fresh = candidates.filter((c) => !_recentStickerIds.has(c.fileUniqueId));
            const pool = (fresh.length > 0 ? fresh : candidates).slice(0, 10);
            const picked = pool[Math.floor(Math.random() * pool.length)]!;
            _trackRecentSticker(picked.fileUniqueId);
            stickerFileId = picked.fileId;
            stickerFileUniqueId = picked.fileUniqueId;
            stickerIntent = reply.stickerIntent[0];
          }
        }

        if (stickerFileId && stickerPolicy.sendPosition === "before") {
          const stickerMsgId = await sendSticker(job.chatId, stickerFileId).catch((err) => {
            logger.warn({ err, chatId: job.chatId }, "Sticker send (before) failed, continuing");
            return undefined;
          });
          if (stickerMsgId && stickerFileUniqueId) {
            recordStickerSent(job.chatId, stickerMsgId, stickerFileUniqueId, stickerFileId, stickerIntent);
          }
        }

        const replyToId =
          !replyQuoteEnabled ||
          reply.replyQuote === false ||
          (allSameTarget && replyIdx > 0)
            ? undefined
            : reply.targetMessageId;

        const isStickerOnly = reply.replyContent.trim() === '[sticker]' && stickerFileId;

        if (!isStickerOnly) {
          const sent = await sender.sendDirect(job.chatId, reply.replyContent, replyToId);

          if (stickerFileId && stickerPolicy.sendPosition === "after") {
            const stickerMsgId = await sendSticker(job.chatId, stickerFileId).catch((err) => {
              logger.warn({ err, chatId: job.chatId }, "Sticker send (after) failed, continuing");
              return undefined;
            });
            if (stickerMsgId && stickerFileUniqueId) {
              recordStickerSent(job.chatId, stickerMsgId, stickerFileUniqueId, stickerFileId, stickerIntent);
            }
          }

          return { messageId: sent.messageId, text: reply.replyContent };
        }

        if (stickerFileId) {
          const stickerMsgId = await sendSticker(job.chatId, stickerFileId).catch((err) => {
            logger.warn({ err, chatId: job.chatId }, "Sticker-only send failed");
            return undefined;
          });
          if (stickerMsgId && stickerFileUniqueId) {
            recordStickerSent(job.chatId, stickerMsgId, stickerFileUniqueId, stickerFileId, stickerIntent);
          }
          return { messageId: stickerMsgId ?? 0, text: '[sticker]' };
        }
        return { messageId: 0, text: '' };
      }),
    );

    for (let replyIdx = 0; replyIdx < sendResults.length; replyIdx++) {
      const result = sendResults[replyIdx]!;
      if (result.status === "fulfilled") {
        sentMessages.push(result.value);
        _repliesSinceLastSticker++;
      } else {
        logger.error(
          { chatId: job.chatId, targetMessageId: replies[replyIdx]!.targetMessageId, err: result.reason },
          "Failed to send reply in multi-reply sequence",
        );
      }
    }
    timings["send"] = Math.round(performance.now() - t6);

    if (sentMessages.length === 0) {
      throw new Error("All replies failed to send");
    }

    // Edit reply_max placeholder to first reply (avoids delete+send flicker)
    if (maxPlaceholderMsgId && sentMessages.length > 0) {
      const first = sentMessages[0]!;
      await editMessage(job.chatId, maxPlaceholderMsgId, first.text).catch((err) => {
        logger.warn({ err, chatId: job.chatId }, "Failed to edit placeholder, leaving as-is");
      });
      sentMessages[0] = { messageId: maxPlaceholderMsgId, text: first.text };
    } else if (maxPlaceholderMsgId) {
      await deleteMessage(job.chatId, maxPlaceholderMsgId).catch(() => {});
    }

    if (effectiveReplyTier === "max") {
      consumeMaxQuota(formatted.uid);
      logger.info(
        { chatId: job.chatId, uid: formatted.uid },
        "reply_max quota consumed after success",
      );
    }

    await reflectChatPathPolicy({
      chatId: job.chatId,
      message: formatted,
      botUid,
      effectiveReplyPath,
      replyText: sentMessages[0]?.text ?? "",
      toolsUsed: replyResult.toolsUsed,
      toolExecutionFailed: replyResult.toolExecutionFailed,
    }).catch((err) => {
      logger.debug({ err, chatId: job.chatId }, "Path policy reflection failed (non-critical)");
    });

    // 10. Save ALL sent assistant messages to context (parallel)
    const t7 = performance.now();
    await Promise.all(
      sentMessages.map((sent) =>
        addAssistant(job.chatId, {
          textContent: sent.text,
          messageId: sent.messageId,
        }),
      ),
    );
    timings["saveAssistant"] = Math.round(performance.now() - t7);
    await releaseHeldChatLock();

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
        logger.debug({ err, chatId: job.chatId }, "Outcome recording failed (non-critical)");
      });
    }

    const totalMs = Math.round(performance.now() - start);
    // Demoted to debug: per-reply timing dump is heavy. Failures and notable
    // events (quota, suppression, mute) still log at info.
    logger.debug(
      {
        chatId: job.chatId,
        messageId: formatted.messageId,
        action: judgeResult.action,
        replyPath: effectiveReplyPath,
        replyTier: effectiveReplyTier,
        retrievalMode,
        recentCount: retrievedContext.recent.length,
        semanticCount: retrievedContext.semantic.length,
        threadCount: retrievedContext.thread.length,
        entityCount: retrievedContext.entity.length,
        retrievalMs: timings["retrieval"] ?? 0,
        replyMs: timings["reply"] ?? 0,
        replyCount: sentMessages.length,
        replyMsgIds: sentMessages.map((s) => s.messageId),
        totalMs,
        timings,
      },
      "Pipeline complete",
    );
  } catch (err) {
    if (maxPlaceholderMsgId) {
      await deleteMessage(job.chatId, maxPlaceholderMsgId).catch(() => {});
    }

    const totalMs = Math.round(performance.now() - start);
    logger.error(
      {
        chatId: job.chatId,
        messageId: formatted.messageId,
        action: judgeResult.action,
        totalMs,
        timings,
        err,
      },
      "Pipeline reply/send failed",
    );

    try {
      await sender.sendDirect(
        job.chatId,
        "喵呜...本喵出了点小故障，稍后再试试吧 >_<",
      );
    } catch {
      logger.warn({ chatId: job.chatId }, "Fallback message also failed");
    }
  }
}

// Pre-mute-gate intercepts: DM-only command guard, consent reply detection.
// Runs BEFORE the mute gate so consent acks can land even when the user has
// soft-muted the bot, and DM /checkin gets the right error message.
async function tryPreMuteIntercepts(
  chatId: number,
  formatted: FormattedMessage,
  judgeResult: JudgeResult,
): Promise<boolean> {
  // DM: disable group-only commands (/checkin, /stats)
  if (chatId > 0 && judgeResult.rule === "whitelisted_command") {
    const cmd = (formatted.textContent || "")
      .trim()
      .split(/[\s@]/)[0]
      ?.toLowerCase();
    if (cmd === "/checkin" || cmd === "/stats") {
      await sender.sendDirect(chatId, "签到和统计功能只在群里有效喵~", formatted.messageId);
      return true;
    }
  }

  // Consent reply detection (group, replying to bot's consent question)
  if (chatId < 0 && judgeResult.rule === "reply_to_self" && formatted.replyTo) {
    const consentResult = detectConsentReply(
      formatted.textContent || "",
      formatted.replyTo.textSnippet,
    );
    if (consentResult) {
      setConsent(chatId, formatted.uid, consentResult.approved ? "approved" : "denied");
      const ack = consentResult.approved ? "好的，已记录同意~" : "好的，不会转发消息给你~";
      await sender.sendDirect(chatId, ack, formatted.messageId);
      logger.info(
        { chatId, uid: formatted.uid, approved: consentResult.approved },
        "Consent reply processed",
      );
      return true;
    }
  }

  return false;
}

// Post-mute-gate intercepts: sticker_dislike, remember/view/forget preferences,
// and DM relay. Run after the mute gate so a muted user can't trigger them.
async function tryPostMuteIntercepts(
  chatId: number,
  formatted: FormattedMessage,
  judgeResult: JudgeResult,
  e: ReturnType<typeof env>,
): Promise<boolean> {
  // Sticker dislike interception
  if (judgeResult.rule === "sticker_dislike" && formatted.replyTo) {
    const sent = lookupSentSticker(chatId, formatted.replyTo.messageId);
    if (sent) {
      recordStickerDislike(sent.fileUniqueId, chatId, formatted.uid);
      const score = getStickerScore(sent.fileUniqueId);
      const ack =
        score <= 0.1
          ? "好的，这个贴纸不会再出现了喵~"
          : "知道了，下次少用这个贴纸~";
      await sender.sendDirect(chatId, ack, formatted.messageId);
      logger.info(
        { chatId, fileUniqueId: sent.fileUniqueId, newScore: score, userId: formatted.uid },
        "Sticker dislike recorded",
      );
      return true;
    }
    // sent not found → fall through to normal reply flow
  }

  // Remember request — extract content to save, fall through if empty/error
  if (judgeResult.rule === "remember_request" && !formatted.isAnonymous) {
    const text = (formatted.textContent || formatted.captionContent || "").trim();
    const content = text
      .replace(
        /^(?:帮[我俺]?记(?:住|一下|下来?)|记(?:住|下来?)(?:一下)?[：:，,]\s*|keep\s+in\s+mind[：:，,\s]*|记得(?:一下)?[：:，,]\s*)/i,
        "",
      )
      .trim();
    if (content) {
      try {
        saveUserPreference(chatId, formatted.uid, content);
        logger.info({ chatId, uid: formatted.uid, content }, "User preference saved");
        await sender.sendDirect(chatId, "记住啦喵~", formatted.messageId);
        return true;
      } catch (err) {
        logger.warn({ err, chatId }, "saveUserPreference failed");
        // fall through to normal reply on error
      }
    }
  }

  // View preferences request
  if (judgeResult.rule === "view_prefs_request" && !formatted.isAnonymous) {
    const prefs = getUserPreferences(chatId, formatted.uid);
    const profile = getUserProfilePrompt(chatId, formatted.uid);
    const parts: string[] = [];
    if (profile) parts.push(`🧠 本喵对你的印象：\n${profile}`);
    if (prefs) parts.push(`📝 你让本喵记住的：\n${prefs}`);
    const reply = parts.length > 0 ? parts.join('\n\n') : '本喵还没记住什么呢喵~';
    await sender.sendDirect(chatId, reply, formatted.messageId);
    return true;
  }

  // Forget preference request
  if (judgeResult.rule === "forget_request" && !formatted.isAnonymous) {
    const text = (formatted.textContent || "").trim();
    const keyword = text
      .replace(
        /^(?:忘(?:掉|了|记)?[：:，,\s]*|别记了[：:，,\s]*|不用记了[：:，,\s]*|forget\s*)/i,
        "",
      )
      .trim();
    if (keyword) {
      const deleted = deleteUserPreference(chatId, formatted.uid, keyword);
      await sender.sendDirect(
        chatId,
        deleted ? `已经忘掉「${deleted}」了喵~` : "没找到相关的记忆喵~",
        formatted.messageId,
      );
      return true;
    }
    // No keyword — fall through to normal reply
  }

  // DM relay intercept (private chat only)
  if (chatId > 0 && judgeResult.rule === "private_chat") {
    const text = formatted.textContent || "";
    const maybeRelay =
      /群|看看|瞅瞅|瞄|告诉|传话|转告|转达|发给|传给|带话|送给|转发|@/.test(text);
    if (maybeRelay) {
      await sendChatAction(chatId, "typing");
      const intent = await detectDmIntentWithAI(text, e.BOT_USERNAME);
      if (intent.type !== "normal_chat") {
        try {
          await handleDmRelay(chatId, formatted, intent);
        } catch (err) {
          logger.error({ err, chatId }, "DM relay failed");
          await sender.sendDirect(chatId, "处理失败了喵，稍后再试~", formatted.messageId);
        }
        return true;
      }
    }
    // normal_chat → fall through to regular reply pipeline
  }

  return false;
}

export async function processPipeline(job: ChatJob): Promise<void> {
  const start = performance.now();
  const timings: Record<string, number> = {};
  const lockState: ChatLockState = {
    release: await acquireChatLock(job.chatId),
    held: true,
  };

  const releaseHeldChatLock = async (): Promise<void> => {
    if (!lockState.held) return;
    lockState.held = false;
    await lockState.release();
  };

  try {
    // 1. Format message
    const t0 = performance.now();
    const formatted = formatMessage(job.update);
    if (!formatted) {
      logger.debug({ chatId: job.chatId }, "Skipping non-formattable update");
      return;
    }
    timings["format"] = Math.round(performance.now() - t0);

    // 1.5 Channel source ingestion — store and return, no reply
    const channelSourceIds = env().CHANNEL_SOURCE_IDS;
    if (channelSourceIds.length > 0 && channelSourceIds.includes(job.chatId)) {
      const text = formatted.textContent || formatted.captionContent || "";
      if (text.trim()) {
        memorizeMessage(job.chatId, formatted).catch((err) => {
          logger.debug({ err, chatId: job.chatId }, "Channel source memory write failed");
        });
        logger.debug(
          { chatId: job.chatId, messageId: formatted.messageId, len: text.length },
          "Channel source ingested",
        );
      }
      return;
    }

    // 2. Media stage — vision / sticker / multimodal / replyTo attachments
    const hasMedia = !!(
      formatted.imageFileId ||
      formatted.sticker ||
      formatted.audioFileId ||
      formatted.voiceFileId ||
      formatted.documentFileId ||
      formatted.videoFileId ||
      formatted.videoNoteFileId
    );
    const tmedia = performance.now();
    await processMedia(formatted);
    if (hasMedia) {
      timings["media"] = Math.round(performance.now() - tmedia);
    }

    // 3. Save to context
    const t2 = performance.now();
    await addMessage(job.chatId, formatted);
    timings["save"] = Math.round(performance.now() - t2);

    // 3.1 Long-term memory write (fire-and-forget, non-blocking)
    memorizeMessage(job.chatId, formatted).catch((err) => {
      logger.debug(
        { err, chatId: job.chatId },
        "Memory write failed (non-critical)",
      );
    });

    const e = env();
    const botUid = getBotUid();

    // 3.4 DM pending group selection intercept (before judge, DM only)
    if (job.chatId > 0) {
      const trimmedText = (formatted.textContent || "").trim();
      const num = parseInt(trimmedText, 10);
      if (!isNaN(num) && num > 0 && trimmedText === String(num)) {
        const pending = await getPendingGroupSelection(formatted.uid);
        if (pending && num <= pending.groups.length) {
          await clearPendingGroupSelection(formatted.uid);
          const selectedGroup = pending.groups[num - 1]!;
          logger.info(
            {
              uid: formatted.uid,
              selectedGroup: selectedGroup.title,
              intent: pending.intent,
            },
            "Pending group selection resolved",
          );
          try {
            await handlePendingGroupSelection(
              job.chatId,
              formatted,
              selectedGroup,
              pending.intent,
              pending.targetHandle,
              pending.content,
            );
          } catch (err) {
            logger.error(
              { err, chatId: job.chatId },
              "Pending group selection handler failed",
            );
            await sender.sendDirect(
              job.chatId,
              "处理失败了喵，稍后再试~",
              formatted.messageId,
            );
          }
          return;
        }
      }
    }

    // 3.5 Record group activity
    recordActivity(job.chatId, formatted.messageId, formatted.uid).catch(
      (err) => {
        logger.debug(
          { err, chatId: job.chatId },
          "Activity tracking failed (non-critical)",
        );
      },
    );

    // 3.6 Bot interaction tracking
    if (formatted.isBot && formatted.username) {
      try {
        getBotTracker()?.recordInteraction(job.chatId, {
          ts: formatted.timestamp,
          type: "message",
          bot: formatted.username,
          uid: formatted.uid,
          text: formatted.textContent,
          mid: formatted.messageId,
        });
      } catch (err) {
        logger.debug(
          { err, chatId: job.chatId },
          "Bot interaction tracking failed (non-critical)",
        );
      }

      // Fire-and-forget digest generation if enough records accumulated
      tryGenerateDigest(job.chatId, formatted.username).catch((err) => {
        logger.debug(
          { err, chatId: job.chatId },
          "Bot digest generation failed (non-critical)",
        );
      });
    }

    // 3.7 Check reply outcomes + trigger self-reflection
    if (e.OUTCOME_TRACKING_ENABLED) {
      checkOutcome(job.chatId, formatted, e.BOT_USERNAME)
        .then(({ needsReflection }) => {
          if (needsReflection) {
            generateReflection(job.chatId, async (prompt) => {
              try {
                const result = await callWithFallback({
                  usage: "summarize",
                  messages: [{ role: "user", content: prompt }],
                  maxTokens: 300,
                  temperature: 0.3,
                });
                return result.content;
              } catch (err) {
                logger.warn(
                  { err, chatId: job.chatId },
                  "Reflection AI call failed",
                );
                return null;
              }
            }).catch((err) => {
              logger.debug(
                { err, chatId: job.chatId },
                "generateReflection failed (non-critical)",
              );
            });
          }
        })
        .catch((err) => {
          logger.debug(
            { err, chatId: job.chatId },
            "Outcome check failed (non-critical)",
          );
        });
    }

    // 3.8 Record user message for profile (fire-and-forget, humans only)
    if (
      !formatted.isBot &&
      !formatted.isAnonymous &&
      formatted.textContent.trim()
    ) {
      try {
        recordUserMessage(
          job.chatId,
          formatted.uid,
          formatted.username,
          formatted.fullName,
          formatted.senderTag,
          formatted.textContent,
        );
      } catch (err) {
        logger.debug(
          { err, chatId: job.chatId },
          "User profile record failed (non-critical)",
        );
      }
    }

    // 4. Judge (L0 → L1 → L2)
    const t3 = performance.now();
    // Fetch larger window once; L1 uses full set, L0/L2 slice as needed
    const recentMessagesL2 = await getRecent(job.chatId, e.JUDGE_WINDOW_SIZE * 3);
    const recentMessages = recentMessagesL2.slice(-e.JUDGE_WINDOW_SIZE);

    const now = Math.floor(Date.now() / 1000);
    const fiveMinAgo = now - 300;
    const oneHourAgo = now - 3600;
    const messagesLast5Min = recentMessages.filter(
      (m) => m.timestamp >= fiveMinAgo,
    ).length;
    const messagesLast1Hour = recentMessages.filter(
      (m) => m.timestamp >= oneHourAgo,
    ).length;

    const judgeResult = await judge({
      message: formatted,
      recentMessages,
      recentMessagesL2,
      botUid,
      botUsername: e.BOT_USERNAME,
      botNicknames: e.BOT_NICKNAMES,
      chatId: job.chatId,
      groupActivity: { messagesLast5Min, messagesLast1Hour },
    });
    timings["judge"] = Math.round(performance.now() - t3);

    // If L0 returned REPLY without a replyPath (reply_to_self / mention_self),
    // ask L1 micro judge to decide direct vs planned so natural language works.
    if (
      judgeResult.action === "REPLY" &&
      judgeResult.replyPath === undefined &&
      judgeResult.level === "L0_RULE"
    ) {
      const { microJudge } = await import("./judge/micro.js");
      const pathResult = await microJudge(
        formatted,
        recentMessages,
        botUid,
        "judge",
        "",
        job.chatId,
      );
      if (pathResult.replyPath) {
        judgeResult.replyPath = pathResult.replyPath;
      }
      if (pathResult.replyTier) {
        judgeResult.replyTier = pathResult.replyTier;
      }
    }

    const rawReplyPath = resolveReplyPath(
      judgeResult.action,
      judgeResult.replyPath,
    );
    const effectiveReplyTier = resolveReplyTier(
      judgeResult.action,
      judgeResult.replyTier,
    );
    const pathPolicyDecision =
      judgeResult.action === "REPLY" && rawReplyPath
        ? await applyChatPathPolicy({
            chatId: job.chatId,
            message: formatted,
            botUid,
            rawReplyPath,
          })
        : {
            replyPath: rawReplyPath ?? "direct",
            matchedPatterns: [],
            source: "raw" as const,
          };
    const effectiveReplyPath = pathPolicyDecision.replyPath;

    // Demoted to debug: this fires for every formattable message and is the
    // single largest source of pipeline log volume. Action errors / quota
    // hits / mute changes elsewhere still log at info.
    logger.debug(
      {
        chatId: job.chatId,
        messageId: formatted.messageId,
        from: formatted.username || formatted.fullName,
        action: judgeResult.action,
        rawReplyPath,
        replyPath: effectiveReplyPath,
        replyTier: effectiveReplyTier,
        pathPolicySource: pathPolicyDecision.source,
        pathPolicyPatterns: pathPolicyDecision.matchedPatterns,
        level: judgeResult.level,
        rule: judgeResult.rule,
        confidence: judgeResult.confidence,
        judgeMs: judgeResult.latencyMs,
      },
      `Judge: ${judgeResult.action}`,
    );

    // 5. If IGNORE/REJECT → return
    if (judgeResult.action === "IGNORE" || judgeResult.action === "REJECT") {
      const totalMs = Math.round(performance.now() - start);
      logger.debug(
        { chatId: job.chatId, totalMs, timings },
        "Pipeline complete (no reply)",
      );
      return;
    }

    let muteState = !formatted.isAnonymous
      ? getMuteState(job.chatId, formatted.uid)
      : { level: 0 as const, temporary: false };

    if (
      !formatted.isAnonymous &&
      job.chatId < 0 &&
      muteState.temporary &&
      TEMP_MUTE_CLEAR_RULES.has(judgeResult.rule ?? "")
    ) {
      unmuteUser(job.chatId, formatted.uid);
      muteState = { level: 0, temporary: false };
      logger.info(
        { chatId: job.chatId, uid: formatted.uid, rule: judgeResult.rule },
        "Temporary mute cleared by direct interaction",
      );
    }

    // 5.4 / 5.41 / 5.41b Mute / unmute / self-mute commands
    if (await tryMuteCommandIntercepts(job.chatId, formatted, judgeResult)) {
      return;
    }

    // 5.42 Pre-mute-gate intercepts (DM command guard, consent reply)
    if (await tryPreMuteIntercepts(job.chatId, formatted, judgeResult)) {
      return;
    }

    // 5.45 Mute gate
    if (!formatted.isAnonymous) {
      if (muteState.level === 2) {
        // Full silence — ignore everything except unmute (handled above)
        logger.debug(
          { chatId: job.chatId, uid: formatted.uid },
          "Pipeline: user hard-muted bot, skipping reply",
        );
        return;
      }
      if (
        muteState.level === 1 &&
        judgeResult.rule !== "reply_to_self" &&
        judgeResult.rule !== "mention_self" &&
        judgeResult.rule !== "whitelisted_command" &&
        !judgeResult.rule?.includes("lookup")
      ) {
        // Soft mute — only block proactive replies, allow direct interactions
        logger.debug(
          { chatId: job.chatId, uid: formatted.uid },
          "Pipeline: user soft-muted bot, skipping proactive reply",
        );
        return;
      }
    }

    // 5.5 / 5.6 / 5.61 / 5.62 / 5.7 Post-mute-gate intercepts
    if (await tryPostMuteIntercepts(job.chatId, formatted, judgeResult, e)) {
      return;
    }

    await releaseHeldChatLock();

    // 6-11: Reply generation, send, and post-send bookkeeping
    if (!effectiveReplyPath || !effectiveReplyTier) {
      logger.warn(
        { chatId: job.chatId, judgeAction: judgeResult.action },
        "Reached reply stage without effective path/tier — skipping",
      );
      return;
    }
    await generateAndSendReplies({
      job,
      formatted,
      judgeResult,
      botUid,
      effectiveReplyPath,
      effectiveReplyTier,
      e,
      start,
      timings,
      lockState,
      releaseHeldChatLock,
    });
  } finally {
    await releaseHeldChatLock();
  }
}

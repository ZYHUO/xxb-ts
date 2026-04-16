// ────────────────────────────────────────
// Pipeline Orchestrator — full message pipeline
// ────────────────────────────────────────

import type { ChatJob } from "../shared/types.js";
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

export async function processPipeline(job: ChatJob): Promise<void> {
  const start = performance.now();
  const timings: Record<string, number> = {};
  let releaseChatLock = await acquireChatLock(job.chatId);
  let chatLockHeld = true;

  const releaseHeldChatLock = async (): Promise<void> => {
    if (!chatLockHeld) return;
    chatLockHeld = false;
    await releaseChatLock();
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
        logger.info(
          { chatId: job.chatId, messageId: formatted.messageId, len: text.length },
          "Channel source ingested",
        );
      }
      return;
    }

    // 2. Vision / Sticker / Multimodal — run in parallel
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
      const tmedia = performance.now();
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

    logger.info(
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

    // 5.4 Mute/unmute interception — must be handled before the mute gate (group only)
    if (
      judgeResult.rule === "mute_hard_request" &&
      !formatted.isAnonymous &&
      job.chatId < 0
    ) {
      muteUser(job.chatId, formatted.uid, 2);
      await sender.sendDirect(
        job.chatId,
        "好的，本喵完全闭嘴喵~",
        formatted.messageId,
      );
      logger.info(
        { chatId: job.chatId, uid: formatted.uid, level: 2 },
        "User hard-muted bot",
      );
      return;
    }

    if (
      judgeResult.rule === "mute_soft_request" &&
      !formatted.isAnonymous &&
      job.chatId < 0
    ) {
      muteUser(job.chatId, formatted.uid, 1, { temporary: true });
      await sender.sendDirect(
        job.chatId,
        "好的，本喵不会主动找你说话了喵~",
        formatted.messageId,
      );
      logger.info(
        { chatId: job.chatId, uid: formatted.uid, level: 1 },
        "User soft-muted bot",
      );
      return;
    }

    if (
      judgeResult.rule === "mute_timed_request" &&
      !formatted.isAnonymous &&
      job.chatId < 0
    ) {
      const text = formatted.textContent || formatted.captionContent || "";
      const durationMs = parseMuteTimedRequest(text);
      if (durationMs && durationMs > 0) {
        muteUser(job.chatId, formatted.uid, 1, { temporary: true, durationMs });
        const minutes = Math.round(durationMs / 60_000);
        await sender.sendDirect(
          job.chatId,
          `好的，本喵安静 ${minutes} 分钟喵~`,
          formatted.messageId,
        );
        logger.info(
          { chatId: job.chatId, uid: formatted.uid, durationMs },
          "User timed-muted bot",
        );
        return;
      }
    }

    if (
      judgeResult.rule === "unmute_request" &&
      !formatted.isAnonymous &&
      job.chatId < 0
    ) {
      unmuteUser(job.chatId, formatted.uid);
      await sender.sendDirect(
        job.chatId,
        "嗯！本喵又可以说话啦喵~",
        formatted.messageId,
      );
      logger.info(
        { chatId: job.chatId, uid: formatted.uid },
        "User unmuted bot",
      );
      return;
    }

    // 5.41 Self-mute commands (/muteme / /unmuteme) — group only
    if (
      judgeResult.rule === "self_mute_request" &&
      !formatted.isAnonymous &&
      job.chatId < 0
    ) {
      muteUser(job.chatId, formatted.uid, 2);
      await sender.sendDirect(
        job.chatId,
        "好的，以后本喵不回复你的消息了喵~（发 /unmuteme 取消）",
        formatted.messageId,
      );
      logger.info(
        { chatId: job.chatId, uid: formatted.uid },
        "User self-muted (level 2)",
      );
      return;
    }

    if (
      judgeResult.rule === "self_unmute_request" &&
      !formatted.isAnonymous &&
      job.chatId < 0
    ) {
      unmuteUser(job.chatId, formatted.uid);
      await sender.sendDirect(
        job.chatId,
        "好的，本喵又会回复你的消息了喵~",
        formatted.messageId,
      );
      logger.info(
        { chatId: job.chatId, uid: formatted.uid },
        "User self-unmuted",
      );
      return;
    }

    // 5.41b Anonymous identity (channel) can't use mute commands
    if (
      (judgeResult.rule === "self_mute_request" ||
        judgeResult.rule === "self_unmute_request") &&
      formatted.isAnonymous
    ) {
      await sender.sendDirect(
        job.chatId,
        "频道身份没法用这个命令喵，用个人身份试试~",
        formatted.messageId,
      );
      return;
    }

    // 5.42a DM: disable group-only commands (/checkin, /stats)
    if (job.chatId > 0 && judgeResult.rule === "whitelisted_command") {
      const cmd = (formatted.textContent || "")
        .trim()
        .split(/[\s@]/)[0]
        ?.toLowerCase();
      if (cmd === "/checkin" || cmd === "/stats") {
        await sender.sendDirect(
          job.chatId,
          "签到和统计功能只在群里有效喵~",
          formatted.messageId,
        );
        return;
      }
    }

    // 5.42b Consent reply detection (group messages replying to bot's consent question)
    if (
      job.chatId < 0 &&
      judgeResult.rule === "reply_to_self" &&
      formatted.replyTo
    ) {
      const consentResult = detectConsentReply(
        formatted.textContent || "",
        formatted.replyTo.textSnippet,
      );
      if (consentResult) {
        setConsent(
          job.chatId,
          formatted.uid,
          consentResult.approved ? "approved" : "denied",
        );
        const ack = consentResult.approved
          ? "好的，已记录同意~"
          : "好的，不会转发消息给你~";
        await sender.sendDirect(job.chatId, ack, formatted.messageId);
        logger.info(
          {
            chatId: job.chatId,
            uid: formatted.uid,
            approved: consentResult.approved,
          },
          "Consent reply processed",
        );
        return;
      }
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

    // 5.5 Sticker dislike interception
    if (judgeResult.rule === "sticker_dislike" && formatted.replyTo) {
      const sent = lookupSentSticker(job.chatId, formatted.replyTo.messageId);
      if (sent) {
        recordStickerDislike(sent.fileUniqueId, job.chatId, formatted.uid);
        const score = getStickerScore(sent.fileUniqueId);
        const ack =
          score <= 0.1
            ? "好的，这个贴纸不会再出现了喵~"
            : "知道了，下次少用这个贴纸~";
        await sender.sendDirect(job.chatId, ack, formatted.messageId);
        logger.info(
          {
            chatId: job.chatId,
            fileUniqueId: sent.fileUniqueId,
            newScore: score,
            userId: formatted.uid,
          },
          "Sticker dislike recorded",
        );
        return;
      }
      // sent not found → fall through to normal reply flow
    }

    // 5.6 Remember request interception
    if (judgeResult.rule === "remember_request" && !formatted.isAnonymous) {
      const text = (
        formatted.textContent ||
        formatted.captionContent ||
        ""
      ).trim();
      // Strip the trigger phrase to extract what should be remembered
      const content = text
        .replace(
          /^(?:帮[我俺]?记(?:住|一下|下来?)|记(?:住|下来?)(?:一下)?[：:，,]\s*|keep\s+in\s+mind[：:，,\s]*|记得(?:一下)?[：:，,]\s*)/i,
          "",
        )
        .trim();
      if (!content) {
        // Trigger phrase only, nothing to save — fall through to normal reply
      } else {
        try {
          saveUserPreference(job.chatId, formatted.uid, content);
          logger.info(
            { chatId: job.chatId, uid: formatted.uid, content },
            "User preference saved",
          );
          await sender.sendDirect(job.chatId, "记住啦喵~", formatted.messageId);
          return;
        } catch (err) {
          logger.warn({ err, chatId: job.chatId }, "saveUserPreference failed");
          // fall through to normal reply on error
        }
      }
    }

    // 5.61 View preferences request
    if (judgeResult.rule === "view_prefs_request" && !formatted.isAnonymous) {
      const prefs = getUserPreferences(job.chatId, formatted.uid);
      const reply = prefs
        ? `本喵记住了这些喵~\n${prefs}`
        : "本喵还没记住什么呢喵~";
      await sender.sendDirect(job.chatId, reply, formatted.messageId);
      return;
    }

    // 5.62 Forget preference request
    if (judgeResult.rule === "forget_request" && !formatted.isAnonymous) {
      const text = (formatted.textContent || "").trim();
      const keyword = text
        .replace(
          /^(?:忘(?:掉|了|记)?[：:，,\s]*|别记了[：:，,\s]*|不用记了[：:，,\s]*|forget\s*)/i,
          "",
        )
        .trim();
      if (keyword) {
        const deleted = deleteUserPreference(
          job.chatId,
          formatted.uid,
          keyword,
        );
        if (deleted) {
          await sender.sendDirect(
            job.chatId,
            `已经忘掉「${deleted}」了喵~`,
            formatted.messageId,
          );
        } else {
          await sender.sendDirect(
            job.chatId,
            "没找到相关的记忆喵~",
            formatted.messageId,
          );
        }
        return;
      }
      // No keyword — fall through to normal reply
    }

    // 5.7 DM relay intercept (private chat only)
    if (job.chatId > 0 && judgeResult.rule === "private_chat") {
      const text = formatted.textContent || "";
      // Only call AI intent detection when message contains relay-related keywords
      const maybeRelay =
        /群|看看|瞅瞅|瞄|告诉|传话|转告|转达|发给|传给|带话|送给|转发|@/.test(
          text,
        );
      if (maybeRelay) {
        await sendChatAction(job.chatId, "typing");
        const intent = await detectDmIntentWithAI(text, e.BOT_USERNAME);
        if (intent.type !== "normal_chat") {
          try {
            await handleDmRelay(job.chatId, formatted, intent);
          } catch (err) {
            logger.error({ err, chatId: job.chatId }, "DM relay failed");
            await sender.sendDirect(
              job.chatId,
              "处理失败了喵，稍后再试~",
              formatted.messageId,
            );
          }
          return;
        }
      }
      // normal_chat → fall through to regular reply pipeline
    }

    await releaseHeldChatLock();

    // 6-10: Reply generation and send (with error recovery)
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
          logger.info(
            { chatId: job.chatId, uid: formatted.uid },
            "reply_max quota exhausted",
          );
          return;
        }
        // Send placeholder before slow AI call
        maxPlaceholderMsgId = await sendMessage(job.chatId, "💭 思考中…");
      }

      // 6b. Send typing indicator
      await sendChatAction(job.chatId, "typing");

      // 7. 4-way context retrieval
      const t4 = performance.now();
      const retrievalMode =
        effectiveReplyPath === "planned" ? "planned" : "direct";
      const retrievedContext = await retrieveContext(
        job.chatId,
        formatted,
        botUid,
        { mode: retrievalMode },
      );
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

      releaseChatLock = await acquireChatLock(job.chatId);
      chatLockHeld = true;

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
          {
            chatId: job.chatId,
            messageId: formatted.messageId,
            rule: judgeResult.rule,
          },
          "Concurrent reply suppressed after newer assistant turn",
        );
        return;
      }

      // 9. Send all replies to Telegram
      const t6 = performance.now();
      const sentMessages: Array<{ messageId: number; text: string }> = [];

      // Load sticker policy once
      const override = await loadOverrideCached(getRedis()).catch(() => null);
      const stickerPolicy = {
        enabled: override?.sticker_policy?.enabled ?? true,
        mode: override?.sticker_policy?.mode ?? "ai",
        sendPosition: override?.sticker_policy?.send_position ?? "after",
      };
      // reply_quote: true = attach reply_to (default), false = send without quoting
      const replyQuoteEnabled = override?.reply_quote !== false;

      // Check if all replies target the same message (single-target split)
      const allSameTarget =
        replies.length > 1 &&
        replies.every((r) => r.targetMessageId === replies[0]!.targetMessageId);

      // Send all replies in parallel, then collect results in order
      const sendResults = await Promise.allSettled(
        replies.map(async (reply, replyIdx) => {
          // Resolve sticker before sending if position is 'before'
          let stickerFileId: string | undefined;
          let stickerFileUniqueId: string | undefined;
          let stickerIntent: string | undefined;
          if (
            stickerPolicy.enabled &&
            stickerPolicy.mode !== "off" &&
            reply.stickerIntent &&
            reply.stickerIntent.length > 0 &&
            Math.random() < 0.15
          ) {
            const candidates = getReadyStickersByIntent(reply.stickerIntent);
            if (candidates.length > 0) {
              candidates.sort((a, b) => b.score - a.score);
              const pool = candidates.slice(0, 3);
              const picked = pool[Math.floor(Math.random() * pool.length)]!;
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
        }),
      );

      // Collect results in original order
      for (let replyIdx = 0; replyIdx < sendResults.length; replyIdx++) {
        const result = sendResults[replyIdx]!;
        if (result.status === "fulfilled") {
          sentMessages.push(result.value);
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

      // Edit reply_max thinking placeholder to show first reply (avoids delete+send flicker)
      if (maxPlaceholderMsgId && sentMessages.length > 0) {
        const first = sentMessages[0]!;
        await editMessage(job.chatId, maxPlaceholderMsgId, first.text).catch((err) => {
          logger.warn({ err, chatId: job.chatId }, "Failed to edit placeholder, leaving as-is");
        });
        // Replace the first sentMessage entry with the placeholder's messageId
        sentMessages[0] = { messageId: maxPlaceholderMsgId, text: first.text };
      } else if (maxPlaceholderMsgId) {
        await deleteMessage(job.chatId, maxPlaceholderMsgId).catch(() => {});
      }

      // Consume max quota only after successful reply
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
        logger.debug(
          { err, chatId: job.chatId },
          "Path policy reflection failed (non-critical)",
        );
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
          logger.debug(
            { err, chatId: job.chatId },
            "Outcome recording failed (non-critical)",
          );
        });
      }

      const totalMs = Math.round(performance.now() - start);
      logger.info(
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
      // Clean up reply_max placeholder on failure
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

      // Attempt fallback error message (best-effort)
      try {
        await sender.sendDirect(
          job.chatId,
          "喵呜...本喵出了点小故障，稍后再试试吧 >_<",
        );
      } catch {
        logger.warn({ chatId: job.chatId }, "Fallback message also failed");
      }
    }
  } finally {
    await releaseHeldChatLock();
  }
}

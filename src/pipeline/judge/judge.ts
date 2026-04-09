// ────────────────────────────────────────
// Judge 编排器 — L0 → L1 → L2 级联
// ────────────────────────────────────────

import type { FormattedMessage, JudgeResult } from '../../shared/types.js';
import type { RuleContext } from './rules.js';
import { evaluateRules } from './rules.js';
import { microJudge } from './micro.js';
import { logger } from '../../shared/logger.js';

export interface JudgeInput {
  message: FormattedMessage;
  recentMessages: FormattedMessage[];
  botUid: number;
  botUsername: string;
  botNicknames: string[];
  groupActivity: { messagesLast5Min: number; messagesLast1Hour: number };
}

function findLastBotReplyIndex(messages: FormattedMessage[], botUid: number): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && (msg.role === 'assistant' || msg.uid === botUid)) {
      return messages.length - 1 - i;
    }
  }
  return -1;
}

export async function judge(input: JudgeInput): Promise<JudgeResult> {
  const totalStart = performance.now();

  // ── L0: Local rules (0-5ms) ──
  const ruleCtx: RuleContext = {
    message: input.message,
    recentMessages: input.recentMessages,
    botUid: input.botUid,
    botUsername: input.botUsername,
    botNicknames: input.botNicknames,
    groupActivity: input.groupActivity,
    lastBotReplyIndex: findLastBotReplyIndex(input.recentMessages, input.botUid),
  };

  const l0Start = performance.now();
  const l0Result = evaluateRules(ruleCtx);
  if (l0Result) {
    l0Result.latencyMs = Math.round(performance.now() - l0Start);
    logger.debug({ rule: l0Result.rule, action: l0Result.action, ms: l0Result.latencyMs }, 'L0 rule matched');
    return l0Result;
  }

  // ── L1: Micro model (150-300ms) ──
  const l1Result = await microJudge(input.message, input.recentMessages, input.botUid, 'judge');
  if (l1Result.confidence !== undefined && l1Result.confidence > 0.8) {
    logger.debug({ action: l1Result.action, confidence: l1Result.confidence, ms: l1Result.latencyMs }, 'L1 high confidence');
    return l1Result;
  }

  // ── L2: Same as L1 but with M2_FAST and full context (Phase 1 simplified) ──
  const l2Result = await microJudge(input.message, input.recentMessages, input.botUid, 'reply');
  l2Result.level = 'L2_AI';

  const totalMs = Math.round(performance.now() - totalStart);
  logger.debug({
    action: l2Result.action,
    confidence: l2Result.confidence,
    l1Action: l1Result.action,
    l1Confidence: l1Result.confidence,
    totalMs,
  }, 'L2 judge complete');

  return l2Result;
}

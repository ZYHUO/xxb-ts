// ────────────────────────────────────────
// L0 本地规则引擎 (0-5ms)
// ────────────────────────────────────────

import type { FormattedMessage, JudgeResult, JudgeAction } from '../../shared/types.js';

export interface RuleContext {
  message: FormattedMessage;
  recentMessages: FormattedMessage[];
  botUid: number;
  botUsername: string;
  botNicknames: string[];
  chatId: number;
  groupActivity: { messagesLast5Min: number; messagesLast1Hour: number };
  lastBotReplyIndex: number; // how many messages ago bot last replied (-1 = never)
}

const WHITELISTED_COMMANDS = new Set(['/checkin', '/help', '/status']);

function makeResult(action: JudgeAction, rule: string): JudgeResult {
  return { action, level: 'L0_RULE', rule, latencyMs: 0 };
}

function isMentioningSelf(text: string, botUsername: string, botNicknames: string[]): boolean {
  const lower = text.toLowerCase();
  if (lower.includes(`@${botUsername.toLowerCase()}`)) return true;
  for (const nick of botNicknames) {
    if (nick && lower.includes(nick.toLowerCase())) return true;
  }
  return false;
}

function isReplyToSelf(msg: FormattedMessage, botUid: number): boolean {
  return msg.replyTo?.uid === botUid;
}

function getCommandName(text: string, botUsername: string): string | null {
  const match = text.match(/^\/(\w+)(?:@(\w+))?/);
  if (!match?.[1]) return null;
  // If @suffix is present, only handle if it targets our bot
  if (match[2] && match[2].toLowerCase() !== botUsername.toLowerCase()) return null;
  return `/${match[1]}`;
}

export function evaluateRules(ctx: RuleContext): JudgeResult | null {
  const { message: msg, botUid, botUsername, botNicknames, groupActivity, lastBotReplyIndex } = ctx;
  const text = msg.textContent || msg.captionContent || '';

  // 1. Bot message → probability-based reply decay (natural bot-to-bot interaction)
  if (msg.isBot && msg.uid !== botUid) {
    // Only consider replying if bot mentions us or replies to us
    if (!isMentioningSelf(text, botUsername, botNicknames) && !isReplyToSelf(msg, botUid)) {
      return makeResult('IGNORE', 'bot_message');
    }

    // Count consecutive bot-only messages (no human in between)
    let consecutiveBotMsgs = 0;
    for (let i = ctx.recentMessages.length - 1; i >= 0; i--) {
      const m = ctx.recentMessages[i]!;
      if (!m.isBot && m.uid !== botUid) break;
      consecutiveBotMsgs++;
    }

    // Probability decay: natural conversation fatigue
    // Round 1 (0-1 msgs): 100%  → always reply
    // Round 2 (2-3 msgs): 70%
    // Round 3 (4-5 msgs): 40%
    // Round 4 (6-7 msgs): 20%
    // Round 5 (8-9 msgs): 8%
    // Round 6+ (10+ msgs): 0% hard cap
    const replyProbability = [1.0, 1.0, 0.7, 0.7, 0.4, 0.4, 0.2, 0.2, 0.08, 0.08];
    const prob = replyProbability[Math.min(consecutiveBotMsgs, replyProbability.length - 1)] ?? 0;

    if (consecutiveBotMsgs >= replyProbability.length || Math.random() > prob) {
      return makeResult('IGNORE', 'bot_fatigue');
    }
    return makeResult('REPLY', 'bot_mentions_self');
  }

  // 2. Reply to self → REPLY
  if (isReplyToSelf(msg, botUid)) {
    return makeResult('REPLY', 'reply_to_self');
  }

  // 3. Slash commands — only if directed at us (no @suffix, or @our_bot)
  const cmd = getCommandName(text, botUsername);
  if (cmd) {
    if (WHITELISTED_COMMANDS.has(cmd)) {
      return makeResult('REPLY', 'whitelisted_command');
    }
    return makeResult('IGNORE', 'unknown_command');
  }

  // 4. Direct @self or nickname mention → REPLY
  if (isMentioningSelf(text, botUsername, botNicknames)) {
    return makeResult('REPLY', 'mention_self');
  }

  // 5. Forwarded message → IGNORE
  if (msg.isForwarded) {
    return makeResult('IGNORE', 'forwarded');
  }

  // 5.5 Private chat → always REPLY (chatId > 0 = private)
  if (ctx.chatId > 0) {
    return makeResult('REPLY', 'private_chat');
  }

  // 6. Hot chat (5min ≥ 20 msgs) AND not mentioned → IGNORE
  if (groupActivity.messagesLast5Min >= 20) {
    return makeResult('IGNORE', 'hot_chat');
  }

  // 7. Recent reply (last bot reply within 5 messages) AND not mentioned → IGNORE
  if (lastBotReplyIndex >= 0 && lastBotReplyIndex < 5) {
    return makeResult('IGNORE', 'recent_reply');
  }

  // 8. @others → IGNORE
  const atOtherMatch = text.match(/@(\w+)/g);
  if (atOtherMatch) {
    const mentionsOther = atOtherMatch.some((m) => m.toLowerCase() !== `@${botUsername.toLowerCase()}`);
    if (mentionsOther) {
      return makeResult('IGNORE', 'at_others');
    }
  }

  // No rule matched → pass to L1
  return null;
}

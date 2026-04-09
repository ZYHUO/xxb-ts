import { describe, it, expect } from 'vitest';
import { evaluateRules } from '../../../src/pipeline/judge/rules.js';
import type { RuleContext } from '../../../src/pipeline/judge/rules.js';
import type { FormattedMessage } from '../../../src/shared/types.js';

function makeMsg(overrides: Partial<FormattedMessage> = {}): FormattedMessage {
  return {
    role: 'user',
    uid: 1001,
    username: 'alice',
    fullName: 'Alice',
    timestamp: Math.floor(Date.now() / 1000),
    messageId: 100,
    textContent: 'Hello world',
    isForwarded: false,
    isBot: false,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    message: makeMsg(),
    recentMessages: [],
    botUid: 9999,
    botUsername: 'xxb_bot',
    botNicknames: ['xxb', '啾咪囝'],
    groupActivity: { messagesLast5Min: 5, messagesLast1Hour: 50 },
    lastBotReplyIndex: -1,
    ...overrides,
  };
}

describe('L0 Rules Engine', () => {
  it('bot message → IGNORE', () => {
    const ctx = makeCtx({ message: makeMsg({ isBot: true, uid: 2000, textContent: 'some bot msg' }) });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('IGNORE');
    expect(result!.rule).toBe('bot_message');
  });

  it('bot message @self → REPLY', () => {
    const ctx = makeCtx({
      message: makeMsg({ isBot: true, uid: 2000, textContent: 'hey @xxb_bot' }),
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('REPLY');
    expect(result!.rule).toBe('bot_mentions_self');
  });

  it('direct @self → REPLY', () => {
    const ctx = makeCtx({ message: makeMsg({ textContent: 'hello @xxb_bot how are you' }) });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('REPLY');
    expect(result!.rule).toBe('mention_self');
  });

  it('mention by nickname → REPLY', () => {
    const ctx = makeCtx({ message: makeMsg({ textContent: '啾咪囝你好呀' }) });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('REPLY');
    expect(result!.rule).toBe('mention_self');
  });

  it('reply to self → REPLY', () => {
    const ctx = makeCtx({
      message: makeMsg({ replyTo: { messageId: 50, uid: 9999, fullName: 'XXB', textSnippet: 'hi' } }),
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('REPLY');
    expect(result!.rule).toBe('reply_to_self');
  });

  it('slash command /checkin → REPLY', () => {
    const ctx = makeCtx({ message: makeMsg({ textContent: '/checkin' }) });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('REPLY');
    expect(result!.rule).toBe('whitelisted_command');
  });

  it('slash command /checkin@bot → REPLY', () => {
    const ctx = makeCtx({ message: makeMsg({ textContent: '/checkin@xxb_bot' }) });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('REPLY');
    expect(result!.rule).toBe('whitelisted_command');
  });

  it('slash command /checkin@other_bot → falls through (not our bot)', () => {
    const ctx = makeCtx({ message: makeMsg({ textContent: '/checkin@other_bot' }) });
    const result = evaluateRules(ctx);
    // Should NOT match as whitelisted_command since it's directed at another bot
    // Falls through to @others rule (contains @other_bot)
    expect(result).not.toBeNull();
    expect(result!.rule).not.toBe('whitelisted_command');
  });

  it('unknown slash command → IGNORE', () => {
    const ctx = makeCtx({ message: makeMsg({ textContent: '/foobar' }) });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('IGNORE');
    expect(result!.rule).toBe('unknown_command');
  });

  it('forwarded message → IGNORE', () => {
    const ctx = makeCtx({
      message: makeMsg({ isForwarded: true, forwardFrom: 'SomeUser' }),
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('IGNORE');
    expect(result!.rule).toBe('forwarded');
  });

  it('hot chat (5min ≥ 20 msgs) → IGNORE', () => {
    const ctx = makeCtx({
      groupActivity: { messagesLast5Min: 25, messagesLast1Hour: 100 },
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('IGNORE');
    expect(result!.rule).toBe('hot_chat');
  });

  it('hot chat but @self → REPLY', () => {
    const ctx = makeCtx({
      message: makeMsg({ textContent: 'xxb 你来说说' }),
      groupActivity: { messagesLast5Min: 25, messagesLast1Hour: 100 },
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('REPLY');
    expect(result!.rule).toBe('mention_self');
  });

  it('recent reply (within 5 messages) → IGNORE', () => {
    const ctx = makeCtx({ lastBotReplyIndex: 3 });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('IGNORE');
    expect(result!.rule).toBe('recent_reply');
  });

  it('@others → IGNORE', () => {
    const ctx = makeCtx({
      message: makeMsg({ textContent: 'hey @someone' }),
      lastBotReplyIndex: -1,
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('IGNORE');
    expect(result!.rule).toBe('at_others');
  });

  it('normal message (no rule hit) → null', () => {
    const ctx = makeCtx({
      message: makeMsg({ textContent: '今天天气真好' }),
      lastBotReplyIndex: -1,
      groupActivity: { messagesLast5Min: 5, messagesLast1Hour: 30 },
    });
    const result = evaluateRules(ctx);
    expect(result).toBeNull();
  });

  it('L0 result always has level L0_RULE', () => {
    const ctx = makeCtx({ message: makeMsg({ isForwarded: true }) });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.level).toBe('L0_RULE');
  });
});

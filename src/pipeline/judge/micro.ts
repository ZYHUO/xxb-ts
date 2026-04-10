// ────────────────────────────────────────
// L1 Micro model judge
// ────────────────────────────────────────

import type { FormattedMessage, JudgeAction, JudgeResult } from '../../shared/types.js';
import type { AICallResult } from '../../ai/types.js';
import { callWithFallback } from '../../ai/fallback.js';
import { slimContextForAI } from '../context/slim.js';
import { loadPrompt } from '../../shared/config.js';
import { getConfig } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';

const VALID_ACTIONS = new Set<JudgeAction>(['REPLY', 'REPLY_PRO', 'IGNORE', 'REJECT']);

export function parseJudgeAction(raw: string): { action: JudgeAction; confidence: number; reasoning: string } | null {
  // Strip markdown code blocks
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  cleaned = cleaned.trim();

  // Try JSON parse first
  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const action = (parsed['action'] ?? parsed['ACTION']) as string | undefined;
    if (action && VALID_ACTIONS.has(action.toUpperCase() as JudgeAction)) {
      return {
        action: action.toUpperCase() as JudgeAction,
        confidence: typeof parsed['confidence'] === 'number' ? parsed['confidence'] : 0.5,
        reasoning: typeof parsed['reasoning'] === 'string' ? parsed['reasoning'] : '',
      };
    }
  } catch {
    // not valid JSON
  }

  // Try regex for {"ACTION": "REPLY"} style
  const jsonMatch = cleaned.match(/"(?:action|ACTION)"\s*:\s*"(REPLY_PRO|REPLY|IGNORE|REJECT)"/i);
  if (jsonMatch?.[1]) {
    return {
      action: jsonMatch[1].toUpperCase() as JudgeAction,
      confidence: 0.5,
      reasoning: '',
    };
  }

  // Try keyword extraction
  const upper = cleaned.toUpperCase();
  for (const kw of ['REPLY_PRO', 'REPLY', 'IGNORE', 'REJECT'] as const) {
    if (upper.includes(kw)) {
      return { action: kw, confidence: 0.3, reasoning: '' };
    }
  }

  return null;
}

export async function microJudge(
  message: FormattedMessage,
  recentMessages: FormattedMessage[],
  botUid: number,
  usage = 'judge',
  knowledgeBase?: string,
): Promise<JudgeResult> {
  const start = performance.now();
  const config = getConfig();
  const systemPrompt = loadPrompt('task/judge.md', config.promptsDir);
  const contextStr = slimContextForAI(recentMessages, message, botUid);
  const kbBlock =
    knowledgeBase && knowledgeBase.trim()
      ? `[知识库]\n${knowledgeBase.trim()}\n\n`
      : '';

  let result: AICallResult;
  try {
    result = await callWithFallback({
      usage,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `${kbBlock}群聊上下文:\n${contextStr}\n\n请对最新一条消息(★标记)做出决策。`,
        },
      ],
      maxTokens: 100,
      temperature: 0,
    });
  } catch (err) {
    logger.error({ err }, 'Micro judge AI call failed, defaulting to IGNORE');
    return {
      action: 'IGNORE',
      level: 'L1_MICRO',
      confidence: 0,
      reasoning: 'AI call failed',
      latencyMs: Math.round(performance.now() - start),
    };
  }

  const parsed = parseJudgeAction(result.content);
  const latencyMs = Math.round(performance.now() - start);

  if (!parsed) {
    logger.warn({ raw: result.content, parseFailure: true }, 'Failed to parse judge response, defaulting to IGNORE');
    return {
      action: 'IGNORE',
      level: 'L1_MICRO',
      confidence: 0,
      reasoning: 'parse_failed',
      latencyMs,
    };
  }

  return {
    action: parsed.action,
    level: 'L1_MICRO',
    confidence: parsed.confidence,
    reasoning: parsed.reasoning,
    latencyMs,
  };
}

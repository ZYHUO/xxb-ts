// ────────────────────────────────────────
// AI Provider — Vercel AI SDK 统一调用层
// ────────────────────────────────────────

import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import type { AILabel, AICallResult, ContentPart } from './types.js';
import { AIError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';

export async function callModel(
  label: AILabel,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] }>,
  opts: { maxTokens?: number; temperature?: number; timeout?: number } = {},
): Promise<AICallResult> {
  const start = performance.now();
  const apiKey = label.apiKeys[0];
  if (!apiKey) {
    throw new AIError('No API key configured', label.name, label.model, 'AI_NO_KEY');
  }

  const provider = createOpenAI({
    baseURL: label.endpoint,
    apiKey,
  });

  try {
    const result = await generateText({
      model: provider(label.model),
      messages: messages as Parameters<typeof generateText>[0]['messages'],
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      abortSignal: opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined,
    });

    const latencyMs = Math.round(performance.now() - start);

    // Strip <think>...</think> blocks (Qwen3/DeepSeek-R1 reasoning traces)
    // Some models emit these even when not asked; remove before passing to parsers
    const rawText = result.text;
    const text = rawText
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
      .trim();

    return {
      content: text,
      tokenUsage: {
        prompt: result.usage?.promptTokens ?? 0,
        completion: result.usage?.completionTokens ?? 0,
        total: (result.usage?.promptTokens ?? 0) + (result.usage?.completionTokens ?? 0),
      },
      model: label.model,
      label: label.name,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    const message = err instanceof Error ? err.message : String(err);

    logger.warn({ label: label.name, model: label.model, latencyMs, err: message }, 'AI call failed');

    // Check for rate limit (429)
    if (message.includes('429') || message.toLowerCase().includes('rate limit')) {
      throw new AIError(`Rate limited: ${message}`, label.name, label.model, 'AI_RATE_LIMIT');
    }
    // Timeout
    if (message.includes('abort') || message.includes('timeout') || message.includes('TimeoutError')) {
      throw new AIError(`Timeout after ${latencyMs}ms: ${message}`, label.name, label.model, 'AI_TIMEOUT');
    }

    throw new AIError(message, label.name, label.model);
  }
}

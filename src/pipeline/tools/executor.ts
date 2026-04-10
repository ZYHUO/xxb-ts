// ────────────────────────────────────────
// Tool-aware reply generator
// Uses Vercel AI SDK generateText with tools
// ────────────────────────────────────────

import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { buildToolSet } from './registry.js';
import { getRedis } from '../../db/redis.js';
import { loadOverride, resolveLabelForRuntime, resolveUsageForRuntime } from '../../admin/runtime-config.js';
import { logger } from '../../shared/logger.js';
import type { AICallResult } from '../../ai/types.js';

const MAX_TOOL_STEPS = 3;

export async function generateWithTools(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  chatId: number,
  userId: number,
  usage: string,
  opts?: { temperatureOverride?: number },
): Promise<AICallResult & { toolsUsed: string[] }> {
  const start = performance.now();
  const override = await loadOverride(getRedis()).catch(() => null);
  const usageConfig = resolveUsageForRuntime(usage, override);
  const label = resolveLabelForRuntime(usageConfig.label, override);
  const tools = buildToolSet(chatId, userId);

  const provider = createOpenAI({
    baseURL: label.endpoint,
    apiKey: label.apiKeys[0],
  });

  const result = await generateText({
    model: provider(label.model),
    messages,
    tools,
    maxSteps: MAX_TOOL_STEPS,
    maxTokens: usageConfig.maxTokens,
    temperature: opts?.temperatureOverride ?? usageConfig.temperature,
    abortSignal: usageConfig.timeout ? AbortSignal.timeout(usageConfig.timeout) : undefined,
  });

  const latencyMs = Math.round(performance.now() - start);

  // Collect which tools were used
  const toolsUsed: string[] = [];
  for (const step of result.steps) {
    for (const call of step.toolCalls) {
      toolsUsed.push(call.toolName);
    }
  }

  if (toolsUsed.length > 0) {
    logger.info({ chatId, toolsUsed, latencyMs }, 'Tools executed');
  }

  return {
    content: result.text,
    tokenUsage: {
      prompt: result.usage?.promptTokens ?? 0,
      completion: result.usage?.completionTokens ?? 0,
      total: (result.usage?.promptTokens ?? 0) + (result.usage?.completionTokens ?? 0),
    },
    model: label.model,
    label: label.name,
    latencyMs,
    toolsUsed,
  };
}

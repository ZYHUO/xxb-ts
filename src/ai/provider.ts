// ────────────────────────────────────────
// AI Provider — Vercel AI SDK 统一调用层
// ────────────────────────────────────────

import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import type { AILabel, AICallResult, ContentPart } from './types.js';
import { AIError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';

// ── Claude native API (/v1/messages) ──────────────────────────────

interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ClaudeResponse {
  content: Array<{ type: string; text: string }>;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  error?: { type: string; message: string };
}

async function callClaude(
  label: AILabel,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  opts: { maxTokens?: number; temperature?: number; timeout?: number },
): Promise<AICallResult> {
  const start = performance.now();
  const apiKey = label.apiKeys[0];
  if (!apiKey) throw new AIError('No API key configured', label.name, label.model, 'AI_NO_KEY');

  // Extract system prompt — wrap in array with cache_control to enable prompt caching
  const systemMsg = messages.find(m => m.role === 'system');
  const chatMessages: ClaudeMessage[] = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content as string }));

  const body: Record<string, unknown> = {
    model: label.model,
    messages: chatMessages,
    max_tokens: opts.maxTokens ?? 4096,
  };

  if (systemMsg) {
    body['system'] = systemMsg.content;
  }

  if (opts.temperature !== undefined) body['temperature'] = opts.temperature;

  const res = await fetch(`${label.endpoint}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined,
  });

  const latencyMs = Math.round(performance.now() - start);

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    if (res.status === 429) {
      throw new AIError(`Rate limited: ${errText}`, label.name, label.model, 'AI_RATE_LIMIT');
    }
    throw new AIError(`HTTP ${res.status}: ${errText}`, label.name, label.model);
  }

  const data = await res.json() as ClaudeResponse;
  if (data.error) {
    throw new AIError(data.error.message, label.name, label.model);
  }

  const rawText = data.content.filter(c => c.type === 'text').map(c => c.text).join('');
  const text = rawText
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();

  const usage = data.usage as Record<string, number>;

  return {
    content: text,
    tokenUsage: {
      prompt: usage['input_tokens'] ?? 0,
      completion: usage['output_tokens'] ?? 0,
      total: (usage['input_tokens'] ?? 0) + (usage['output_tokens'] ?? 0),
    },
    model: label.model,
    label: label.name,
    latencyMs,
  };
}

// ── Main entry ────────────────────────────────────────────────────

export async function callModel(
  label: AILabel,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] }>,
  opts: { maxTokens?: number; temperature?: number; timeout?: number } = {},
): Promise<AICallResult> {
  if (label.apiFormat === 'claude') {
    const textMessages = messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : m.content.map(p => p.type === 'text' ? p.text : '').join(''),
    }));
    try {
      return await callClaude(label, textMessages, opts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof AIError) throw err;
      if (message.includes('abort') || message.includes('timeout') || message.includes('TimeoutError')) {
        throw new AIError(`Timeout: ${message}`, label.name, label.model, 'AI_TIMEOUT');
      }
      throw new AIError(message, label.name, label.model);
    }
  }

  const start = performance.now();
  const apiKey = label.apiKeys[0];
  if (!apiKey) {
    throw new AIError('No API key configured', label.name, label.model, 'AI_NO_KEY');
  }

  const provider = createOpenAI({
    baseURL: label.endpoint,
    apiKey,
    compatibility: 'compatible',
  });

  try {
    if (label.stream) {
      // Stream-only endpoint: raw fetch + manual SSE parsing (most reliable)
      const timeoutMs = opts.timeout ?? 60_000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let fullText = '';
      try {
        const res = await fetch(`${label.endpoint}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: label.model,
            messages: messages.map(m => ({
              role: m.role,
              content: typeof m.content === 'string' ? m.content : (m.content as ContentPart[]).map(p => p.type === 'text' ? p.text : '').join(''),
            })),
            max_tokens: opts.maxTokens,
            temperature: opts.temperature,
            stream: true,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          if (res.status === 429) throw new AIError(`Rate limited: ${errText}`, label.name, label.model, 'AI_RATE_LIMIT');
          throw new AIError(`HTTP ${res.status}: ${errText}`, label.name, label.model);
        }

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buf = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (data === '[DONE]') break;
            try {
              const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
              fullText += chunk.choices?.[0]?.delta?.content ?? '';
            } catch { /* ignore malformed chunks */ }
          }
        }
        // Flush decoder internal state and process any residual buffer
        buf += decoder.decode();
        if (buf.trim()) {
          const trimmed = buf.trim();
          if (trimmed.startsWith('data:')) {
            const data = trimmed.slice(5).trim();
            if (data !== '[DONE]') {
              try {
                const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
                fullText += chunk.choices?.[0]?.delta?.content ?? '';
              } catch { /* ignore */ }
            }
          }
        }
      } finally {
        clearTimeout(timer);
      }

      const latencyMs = Math.round(performance.now() - start);
      const text = fullText
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .trim();

      return {
        content: text,
        tokenUsage: { prompt: 0, completion: 0, total: 0 },
        model: label.model,
        label: label.name,
        latencyMs,
      };
    }

    const result = await generateText({
      model: provider(label.model),
      messages: messages as Parameters<typeof generateText>[0]['messages'],
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      abortSignal: opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined,
    });

    const latencyMs = Math.round(performance.now() - start);

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

    if (message.includes('429') || message.toLowerCase().includes('rate limit')) {
      throw new AIError(`Rate limited: ${message}`, label.name, label.model, 'AI_RATE_LIMIT');
    }
    if (message.includes('abort') || message.includes('timeout') || message.includes('TimeoutError')) {
      throw new AIError(`Timeout after ${latencyMs}ms: ${message}`, label.name, label.model, 'AI_TIMEOUT');
    }

    throw new AIError(message, label.name, label.model);
  }
}

// ────────────────────────────────────────
// Context Compressor — AI-based summarization
// ────────────────────────────────────────

import type { FormattedMessage } from '../../shared/types.js';
import { countTokens } from '../../ai/token-counter.js';
import { slimContextForAI } from './slim.js';
import { logger } from '../../shared/logger.js';

export interface CompressorConfig {
  /** Token threshold to trigger compression */
  compressionThreshold: number;
  /** Maximum tokens after compression */
  targetTokens: number;
}

const DEFAULT_CONFIG: CompressorConfig = {
  compressionThreshold: 1200,
  targetTokens: 800,
};

/**
 * Compress context if it exceeds the threshold.
 * Phase 2: basic truncation (no AI summarization).
 * AI-based summarization with Redis caching will be Phase 3.
 */
export function compressContext(
  messages: FormattedMessage[],
  currentMessage: FormattedMessage,
  botUid: number,
  config: Partial<CompressorConfig> = {},
): FormattedMessage[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (messages.length === 0) return messages;

  const contextStr = slimContextForAI(messages, currentMessage, botUid);
  const tokens = countTokens(contextStr);

  if (tokens <= cfg.compressionThreshold) return messages;

  logger.debug({ tokens, threshold: cfg.compressionThreshold }, 'Context exceeds threshold, truncating');

  // Simple truncation: remove oldest messages until we're under target
  const result = [...messages];
  while (result.length > 1) {
    result.shift();
    const newCtx = slimContextForAI(result, currentMessage, botUid);
    if (countTokens(newCtx) <= cfg.targetTokens) break;
  }

  logger.debug({ original: messages.length, compressed: result.length }, 'Context compressed');
  return result;
}

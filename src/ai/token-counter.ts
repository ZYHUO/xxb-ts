// ────────────────────────────────────────
// Token 计数 (tiktoken)
// ────────────────────────────────────────

import { get_encoding } from 'tiktoken';
import type { Tiktoken } from 'tiktoken';

let _enc: Tiktoken | undefined;

function getEncoder(): Tiktoken {
  if (!_enc) {
    _enc = get_encoding('o200k_base');
  }
  return _enc;
}

/** Count tokens for a single string */
export function countTokens(text: string): number {
  if (!text) return 0;
  return getEncoder().encode(text).length;
}

/** Count tokens for a chat message array */
export function countMessageTokens(
  messages: Array<{ role: string; content: string }>,
): number {
  let total = 0;
  for (const msg of messages) {
    // Per OpenAI: each message adds ~4 tokens for role/formatting overhead
    total += 4;
    total += countTokens(msg.content);
  }
  // Final assistant priming
  total += 2;
  return total;
}

/** Free the encoder (for cleanup) */
export function freeEncoder(): void {
  if (_enc) {
    _enc.free();
    _enc = undefined;
  }
}

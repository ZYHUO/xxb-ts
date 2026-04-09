// ────────────────────────────────────────
// 4-Way Context Retriever
// ────────────────────────────────────────
// Path 1: Recent Window
// Path 2: Semantic (stub — needs embeddings)
// Path 3: Thread (reply_to chain)
// Path 4: Entity (mentioned users)
// ────────────────────────────────────────

import type { FormattedMessage, RetrievedContext } from '../../shared/types.js';
import { getRecent, getAll } from './manager.js';
import { countTokens } from '../../ai/token-counter.js';
import { slimContextForAI } from './slim.js';
import { logger } from '../../shared/logger.js';

export interface RetrieverConfig {
  recentWindow: number;
  semanticTopK: number;
  threadMaxDepth: number;
  entityMaxMessages: number;
  totalTokenBudget: number;
}

const DEFAULT_CONFIG: RetrieverConfig = {
  recentWindow: 20,
  semanticTopK: 10,
  threadMaxDepth: 8,
  entityMaxMessages: 5,
  totalTokenBudget: 1500,
};

/**
 * Path 1: Recent window — last N messages from context.
 */
async function retrieveRecent(chatId: number, count: number): Promise<FormattedMessage[]> {
  return getRecent(chatId, count);
}

/**
 * Path 2: Semantic search — STUB for Phase 2.
 * Full implementation requires sqlite-vec embeddings (Phase 3).
 */
async function retrieveSemantic(
  _chatId: number,
  _query: string,
  _topK: number,
): Promise<FormattedMessage[]> {
  return [];
}

/**
 * Path 3: Thread trace — follow reply_to chain backwards.
 */
async function retrieveThread(
  chatId: number,
  message: FormattedMessage,
  maxDepth: number,
): Promise<FormattedMessage[]> {
  if (!message.replyTo) return [];

  const allMessages = await getAll(chatId);
  const byId = new Map<number, FormattedMessage>();
  for (const m of allMessages) {
    byId.set(m.messageId, m);
  }

  const thread: FormattedMessage[] = [];
  let current: FormattedMessage | undefined = message;

  for (let depth = 0; depth < maxDepth; depth++) {
    const replyToId = current?.replyTo?.messageId;
    if (!replyToId) break;

    const parent = byId.get(replyToId);
    if (!parent) break;

    thread.push(parent);
    current = parent;
  }

  return thread.reverse();
}

/**
 * Path 4: Entity — messages from users mentioned in the current message.
 * Extracts @username mentions from text.
 */
async function retrieveEntity(
  chatId: number,
  message: FormattedMessage,
  maxMessages: number,
): Promise<FormattedMessage[]> {
  const text = message.textContent || message.captionContent || '';
  const mentions = text.match(/@(\w+)/g);
  if (!mentions || mentions.length === 0) return [];

  const mentionedUsernames = new Set(
    mentions.map((m) => m.slice(1).toLowerCase()),
  );

  const allMessages = await getAll(chatId);
  const entityMessages: FormattedMessage[] = [];

  for (let i = allMessages.length - 1; i >= 0 && entityMessages.length < maxMessages; i--) {
    const m = allMessages[i]!;
    if (m.messageId === message.messageId) continue;
    if (m.username && mentionedUsernames.has(m.username.toLowerCase())) {
      entityMessages.push(m);
    }
  }

  return entityMessages.reverse();
}

/**
 * Deduplicate messages by messageId, preserving order of first appearance.
 */
function deduplicateMessages(messages: FormattedMessage[]): FormattedMessage[] {
  const seen = new Set<number>();
  const result: FormattedMessage[] = [];

  for (const msg of messages) {
    if (!seen.has(msg.messageId)) {
      seen.add(msg.messageId);
      result.push(msg);
    }
  }

  return result;
}

/**
 * Truncate messages to fit within token budget.
 * Priority: thread > recent > semantic > entity
 */
function truncateToTokenBudget(
  merged: FormattedMessage[],
  currentMessage: FormattedMessage,
  botUid: number,
  tokenBudget: number,
): FormattedMessage[] {
  if (merged.length === 0) return merged;

  // Check if already within budget
  const fullContext = slimContextForAI(merged, currentMessage, botUid);
  const fullTokens = countTokens(fullContext);

  if (fullTokens <= tokenBudget) return merged;

  // Trim from the beginning (oldest messages first)
  const result = [...merged];
  while (result.length > 1) {
    result.shift();
    const ctx = slimContextForAI(result, currentMessage, botUid);
    if (countTokens(ctx) <= tokenBudget) break;
  }

  return result;
}

/**
 * Retrieve context using 4-way parallel strategy.
 */
export async function retrieveContext(
  chatId: number,
  message: FormattedMessage,
  botUid: number,
  config: Partial<RetrieverConfig> = {},
): Promise<RetrievedContext> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const queryText = message.textContent || message.captionContent || '';

  // Run all 4 paths in parallel
  const [recent, semantic, thread, entity] = await Promise.all([
    retrieveRecent(chatId, cfg.recentWindow),
    retrieveSemantic(chatId, queryText, cfg.semanticTopK),
    retrieveThread(chatId, message, cfg.threadMaxDepth),
    retrieveEntity(chatId, message, cfg.entityMaxMessages),
  ]);

  // Merge with priority: thread > recent > semantic > entity
  const allMessages = [...thread, ...recent, ...semantic, ...entity];
  const deduped = deduplicateMessages(allMessages);

  // Sort by timestamp
  deduped.sort((a, b) => a.timestamp - b.timestamp);

  // Truncate to token budget
  const merged = truncateToTokenBudget(deduped, message, botUid, cfg.totalTokenBudget);
  const contextStr = slimContextForAI(merged, message, botUid);
  const tokenCount = countTokens(contextStr);

  logger.debug({
    chatId,
    recent: recent.length,
    semantic: semantic.length,
    thread: thread.length,
    entity: entity.length,
    merged: merged.length,
    tokenCount,
  }, 'Context retrieved');

  return { recent, semantic, thread, entity, merged, tokenCount };
}

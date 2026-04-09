// ────────────────────────────────────────
// 5-Layer Prompt Builder
// ────────────────────────────────────────
// L1: Identity (persona.md)
// L2: Safety (guardrails.md)
// L3: Contract (reply-schema.json)
// L4: Style (tone.md)
// L5: Task (reply.md or reply-pro.md)
// ────────────────────────────────────────

import type { FormattedMessage, JudgeAction } from '../../shared/types.js';
import { loadPrompt, getConfig } from '../../shared/config.js';

const SECTION_SEP = '\n\n---\n\n';

let _promptCache: Map<string, string> | undefined;

function getPromptCache(): Map<string, string> {
  if (!_promptCache) {
    _promptCache = new Map();
  }
  return _promptCache;
}

function loadCachedPrompt(relativePath: string): string {
  const cache = getPromptCache();
  const cached = cache.get(relativePath);
  if (cached !== undefined) return cached;

  const config = getConfig();
  const content = loadPrompt(relativePath, config.promptsDir);
  cache.set(relativePath, content);
  return content;
}

/**
 * Build the 5-layer system prompt.
 */
export function buildSystemPrompt(action: JudgeAction): string {
  const layers: string[] = [];

  // L1: Identity
  layers.push(loadCachedPrompt('identity/persona.md'));

  // L2: Safety
  layers.push(loadCachedPrompt('safety/guardrails.md'));

  // L3: Contract — explain JSON output format from the schema
  const schemaRaw = loadCachedPrompt('contract/reply-schema.json');
  const contractExplanation = `# L3 — 输出契约\n\n你必须严格按以下 JSON Schema 输出：\n\n\`\`\`json\n${schemaRaw}\n\`\`\`\n\n只输出 JSON 对象，不要包含任何其他文字。`;
  layers.push(contractExplanation);

  // L4: Style
  layers.push(loadCachedPrompt('style/tone.md'));

  // L5: Task
  const taskFile = action === 'REPLY_PRO' ? 'task/reply-pro.md' : 'task/reply.md';
  layers.push(loadCachedPrompt(taskFile));

  return layers.filter(Boolean).join(SECTION_SEP);
}

/**
 * Build the messages array for AI call.
 */
export function buildMessages(
  systemPrompt: string,
  context: string,
  latestMessage: FormattedMessage,
  knowledge?: string,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const userParts: string[] = [];

  if (knowledge) {
    userParts.push(`[知识库]\n${knowledge}`);
  }

  userParts.push(`[群聊上下文]\n${context}`);

  const msgText = latestMessage.textContent || latestMessage.captionContent || '[空消息]';
  userParts.push(`[CURRENT_MESSAGE_TO_REPLY]\nmessage_id: ${latestMessage.messageId}\n发送者: ${latestMessage.fullName}(@${latestMessage.username})\n内容: ${msgText}`);

  return [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: userParts.join('\n\n') },
  ];
}

/** Reset prompt cache (for testing) */
export function _resetPromptCache(): void {
  _promptCache = undefined;
}

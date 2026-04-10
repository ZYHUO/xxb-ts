// ────────────────────────────────────────
// 5-Layer Prompt Builder
// ────────────────────────────────────────
// L1: Identity (persona.md)
// L2: Safety (guardrails.md)
// L3: Contract (reply-schema.json)
// L4: Style (tone.md)
// L5: Task (reply.md or reply-pro.md)
// ────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  // Cap cache at 200 entries (evict oldest — first in insertion order)
  if (cache.size > 200) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return content;
}

function loadPersonaForUser(userId: number | undefined): string {
  if (!userId) {
    return loadCachedPrompt('identity/persona.md');
  }
  const { personaDir } = getConfig();
  const md = resolve(personaDir, `${userId}.md`);
  const txt = resolve(personaDir, `${userId}.txt`);
  try {
    if (existsSync(md)) {
      return readFileSync(md, 'utf-8').trim();
    }
    if (existsSync(txt)) {
      return readFileSync(txt, 'utf-8').trim();
    }
  } catch {
    /* fall through */
  }
  return loadCachedPrompt('identity/persona.md');
}

/**
 * Build the 5-layer system prompt.
 * @param userId — optional; loads prompts/persona/{userId}.md|.txt when present (PHP PersonaManager parity).
 */
export function buildSystemPrompt(action: JudgeAction, userId?: number): string {
  const layers: string[] = [];

  // L0: Runtime context (current time)
  const now = new Date();
  const timeStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'full', timeStyle: 'short' });
  layers.push(`# 当前时间\n\n${timeStr}（北京时间）`);

  // L1: Identity
  layers.push(loadPersonaForUser(userId));

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
 * Strip ASCII control characters (except newline) and truncate to maxLen.
 * Used to sanitize user-controlled strings injected into prompts.
 */
function sanitizeSenderString(s: string, maxLen = 64): string {
  // Remove control chars \x00-\x1f except \n (0x0a)
  return s.replace(/[\x00-\x09\x0b-\x1f]/g, '').slice(0, maxLen);
}

/**
 * Build the messages array for AI call.
 */
export function buildMessages(
  systemPrompt: string,
  context: string,
  latestMessage: FormattedMessage,
  knowledge?: string,
  checkinData?: string,
  memberRoster?: string,
  botKnowledge?: string,
  userProfile?: string,
  selfReflection?: string,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const userParts: string[] = [];

  if (knowledge) {
    userParts.push(`[知识库]\n${knowledge}`);
  }

  if (checkinData) {
    userParts.push(checkinData);
  }

  if (memberRoster) {
    userParts.push(`[群成员]\n${memberRoster}`);
  }

  if (botKnowledge) {
    userParts.push(`[群组Bot知识]\n${botKnowledge}`);
  }

  if (selfReflection) {
    userParts.push(`[自我反思·回复规律]\n${selfReflection}`);
  }

  userParts.push(`[群聊上下文]\n${context}`);

  const msgText = latestMessage.textContent || latestMessage.captionContent || '[空消息]';
  const safeName = sanitizeSenderString(latestMessage.fullName ?? '');
  const safeUser = sanitizeSenderString(latestMessage.username ?? '');
  const senderLabel = latestMessage.isAnonymous
    ? `${safeName}[${latestMessage.anonymousType === 'channel' ? '频道' : '匿名管理员'}]`
    : `${safeName}(@${safeUser})`;

  let currentMsgBlock = `[CURRENT_MESSAGE_TO_REPLY]\nmessage_id: ${latestMessage.messageId}\n发送者: ${senderLabel}`;
  if (latestMessage.senderTag) {
    currentMsgBlock += `\n用户Tag: ${latestMessage.senderTag}`;
  }
  if (userProfile) {
    currentMsgBlock += `\n用户画像: ${userProfile}`;
  }
  currentMsgBlock += `\n内容: ${msgText}`;
  userParts.push(currentMsgBlock);

  return [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: userParts.join('\n\n') },
  ];
}

/** Reset prompt cache (for testing) */
export function _resetPromptCache(): void {
  _promptCache = undefined;
}

// ────────────────────────────────────────
// AI Label 管理 — 从环境变量构建 label 配置
// ────────────────────────────────────────

import type { AILabel, AIUsage } from './types.js';
import { env } from '../env.js';

let _labels: Map<string, AILabel> | undefined;

export function getLabels(): Map<string, AILabel> {
  if (_labels) return _labels;

  const e = env();
  const base = e.AI_BASE_URL;
  const keys = [e.AI_API_KEY];

  // Local provider (Qwen/GLM/etc.) — fallback to main provider if not configured
  const localBase = e.LOCAL_AI_BASE_URL ?? base;
  const localKeys = e.LOCAL_AI_API_KEY ? [e.LOCAL_AI_API_KEY] : keys;
  const hasLocal = !!e.LOCAL_AI_BASE_URL;

  _labels = new Map<string, AILabel>([
    // ── 主力回复：保持 Gemini / 主 provider ──────────────────────
    ['reply',     { name: 'reply',     endpoint: base,      apiKeys: keys,      model: e.AI_MODEL_REPLY }],
    ['reply_pro', { name: 'reply_pro', endpoint: base,      apiKeys: keys,      model: e.AI_MODEL_REPLY_PRO }],
    ['vision',    { name: 'vision',    endpoint: base,      apiKeys: keys,      model: e.AI_MODEL_VISION, capabilities: { vision: true } }],

    // ── 本地模型：judge / summarize / allowlist ──────────────────
    // 未配置 LOCAL_AI_BASE_URL 时自动降级用主 provider
    ['judge', {
      name: 'judge',
      endpoint: hasLocal ? localBase : base,
      apiKeys: hasLocal ? localKeys : keys,
      model: hasLocal ? (e.LOCAL_AI_MODEL_JUDGE ?? e.AI_MODEL_JUDGE) : e.AI_MODEL_JUDGE,
    }],
    ['summarize', {
      name: 'summarize',
      endpoint: hasLocal ? localBase : base,
      apiKeys: hasLocal ? localKeys : keys,
      model: hasLocal ? (e.LOCAL_AI_MODEL_SUMMARIZE ?? e.AI_MODEL_SUMMARIZE) : e.AI_MODEL_SUMMARIZE,
    }],
    ['allowlist_review', {
      name: 'allowlist_review',
      endpoint: hasLocal ? localBase : base,
      apiKeys: hasLocal ? localKeys : keys,
      model: hasLocal ? (e.LOCAL_AI_MODEL_ALLOWLIST ?? e.AI_MODEL_JUDGE) : e.AI_MODEL_ALLOWLIST_REVIEW,
    }],
  ]);

  return _labels;
}

export function getLabel(name: string): AILabel {
  const label = getLabels().get(name);
  if (!label) throw new Error(`AI label not found: ${name}`);
  return label;
}

const USAGE_DEFAULTS: Record<string, AIUsage> = {
  // reply 系列：较长 timeout，允许流式
  reply:            { label: 'reply',            backups: ['reply_pro'],  timeout: 60_000 },
  reply_pro:        { label: 'reply_pro',         backups: ['reply'],      timeout: 90_000 },
  vision:           { label: 'vision',            backups: [],             timeout: 30_000 },

  // 本地跑的：judge 快、summarize/allowlist 宽松
  judge:            { label: 'judge',             backups: ['reply'],      timeout: 30_000, maxTokens: 200,  temperature: 0 },
  summarize:        { label: 'summarize',         backups: ['reply'],      timeout: 120_000 },
  allowlist_review: { label: 'allowlist_review',  backups: ['reply'],      timeout: 60_000 },
};

export function getUsage(name: string): AIUsage {
  const usage = USAGE_DEFAULTS[name];
  if (!usage) throw new Error(`AI usage not found: ${name}`);
  return { ...usage };
}

/** Reset cached labels (for testing) */
export function _resetLabels(): void {
  _labels = undefined;
}

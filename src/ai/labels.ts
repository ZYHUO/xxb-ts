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

  _labels = new Map<string, AILabel>([
    ['judge', { name: 'judge', endpoint: base, apiKeys: keys, model: e.AI_MODEL_JUDGE }],
    ['reply', { name: 'reply', endpoint: base, apiKeys: keys, model: e.AI_MODEL_REPLY }],
    ['reply_pro', { name: 'reply_pro', endpoint: base, apiKeys: keys, model: e.AI_MODEL_REPLY_PRO }],
    ['vision', { name: 'vision', endpoint: base, apiKeys: keys, model: e.AI_MODEL_VISION, capabilities: { vision: true } }],
    ['summarize', { name: 'summarize', endpoint: base, apiKeys: keys, model: e.AI_MODEL_SUMMARIZE }],
  ]);

  return _labels;
}

export function getLabel(name: string): AILabel {
  const label = getLabels().get(name);
  if (!label) throw new Error(`AI label not found: ${name}`);
  return label;
}

const USAGE_DEFAULTS: Record<string, AIUsage> = {
  judge: { label: 'judge', backups: ['reply'], timeout: 10_000, maxTokens: 100, temperature: 0 },
  reply: { label: 'reply', backups: ['reply_pro'], timeout: 60_000 },
  reply_pro: { label: 'reply_pro', backups: ['reply'], timeout: 90_000 },
  vision: { label: 'vision', backups: [], timeout: 30_000 },
  summarize: { label: 'summarize', backups: ['reply'], timeout: 30_000 },
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

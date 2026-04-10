import type { Redis } from 'ioredis';
import { getLabel, getLabels, getUsage } from '../ai/labels.js';
import type { AILabel, AIUsage } from '../ai/types.js';
import { logger } from '../shared/logger.js';

const OVERRIDE_KEY = 'xxb:admin:model_routing:override';

export interface ProviderOverride {
  endpoint: string;
  model: string;
  api_key?: string;
  api_keys?: string[];
}

export interface RuntimeOverride {
  providers?: Record<string, ProviderOverride>;
  usage?: {
    reply?: { label: string; backups?: string[] };
    allowlist_review?: { label: string };
  };
  sticker_policy?: {
    enabled: boolean;
    mode: 'ai' | 'sticker_only' | 'off';
    send_position: 'before' | 'after';
  };
}

export async function loadOverride(redis: Redis): Promise<RuntimeOverride | null> {
  const raw = await redis.get(OVERRIDE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RuntimeOverride;
  } catch {
    logger.warn('Failed to parse runtime override from Redis');
    return null;
  }
}

export async function saveOverride(redis: Redis, override: RuntimeOverride): Promise<void> {
  await redis.set(OVERRIDE_KEY, JSON.stringify(override));
}

export function buildProviderCatalog(
  override: RuntimeOverride | null,
): Record<string, ProviderOverride> {
  const builtIns = Object.fromEntries(
    Array.from(getLabels().entries()).map(([name, label]) => [
      name,
      {
        endpoint: label.endpoint,
        model: label.model,
        api_keys: label.apiKeys,
      },
    ]),
  );
  return {
    ...builtIns,
    ...(override?.providers ?? {}),
  };
}

export function resolveUsageForRuntime(
  usageName: string,
  override: RuntimeOverride | null,
): AIUsage {
  const usage = getUsage(usageName);
  const overrideUsage = (override?.usage as Record<string, { label?: string; backups?: string[] } | undefined> | undefined)?.[usageName];
  if (overrideUsage?.label) {
    usage.label = overrideUsage.label;
  }
  if (Array.isArray(overrideUsage?.backups)) {
    usage.backups = overrideUsage.backups.filter((item) => typeof item === 'string' && item.trim() !== '');
  }
  return usage;
}

export function resolveLabelForRuntime(
  labelName: string,
  override: RuntimeOverride | null,
): AILabel {
  const builtIn = getLabels().get(labelName);
  const provider = buildProviderCatalog(override)[labelName];
  if (!provider) {
    if (!builtIn) throw new Error(`AI label not found: ${labelName}`);
    return builtIn;
  }

  return {
    name: labelName,
    endpoint: provider.endpoint,
    apiKeys: provider.api_key ? [provider.api_key] : (provider.api_keys ?? builtIn?.apiKeys ?? []),
    model: provider.model,
    stream: builtIn?.stream,
    capabilities: builtIn?.capabilities,
  };
}

export function buildModelRoutingAdminView(
  envConfig: {
    AI_MODEL_REPLY: string;
    AI_MODEL_REPLY_PRO: string;
    AI_MODEL_JUDGE: string;
    AI_MODEL_ALLOWLIST_REVIEW: string;
  },
  override: RuntimeOverride | null,
): Record<string, unknown> {
  const providers = buildProviderCatalog(override);
  return {
    defaults: {
      reply: envConfig.AI_MODEL_REPLY,
      reply_pro: envConfig.AI_MODEL_REPLY_PRO,
      judge: envConfig.AI_MODEL_JUDGE,
      allowlist_review: envConfig.AI_MODEL_ALLOWLIST_REVIEW,
    },
    override: override?.usage ?? null,
    effective: {
      reply: resolveUsageForRuntime('reply', override),
      allowlist_review: resolveUsageForRuntime('allowlist_review', override),
    },
    providers,
    has_override: override !== null && (!!override.providers || !!override.usage),
  };
}

export function buildStickerPolicyAdminView(
  override: RuntimeOverride | null,
): Record<string, unknown> {
  return {
    enabled: override?.sticker_policy?.enabled ?? true,
    mode: override?.sticker_policy?.mode ?? 'ai',
    send_position: override?.sticker_policy?.send_position ?? 'after',
    has_override: !!override?.sticker_policy,
  };
}

export async function validateProvider(provider: ProviderOverride): Promise<{
  ok: boolean;
  latency_ms: number;
  error?: string;
}> {
  const apiKey = provider.api_key ?? provider.api_keys?.[0];
  if (!apiKey) return { ok: false, latency_ms: 0, error: 'No API key' };

  const start = Date.now();
  try {
    const res = await fetch(`${provider.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const latency = Date.now() - start;

    if (!res.ok) {
      return { ok: false, latency_ms: latency, error: `HTTP ${res.status}` };
    }
    return { ok: true, latency_ms: latency };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

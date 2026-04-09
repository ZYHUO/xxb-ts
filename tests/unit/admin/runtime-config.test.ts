import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  loadOverride,
  saveOverride,
  buildModelRoutingAdminView,
  buildStickerPolicyAdminView,
} from '../../../src/admin/runtime-config.js';
import type { RuntimeOverride } from '../../../src/admin/runtime-config.js';

function createMockRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    _store: store,
  };
}

describe('loadOverride', () => {
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    redis = createMockRedis();
  });

  it('returns null when no key exists', async () => {
    const result = await loadOverride(redis as never);
    expect(result).toBeNull();
  });

  it('returns parsed override', async () => {
    const override: RuntimeOverride = {
      providers: {
        custom: { endpoint: 'https://api.example.com/v1', model: 'gpt-4' },
      },
      usage: { reply: { label: 'custom' } },
    };
    redis._store.set('xxb:admin:model_routing:override', JSON.stringify(override));

    const result = await loadOverride(redis as never);
    expect(result).not.toBeNull();
    expect(result!.providers!['custom']!.model).toBe('gpt-4');
    expect(result!.usage!.reply!.label).toBe('custom');
  });

  it('returns null for invalid JSON', async () => {
    redis._store.set('xxb:admin:model_routing:override', 'not-json{');
    const result = await loadOverride(redis as never);
    expect(result).toBeNull();
  });
});

describe('saveOverride', () => {
  it('writes JSON to Redis', async () => {
    const redis = createMockRedis();
    const override: RuntimeOverride = {
      sticker_policy: { enabled: true, mode: 'ai', send_position: 'after' },
    };

    await saveOverride(redis as never, override);
    expect(redis.set).toHaveBeenCalledWith(
      'xxb:admin:model_routing:override',
      JSON.stringify(override),
    );
  });
});

describe('buildModelRoutingAdminView', () => {
  const envConfig = {
    AI_MODEL_REPLY: 'gpt-4o-mini',
    AI_MODEL_REPLY_PRO: 'gpt-4o',
    AI_MODEL_JUDGE: 'gpt-4o-mini',
    AI_MODEL_ALLOWLIST_REVIEW: 'gpt-4o-mini',
  };

  it('includes defaults and override', () => {
    const override: RuntimeOverride = {
      providers: { p1: { endpoint: 'https://a.com/v1', model: 'm1' } },
      usage: { reply: { label: 'p1' } },
    };

    const view = buildModelRoutingAdminView(envConfig, override);
    expect(view.defaults).toEqual({
      reply: 'gpt-4o-mini',
      reply_pro: 'gpt-4o',
      judge: 'gpt-4o-mini',
      allowlist_review: 'gpt-4o-mini',
    });
    expect(view.has_override).toBe(true);
    expect(view.providers).toEqual(override.providers);
  });

  it('returns has_override=false when no override', () => {
    const view = buildModelRoutingAdminView(envConfig, null);
    expect(view.has_override).toBe(false);
    expect(view.override).toBeNull();
    expect(view.providers).toEqual({});
  });
});

describe('buildStickerPolicyAdminView', () => {
  it('returns defaults when no override', () => {
    const view = buildStickerPolicyAdminView(null);
    expect(view.enabled).toBe(true);
    expect(view.mode).toBe('ai');
    expect(view.send_position).toBe('after');
    expect(view.has_override).toBe(false);
  });

  it('returns override values when present', () => {
    const override: RuntimeOverride = {
      sticker_policy: { enabled: false, mode: 'off', send_position: 'before' },
    };
    const view = buildStickerPolicyAdminView(override);
    expect(view.enabled).toBe(false);
    expect(view.mode).toBe('off');
    expect(view.send_position).toBe('before');
    expect(view.has_override).toBe(true);
  });
});

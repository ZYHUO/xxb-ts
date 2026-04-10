import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/ai/labels.js', () => {
  const labels = new Map([
    ['reply', { name: 'reply', endpoint: 'https://main.example/v1', apiKeys: ['main-key'], model: 'main-model' }],
    ['reply_pro', { name: 'reply_pro', endpoint: 'https://main.example/v1', apiKeys: ['main-key'], model: 'pro-model' }],
    ['allowlist_review', { name: 'allowlist_review', endpoint: 'https://review.example/v1', apiKeys: ['review-key'], model: 'review-model' }],
  ]);

  return {
    getLabels: () => labels,
    getLabel: (name: string) => {
      const label = labels.get(name);
      if (!label) throw new Error(`missing label ${name}`);
      return label;
    },
    getUsage: (name: string) => {
      if (name === 'reply') {
        return { label: 'reply', backups: ['reply_pro'], timeout: 60_000 };
      }
      if (name === 'allowlist_review') {
        return { label: 'allowlist_review', backups: [], timeout: 60_000 };
      }
      throw new Error(`missing usage ${name}`);
    },
  };
});

const {
  buildProviderCatalog,
  resolveUsageForRuntime,
  resolveLabelForRuntime,
} = await import('../../../src/admin/runtime-config.js');

describe('runtime routing helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds provider catalog with built-ins and custom overrides', () => {
    const providers = buildProviderCatalog({
      providers: {
        custom_fast: {
          endpoint: 'https://custom.example/v1',
          model: 'custom-model',
          api_key: 'custom-key',
        },
      },
    });

    expect(providers['reply']?.model).toBe('main-model');
    expect(providers['reply_pro']?.model).toBe('pro-model');
    expect(providers['custom_fast']?.model).toBe('custom-model');
  });

  it('applies usage override for runtime routing', () => {
    const usage = resolveUsageForRuntime('reply', {
      usage: {
        reply: {
          label: 'custom_fast',
          backups: ['reply'],
        },
      },
    });

    expect(usage.label).toBe('custom_fast');
    expect(usage.backups).toEqual(['reply']);
  });

  it('resolves custom runtime provider into an AI label', () => {
    const label = resolveLabelForRuntime('custom_fast', {
      providers: {
        custom_fast: {
          endpoint: 'https://custom.example/v1',
          model: 'custom-model',
          api_key: 'custom-key',
        },
      },
    });

    expect(label).toMatchObject({
      name: 'custom_fast',
      endpoint: 'https://custom.example/v1',
      model: 'custom-model',
      apiKeys: ['custom-key'],
    });
  });
});

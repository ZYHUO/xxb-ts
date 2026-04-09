import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Redis } from 'ioredis';
import type { Bot } from 'grammy';
import { logger } from '../shared/logger.js';
import { validateInitData, isMaster } from './auth.js';
import type { TelegramUser } from './auth.js';
import type { AllowlistConfig } from '../allowlist/types.js';
import * as allowlist from '../allowlist/allowlist.js';
import * as aiReview from '../allowlist/ai-review.js';
import * as notify from '../allowlist/notify.js';
import * as runtimeConfig from './runtime-config.js';
import * as modelStatus from './model-status.js';
import * as botPermission from './bot-permission.js';
import { checkHealth } from './health.js';
import type { Env } from '../env.js';

interface ApiDeps {
  redis: Redis;
  bot: Bot;
  config: AllowlistConfig;
  env: Env;
  aiCall: (systemPrompt: string, userMessage: string) => Promise<string | null>;
  getRecentContext?: (chatId: number, limit: number, maxChars: number) => Promise<string>;
}

// ── Handler functions ──────────────────────────────────────────────

async function handleBootstrap(
  deps: ApiDeps,
  user: TelegramUser,
  master: boolean,
): Promise<Record<string, unknown>> {
  // Non-master users only see their own submissions
  if (!master) {
    const myData = await allowlist.listByUser(deps.redis, deps.config, user.id);
    return {
      ok: true,
      is_master: false,
      user: { id: user.id, first_name: user.first_name, username: user.username },
      ...myData,
    };
  }

  const pending = await allowlist.listPending(deps.redis, deps.config);
  const groups = await allowlist.listGroups(deps.redis, deps.config);
  const manualQueue = await allowlist.listManualQueue(deps.redis, deps.config);
  const override = await runtimeConfig.loadOverride(deps.redis);

  const modelRouting = runtimeConfig.buildModelRoutingAdminView(
    {
      AI_MODEL_REPLY: deps.env.AI_MODEL_REPLY,
      AI_MODEL_REPLY_PRO: deps.env.AI_MODEL_REPLY_PRO,
      AI_MODEL_JUDGE: deps.env.AI_MODEL_JUDGE,
      AI_MODEL_ALLOWLIST_REVIEW: deps.env.AI_MODEL_ALLOWLIST_REVIEW,
    },
    override,
  );

  // Strip API keys from providers before sending to client
  if (modelRouting.providers && typeof modelRouting.providers === 'object') {
    const sanitized = modelRouting.providers as Record<string, Record<string, unknown>>;
    for (const label of Object.keys(sanitized)) {
      const entry = sanitized[label];
      if (entry) {
        delete entry.api_key;
        delete entry.api_keys;
      }
    }
  }

  const stickerPolicy = runtimeConfig.buildStickerPolicyAdminView(override);

  return {
    ok: true,
    pending,
    groups,
    manual_queue: manualQueue,
    model_routing: modelRouting,
    sticker_policy: stickerPolicy,
    is_master: master,
    user: { id: user.id, first_name: user.first_name, username: user.username },
  };
}

async function handleSubmit(
  deps: ApiDeps,
  user: TelegramUser,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const chatId = Number(body.chat_id);
  const note = String(body.note ?? '');
  const chatTitle = String(body.chat_title ?? '');

  if (!chatId || isNaN(chatId)) {
    return { ok: false, error: 'invalid_chat_id' };
  }

  const result = await allowlist.submit(deps.redis, deps.config, {
    chatId,
    userId: user.id,
    username: user.username,
    firstName: user.first_name,
    lastName: user.last_name,
    note,
    chatTitle,
  });

  // Dispatch auto AI review if enabled
  if (result.ok && deps.config.autoAiReviewOnSubmit && result.request_id) {
    void aiReview
      .runAiReview(deps.redis, deps.config, result.request_id, {
        aiCall: deps.aiCall,
        getRecentContext: deps.getRecentContext,
      })
      .catch((err: unknown) => logger.warn({ err, chatId }, 'Auto AI review failed'));
  }

  return { ...result };
}

async function handleMySubmissions(
  deps: ApiDeps,
  user: TelegramUser,
): Promise<Record<string, unknown>> {
  const result = await allowlist.listByUser(deps.redis, deps.config, user.id);
  return { ok: true, ...result };
}

async function handleCheckBotPermissions(
  deps: ApiDeps,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const chatId = Number(body.chat_id);
  if (!chatId || isNaN(chatId)) {
    return { ok: false, error: 'invalid_chat_id' };
  }

  const perms = await botPermission.getBotPermissions(deps.bot, chatId);
  if (!perms) {
    return { ok: false, error: 'failed_to_fetch' };
  }
  return { ok: true, permissions: perms };
}

async function handleList(deps: ApiDeps): Promise<Record<string, unknown>> {
  const pending = await allowlist.listPending(deps.redis, deps.config);
  const groups = await allowlist.listGroups(deps.redis, deps.config);
  const manualQueue = await allowlist.listManualQueue(deps.redis, deps.config);

  // Hydrate chat titles
  for (const group of groups) {
    try {
      if (group.chat_id) {
        const chat = await deps.bot.api.getChat(group.chat_id);
        group.title = 'title' in chat ? (chat.title ?? `Chat ${group.chat_id}`) : `Chat ${group.chat_id}`;
      }
    } catch {
      // title hydration is best-effort
    }
  }

  return { ok: true, pending, groups, manual_queue: manualQueue };
}

async function handleApprove(
  deps: ApiDeps,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestId = String(body.request_id ?? '');
  const enableNow = body.enable_now != null ? Boolean(body.enable_now) : undefined;
  if (!requestId) {
    return { ok: false, error: 'invalid_request_id' };
  }

  const result = await allowlist.approveRequest(
    deps.redis, deps.config, requestId, 'admin', enableNow,
  );
  if (result.ok && result.chat_id) {
    void notify
      .afterApproved(deps.bot, result.chat_id, result.enabled ?? false)
      .catch((err: unknown) =>
        logger.warn({ err, chatId: result.chat_id }, 'Approve notification failed'),
      );
  }
  return result;
}

async function handleReject(
  deps: ApiDeps,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestId = String(body.request_id ?? '');
  if (!requestId) {
    return { ok: false, error: 'invalid_request_id' };
  }

  const ok = await allowlist.rejectRequest(deps.redis, deps.config, requestId);
  return { ok };
}

async function handleAiReview(
  deps: ApiDeps,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestId = String(body.request_id ?? '');
  if (!requestId) {
    return { ok: false, error: 'invalid_request_id' };
  }

  const result = await aiReview.runAiReview(deps.redis, deps.config, requestId, {
    aiCall: deps.aiCall,
    getRecentContext: deps.getRecentContext,
  });
  return result;
}

async function handleSetEnabled(
  deps: ApiDeps,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const chatId = Number(body.chat_id);
  const enabled = Boolean(body.enabled);
  if (!chatId || isNaN(chatId)) {
    return { ok: false, error: 'invalid_chat_id' };
  }

  const ok = await allowlist.setGroupEnabled(deps.redis, deps.config, chatId, enabled);
  if (ok) {
    void notify
      .afterToggleEnabled(deps.bot, chatId, enabled)
      .catch((err: unknown) => logger.warn({ err, chatId }, 'Toggle notification failed'));
  }
  return { ok };
}

async function handleRemoveGroup(
  deps: ApiDeps,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const chatId = Number(body.chat_id);
  if (!chatId || isNaN(chatId)) {
    return { ok: false, error: 'invalid_chat_id' };
  }

  const ok = await allowlist.removeGroup(deps.redis, deps.config, chatId);
  return { ok };
}

async function handleModelRoutingGet(deps: ApiDeps): Promise<Record<string, unknown>> {
  const override = await runtimeConfig.loadOverride(deps.redis);
  const view = runtimeConfig.buildModelRoutingAdminView(
    {
      AI_MODEL_REPLY: deps.env.AI_MODEL_REPLY,
      AI_MODEL_REPLY_PRO: deps.env.AI_MODEL_REPLY_PRO,
      AI_MODEL_JUDGE: deps.env.AI_MODEL_JUDGE,
      AI_MODEL_ALLOWLIST_REVIEW: deps.env.AI_MODEL_ALLOWLIST_REVIEW,
    },
    override,
  );

  // Strip API keys from providers before sending to client
  if (view.providers && typeof view.providers === 'object') {
    const sanitized = view.providers as Record<string, Record<string, unknown>>;
    for (const label of Object.keys(sanitized)) {
      const entry = sanitized[label];
      if (entry) {
        delete entry.api_key;
        delete entry.api_keys;
      }
    }
  }

  return { ok: true, ...view };
}

async function handleModelRoutingSave(
  deps: ApiDeps,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const override = (await runtimeConfig.loadOverride(deps.redis)) ?? {};
  override.usage = body.usage as typeof override.usage;
  await runtimeConfig.saveOverride(deps.redis, override);
  logger.info('Model routing override saved via admin');
  return { ok: true };
}

async function handleProviderUpsert(
  deps: ApiDeps,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const label = String(body.label ?? '');
  const provider = body.provider as runtimeConfig.ProviderOverride | undefined;
  if (!label || !provider?.endpoint || !provider?.model) {
    return { ok: false, error: 'invalid_provider_params' };
  }

  const override = (await runtimeConfig.loadOverride(deps.redis)) ?? {};
  if (!override.providers) override.providers = {};
  override.providers[label] = provider;
  await runtimeConfig.saveOverride(deps.redis, override);
  logger.info({ label }, 'Provider upserted via admin');
  return { ok: true };
}

async function handleProviderValidate(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const provider = body.provider as runtimeConfig.ProviderOverride | undefined;
  if (!provider?.endpoint || !provider?.model) {
    return { ok: false, error: 'invalid_provider_params' };
  }

  const result = await runtimeConfig.validateProvider(provider);
  return { ...result };
}

async function handleStickerPolicyGet(deps: ApiDeps): Promise<Record<string, unknown>> {
  const override = await runtimeConfig.loadOverride(deps.redis);
  return {
    ok: true,
    ...runtimeConfig.buildStickerPolicyAdminView(override),
  };
}

async function handleStickerPolicySave(
  deps: ApiDeps,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const override = (await runtimeConfig.loadOverride(deps.redis)) ?? {};
  override.sticker_policy = body.sticker_policy as typeof override.sticker_policy;
  await runtimeConfig.saveOverride(deps.redis, override);
  logger.info('Sticker policy override saved via admin');
  return { ok: true };
}

// ── Create Hono API ────────────────────────────────────────────────

export function createAdminApi(deps: ApiDeps): Hono {
  const api = new Hono();

  // CORS
  api.use(
    '*',
    cors({
      origin: deps.env.ADMIN_CORS_ORIGINS.length > 0 ? deps.env.ADMIN_CORS_ORIGINS : '*',
      allowMethods: ['GET', 'POST'],
    }),
  );

  // Public endpoints
  api.get('/health', async (c) => {
    const health = await checkHealth(deps.redis);
    return c.json(health);
  });

  api.get('/model_status', async (c) => {
    // Require master auth via query param
    const initData = c.req.query('init_data');
    if (!initData) {
      return c.json({ ok: false, error: 'forbidden' }, 403);
    }
    const user = validateInitData(initData, deps.env.BOT_TOKEN);
    if (!user || !isMaster(user.id, deps.env.MASTER_UID)) {
      return c.json({ ok: false, error: 'forbidden' }, 403);
    }
    const history = await modelStatus.getModelStatusHistory(deps.redis);
    return c.json({ ok: true, history });
  });

  // Main dispatch endpoint (PHP compatibility)
  api.post('/', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const initData = body.init_data as string;
    const action = body.action as string;

    if (!initData || !action) {
      return c.json({ ok: false, error: 'missing_params' }, 400);
    }

    // Validate initData
    const user = validateInitData(initData, deps.env.BOT_TOKEN);
    if (!user) {
      return c.json({ ok: false, error: 'invalid_init_data' }, 401);
    }

    const master = isMaster(user.id, deps.env.MASTER_UID);

    // Route by action
    try {
      switch (action) {
        case 'bootstrap':
          return c.json(await handleBootstrap(deps, user, master));
        // User-accessible actions (any authenticated user):
        case 'submit':
          return c.json(await handleSubmit(deps, user, body));
        case 'my_submissions':
          return c.json(await handleMySubmissions(deps, user));
        case 'check_bot_permissions':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleCheckBotPermissions(deps, body));
        case 'list':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleList(deps));
        case 'approve':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleApprove(deps, body));
        case 'reject':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleReject(deps, body));
        case 'ai_review':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleAiReview(deps, body));
        case 'set_enabled':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleSetEnabled(deps, body));
        case 'remove_group':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleRemoveGroup(deps, body));
        case 'model_routing_get':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleModelRoutingGet(deps));
        case 'model_routing_save':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleModelRoutingSave(deps, body));
        case 'provider_upsert':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleProviderUpsert(deps, body));
        case 'provider_validate':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleProviderValidate(body));
        case 'sticker_policy_get':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleStickerPolicyGet(deps));
        case 'sticker_policy_save':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleStickerPolicySave(deps, body));
        default:
          return c.json({ ok: false, error: 'unknown_action' }, 400);
      }
    } catch (err) {
      logger.error({ err, action }, 'Admin API error');
      return c.json({ ok: false, error: 'internal_error' }, 500);
    }
  });

  return api;
}

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
import * as stickerStore from '../knowledge/sticker/store.js';

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
      managed_enabled: deps.config.enabled,
      user: { id: user.id, first_name: user.first_name, username: user.username },
      ...myData,
    };
  }

  const pending = await allowlist.listPending(deps.redis, deps.config);
  const groups = await allowlist.listGroups(deps.redis, deps.config);
  const manualQueue = await allowlist.listManualQueue(deps.redis, deps.config);

  // Hydrate chat titles (bootstrap)
  for (const item of [...pending, ...groups] as Array<Record<string, unknown>>) {
    const cid = item.chat_id as number;
    if (!cid) continue;
    const idsToTry = cid > 0 ? [Number(`-100${cid}`), cid] : [cid];
    for (const tryId of idsToTry) {
      try {
        const chat = await deps.bot.api.getChat(tryId);
        if ('title' in chat && chat.title) { item.title = chat.title; item.chat_title = chat.title; }
        if ('username' in chat && chat.username) { item.chat_username = `@${chat.username}`; }
        break;
      } catch { /* best-effort */ }
    }
  }
  const override = await runtimeConfig.loadOverride(deps.redis);

  const modelRouting = runtimeConfig.buildModelRoutingAdminView();

  const stickerPolicy = runtimeConfig.buildStickerPolicyAdminView(override);

  return {
    ok: true,
    pending,
    groups,
    manual_queue: manualQueue,
    model_routing: modelRouting,
    sticker_policy: stickerPolicy,
    managed_enabled: deps.config.enabled,
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
        getChat: async (chatId: number) => {
          try { return await deps.bot.api.getChat(chatId) as unknown as Record<string, unknown>; } catch { return null; }
        },
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
    getChat: async (chatId: number) => {
      try { return await deps.bot.api.getChat(chatId) as unknown as Record<string, unknown>; } catch { return null; }
    },
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

async function handleModelRoutingGet(): Promise<Record<string, unknown>> {
  const view = runtimeConfig.buildModelRoutingAdminView();
  return { ok: true, ...view };
}

async function handleProviderValidate(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const provider = body.provider as runtimeConfig.ProviderValidateInput | undefined;
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

async function handleStickerKbList(): Promise<Record<string, unknown>> {
  const raw = stickerStore.listStickerKbIndex();
  const items: Array<Record<string, unknown>> = [];
  for (const row of raw) {
    const item: Record<string, unknown> = {
      file_unique_id: row.file_unique_id,
      latest_file_id: row.latest_file_id,
      set_name: row.set_name,
      emoji: row.emoji,
      sticker_format: row.sticker_format,
      usage_count: row.usage_count,
      analysis_status: row.analysis_status,
      asset_status: row.asset_status,
    };
    if (row.analysis_status === 'ready') {
      const full = stickerStore.getItem(row.file_unique_id);
      item['persona_fit'] = full?.personaFit ?? null;
      item['emotion_tags'] = full?.emotionTags ?? [];
      item['mood_map'] = full?.moodMap ?? {};
    } else {
      item['persona_fit'] = null;
      item['emotion_tags'] = [];
      item['mood_map'] = {};
    }
    items.push(item);
  }
  return { ok: true, items };
}

async function handleStickerKbUpdate(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const fuid = typeof body['file_unique_id'] === 'string' ? body['file_unique_id'].trim() : '';
  if (
    fuid === '' ||
    fuid.length > 100 ||
    !/^[a-zA-Z0-9_-]+$/.test(fuid)
  ) {
    return { ok: false, error: 'missing_file_unique_id' };
  }

  if (!stickerStore.getItem(fuid)) {
    return { ok: false, error: 'sticker_not_found' };
  }

  if (body['requeue']) {
    const ok = stickerStore.requeueStickerAnalysis(fuid);
    if (!ok) {
      return { ok: false, error: 'sticker_not_found' };
    }
    return { ok: true, action: 'requeued' };
  }

  if (Object.prototype.hasOwnProperty.call(body, 'persona_fit')) {
    const raw = body['persona_fit'];
    const newFit = raw === null ? null : Boolean(raw);
    const ok = stickerStore.setStickerPersonaFit(fuid, newFit);
    if (!ok) {
      return { ok: false, error: 'sticker_not_found' };
    }
    return { ok: true, action: 'persona_fit_updated', persona_fit: newFit };
  }

  return { ok: false, error: 'no_action_specified' };
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
          return c.json(await handleModelRoutingGet());
        case 'provider_validate':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleProviderValidate(body));
        case 'sticker_policy_get':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleStickerPolicyGet(deps));
        case 'sticker_policy_save':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleStickerPolicySave(deps, body));
        case 'sticker_kb_list':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleStickerKbList());
        case 'sticker_kb_update': {
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          const skRes = await handleStickerKbUpdate(body);
          if (!skRes.ok) {
            const err = String(skRes['error'] ?? '');
            if (err === 'sticker_not_found') return c.json(skRes, 404);
            if (err === 'missing_file_unique_id' || err === 'no_action_specified') {
              return c.json(skRes, 400);
            }
          }
          return c.json(skRes);
        }
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

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { logger } from './shared/logger.js';
import { env } from './env.js';
import { getConfig } from './shared/config.js';
import { getRedis, closeRedis } from './db/redis.js';
import { runMigrations, closeDb } from './db/sqlite.js';
import { createBot, stopBot } from './bot/bot.js';
import { startWorker, closeWorker } from './queue/worker.js';
import { closeQueue } from './queue/producer.js';
import { freeEncoder } from './ai/token-counter.js';
import { createAllowlistMiddleware } from './bot/middleware/allowlist.js';
import { registerMemberHandler } from './bot/handlers/member.js';import { createAdminApi } from './admin/api.js';
import { startCronJobs, stopCronJobs } from './cron/scheduler.js';
import { initBotTracker } from './tracking/interaction.js';
import { isMemoryAvailable } from './memory/chroma.js';
import type { AllowlistConfig } from './allowlist/types.js';

async function main(): Promise<void> {
  logger.info('xxb-ts starting…');

  // 1. Validate env
  const config = env();
  logger.info({ nodeEnv: config.NODE_ENV }, 'Environment validated');

  // 2. Connect Redis
  const redis = getRedis();
  await redis.connect();

  // 3. Run SQLite migrations
  const appConfig = getConfig();
  runMigrations(appConfig.migrationsDir);

  // 3.5 Initialize bot interaction tracker
  initBotTracker();

  // 4. Create bot (fetches bot identity via getMe)
  const bot = await createBot();

  // 5. Build allowlist config from env
  const allowlistConfig: AllowlistConfig = {
    enabled: config.ALLOWLIST_ENABLED,
    redisPrefix: config.ALLOWLIST_REDIS_PREFIX,
    defaultEnabledAfterApproval: config.ALLOWLIST_DEFAULT_ENABLE_AFTER_APPROVE,
    maxSubmissionsPerUserPerDay: config.ALLOWLIST_MAX_SUBMISSIONS_PER_DAY,
    autoAiReviewOnSubmit: config.ALLOWLIST_AUTO_AI_REVIEW,
    autoAiReviewMessageLimit: config.ALLOWLIST_AI_MESSAGE_LIMIT,
    aiReviewContextMaxChars: config.ALLOWLIST_AI_CONTEXT_MAX_CHARS,
    aiApproveAutoEnable: config.ALLOWLIST_AI_AUTO_ENABLE,
    aiApproveConfidenceThreshold: config.ALLOWLIST_AI_CONFIDENCE_THRESHOLD,
  };

  // 6. Register allowlist middleware
  if (allowlistConfig.enabled) {
    bot.use(createAllowlistMiddleware(allowlistConfig));
    logger.info('Allowlist middleware registered');
  }

  // 7. Register member handler
  registerMemberHandler(bot, allowlistConfig);

  // 8. Start BullMQ worker
  startWorker();

  // 9. Start bot (webhook or polling)
  if (config.WEBHOOK_URL) {
    const secretPath = config.WEBHOOK_SECRET ?? '';
    // Retry once on 429 (Telegram rate-limits setWebhook during rapid restarts)
    try {
      await bot.api.setWebhook(`${config.WEBHOOK_URL}/${secretPath}`);
    } catch (err: unknown) {
      const retryAfter =
        err instanceof Error && 'parameters' in err
          ? ((err as Record<string, unknown>).parameters as Record<string, number> | undefined)?.retry_after
          : undefined;
      const delay = ((retryAfter ?? 1) + 1) * 1000;
      logger.warn({ delay }, 'setWebhook 429, retrying after delay');
      await new Promise((r) => setTimeout(r, delay));
      await bot.api.setWebhook(`${config.WEBHOOK_URL}/${secretPath}`);
    }
    logger.info({ url: config.WEBHOOK_URL }, 'Webhook set');
  } else {
    // Polling mode
    void bot.start({
      onStart: () => logger.info('Bot started (polling)'),
    });
  }

  // 10. Start Hono HTTP server (health check + admin API)
  const app = new Hono();
  app.get('/health', (c) => c.json({ status: 'ok', uptime: process.uptime() }));
  app.get('/miniapp', (c) => c.redirect('/miniapp/'));
  app.use('/miniapp/*', serveStatic({ root: './' }));

  // Mount admin API at /miniapp_api
  const adminApi = createAdminApi({
    redis,
    bot,
    config: allowlistConfig,
    env: config,
    aiCall: async (_systemPrompt: string, _userMessage: string) => {
      // AI call stub — will be wired to real AI client
      return null;
    },
  });
  app.route('/miniapp_api', adminApi);

  if (config.WEBHOOK_URL && config.WEBHOOK_SECRET) {
    // Webhook endpoint for Telegram
    app.post(`/${config.WEBHOOK_SECRET}`, async (c) => {
      const update = await c.req.json();
      await bot.handleUpdate(update);
      return c.json({ ok: true });
    });
  }

  const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
    logger.info({ port: info.port }, 'HTTP server listening');
  });

  // 12. Start cron jobs
  startCronJobs({ cleanupDeps: { redis, allowlistConfig } });

  // 12.1 Warm up ChromaDB + embedder (fire-and-forget)
  isMemoryAvailable().then((ok) => {
    logger.info({ ok }, 'Memory availability check');
  }).catch(() => { /* non-critical */ });

  // 13. Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'Shutting down…');

    // Force exit after 30 seconds if graceful shutdown hangs
    const forceTimer = setTimeout(() => {
      logger.error('Forced exit after shutdown timeout');
      process.exit(1);
    }, 30_000);
    forceTimer.unref();

    try {
      server.close();
      // Close worker FIRST — waits for in-progress jobs to finish
      // (they still need bot for sendMessage). Then stop bot.
      await closeWorker();
      await stopBot();
      await closeQueue();
      stopCronJobs();
      await closeRedis();
      closeDb();
      freeEncoder();
      logger.info('Shutdown complete');
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});

import { z } from 'zod';
import 'dotenv/config';

const envSchema = z.object({
  // Telegram
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN is required'),
  BOT_USERNAME: z.string().min(1).default('xxb_bot'),

  // Redis
  REDIS_URL: z.string().url().default('redis://127.0.0.1:6379/0'),

  // SQLite
  SQLITE_PATH: z.string().default('./data/xxb.db'),

  // AI
  AI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  AI_API_KEY: z.string().min(1, 'AI_API_KEY is required'),
  AI_MODEL_JUDGE: z.string().default('gpt-4o-mini'),
  AI_MODEL_REPLY: z.string().default('gpt-4o-mini'),
  AI_MODEL_REPLY_PRO: z.string().default('gpt-4o'),
  AI_MODEL_VISION: z.string().default('gpt-4o'),
  AI_MODEL_SUMMARIZE: z.string().default('gpt-4o-mini'),

  // Server
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Webhook (optional — use polling if not set)
  WEBHOOK_URL: z.string().url().optional(),
  WEBHOOK_SECRET: z.string().optional(),

  // Queue
  QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(20),

  // AI tuning
  HEDGE_DELAY_MS: z.coerce.number().int().nonnegative().default(2000),

  // Rate limiting
  RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(30),

  // Streaming
  STREAMING_MIN_INTERVAL: z.coerce.number().int().nonnegative().default(500),
  STREAMING_MIN_CHARS: z.coerce.number().int().nonnegative().default(50),

  // Tool System
  SEARXNG_URL: z.string().url().optional(),
  FETCH_GATEWAY_URL: z.string().optional(),
  FETCH_WORKER_URL: z.string().url().optional(),
  WEB_FETCH_USER_AGENT: z.string().default('XXB-WebFetch/1.0'),
  IP_QUALITY_API_URL: z.string().url().optional(),
  TIMER_API_URL: z.string().url().optional(),
  TIMER_CALLBACK_URL: z.string().url().optional(),
  COMMON_API_KEY: z.string().optional(),

  // Tracking
  OUTCOME_TRACKING_ENABLED: z.coerce.boolean().default(false),

  // Business
  MASTER_UID: z.coerce.number().int().default(0),
  BOT_NICKNAMES: z
    .string()
    .default('xxb,啾咪囝')
    .transform((s) => s.split(',')),
  CONTEXT_MAX_LENGTH: z.coerce.number().int().positive().default(600),
  JUDGE_WINDOW_SIZE: z.coerce.number().int().positive().default(10),

  // Allowlist
  ALLOWLIST_ENABLED: z.coerce.boolean().default(false),
  ALLOWLIST_REDIS_PREFIX: z.string().default('xxb:mal:'),
  ALLOWLIST_DEFAULT_ENABLE_AFTER_APPROVE: z.coerce.boolean().default(false),
  ALLOWLIST_MAX_SUBMISSIONS_PER_DAY: z.coerce.number().int().default(20),
  ALLOWLIST_AUTO_AI_REVIEW: z.coerce.boolean().default(true),
  ALLOWLIST_AI_MESSAGE_LIMIT: z.coerce.number().int().default(100),
  ALLOWLIST_AI_CONTEXT_MAX_CHARS: z.coerce.number().int().default(24000),
  ALLOWLIST_AI_AUTO_ENABLE: z.coerce.boolean().default(true),
  ALLOWLIST_AI_CONFIDENCE_THRESHOLD: z.coerce.number().default(0.85),

  // AI - allowlist review model
  AI_MODEL_ALLOWLIST_REVIEW: z.string().default('gpt-4o-mini'),

  // Admin
  ADMIN_CORS_ORIGINS: z
    .string()
    .default('')
    .transform((s) => (s ? s.split(',') : [])),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(overrides?: Record<string, string | undefined>): Env {
  const source = overrides ?? process.env;
  return envSchema.parse(source);
}

let _env: Env | undefined;

export function env(): Env {
  if (!_env) {
    _env = parseEnv();
  }
  return _env;
}

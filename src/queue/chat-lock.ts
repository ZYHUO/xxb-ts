// ────────────────────────────────────────
// Per-chat critical-section lock (Redis NX)
// ────────────────────────────────────────
//
// Used for short per-chat critical sections where ordering matters.
// The pipeline acquires it around intake/judge and again around send/finalize.
//
// Lock TTL is a safety net — if the process crashes mid-pipeline the lock
// expires automatically so the next message isn't blocked forever.

import { getRedis } from "../db/redis.js";
import { logger } from "../shared/logger.js";

const LOCK_TTL_MS = 60_000; // long enough for a chat-critical section before auto-expire
const POLL_INTERVAL_MS = 100; // how often to retry acquiring the lock
const MAX_WAIT_MS = 120_000; // give up after 2 minutes waiting

function lockKey(chatId: number): string {
  return `xxb:chat:lock:${chatId}`;
}

/**
 * Acquire the per-chat lock. Waits (polling) until acquired or timeout.
 * Returns a release function. Always call release() in a finally block.
 */
export async function acquireChatLock(
  chatId: number,
): Promise<() => Promise<void>> {
  const redis = getRedis();
  const key = lockKey(chatId);
  const waited = { ms: 0 };

  while (true) {
    // SET key 1 NX PX ttl — only set if key doesn't exist
    const result = await redis.set(key, "1", "NX", "PX", LOCK_TTL_MS);
    if (result === "OK") {
      if (waited.ms > 0) {
        logger.debug(
          { chatId, waitedMs: waited.ms },
          "Chat lock acquired after wait",
        );
      }
      return async () => {
        try {
          await redis.del(key);
        } catch (err) {
          logger.debug(
            { chatId, err },
            "Chat lock release failed (non-critical)",
          );
        }
      };
    }

    // Lock is held — wait and retry
    if (waited.ms >= MAX_WAIT_MS) {
      logger.warn(
        { chatId, waitedMs: waited.ms },
        "Chat lock wait timeout, forcing acquire",
      );
      await redis.set(key, "1", "PX", LOCK_TTL_MS);
      return async () => {
        try {
          await redis.del(key);
        } catch {
          // Best effort
        }
      };
    }

    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    waited.ms += POLL_INTERVAL_MS;
  }
}

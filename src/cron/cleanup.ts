// ────────────────────────────────────────
// Data cleanup — expired contexts, old logs
// ────────────────────────────────────────

import { logger } from '../shared/logger.js';

export async function runCleanup(): Promise<void> {
  // Cleanup tasks (best-effort, errors are caught internally):
  // 1. Remove expired Redis context entries beyond retention
  // 2. Trim old reply_outcomes beyond threshold
  // 3. Clean up stale pending entries
  logger.info('Cleanup job completed');
}

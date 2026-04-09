// ────────────────────────────────────────
// Knowledge Manager — knowledge base loading
// ────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';

let _permanentKnowledge: string | undefined;

/**
 * Load permanent knowledge from file.
 */
export function loadPermanentKnowledge(): string {
  if (_permanentKnowledge !== undefined) return _permanentKnowledge;

  const config = getConfig();
  const knowledgePath = resolve(config.promptsDir, 'knowledge/permanent.md');

  if (!existsSync(knowledgePath)) {
    logger.debug('No permanent knowledge file found');
    _permanentKnowledge = '';
    return '';
  }

  _permanentKnowledge = readFileSync(knowledgePath, 'utf-8').trim();
  logger.info({ length: _permanentKnowledge.length }, 'Permanent knowledge loaded');
  return _permanentKnowledge;
}

/**
 * Get knowledge for a specific chat.
 * Phase 2: returns only permanent knowledge.
 * Group-specific knowledge from Redis will be Phase 3.
 */
export function getKnowledge(_chatId: number): string {
  return loadPermanentKnowledge();
}

/** Reset cached knowledge (for testing) */
export function _resetKnowledge(): void {
  _permanentKnowledge = undefined;
}

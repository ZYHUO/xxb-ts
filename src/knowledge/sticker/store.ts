// ────────────────────────────────────────
// StickerStore — SQLite-based sticker knowledge CRUD
// Port of PHP StickerKnowledgeService (file-based → SQLite)
// ────────────────────────────────────────

import { getDb } from '../../db/sqlite.js';
import { logger } from '../../shared/logger.js';
import type {
  StickerItem,
  StickerSample,
  StickerMeta,
  AnalysisStatus,
  StickerFormat,
  AssetStatus,
} from './types.js';
import { INTENT_SYNONYMS } from './types.js';
import type { StickerIntent } from './types.js';

const MAX_SAMPLES_PER_STICKER = 50;
const MAX_SAMPLES_PER_CHAT = 10;

function safeJsonParse<T>(value: string | null | undefined, fallback: T | null): T | null {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    logger.warn({ value: value.slice(0, 100) }, 'StickerStore: corrupt JSON in DB row');
    return fallback;
  }
}

// ── Row ↔ Domain mapping ──────────────────────────

interface StickerItemRow {
  file_unique_id: string;
  latest_file_id: string | null;
  set_name: string | null;
  emoji: string | null;
  sticker_format: string;
  usage_count: number;
  sample_count: number;
  first_seen_at: number | null;
  last_seen_at: number | null;
  analysis_status: string;
  analysis_reason: string | null;
  analysis_updated_at: number | null;
  asset_status: string;
  raw_asset_path: string | null;
  preview_asset_path: string | null;
  emotion_tags: string | null;
  mood_map: string | null;
  persona_fit: number | null;
  description: string | null;
}

interface StickerSampleRow {
  id: number;
  file_unique_id: string;
  chat_id: number;
  message_id: number;
  date: number;
  from_user_id: number | null;
  username: string | null;
  reply_to_message_id: number | null;
  reply_target_text: string | null;
  context_before: string | null;
}

function rowToItem(row: StickerItemRow): StickerItem {
  return {
    fileUniqueId: row.file_unique_id,
    latestFileId: row.latest_file_id,
    setName: row.set_name,
    emoji: row.emoji,
    stickerFormat: row.sticker_format as StickerFormat,
    usageCount: row.usage_count,
    sampleCount: row.sample_count,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    analysisStatus: row.analysis_status as AnalysisStatus,
    analysisReason: row.analysis_reason,
    analysisUpdatedAt: row.analysis_updated_at,
    assetStatus: row.asset_status as AssetStatus,
    rawAssetPath: row.raw_asset_path,
    previewAssetPath: row.preview_asset_path,
    emotionTags: safeJsonParse<string[]>(row.emotion_tags, null),
    moodMap: safeJsonParse<Record<string, number>>(row.mood_map, null),
    personaFit: row.persona_fit === null ? null : row.persona_fit !== 0,
    description: row.description,
  };
}

function rowToSample(row: StickerSampleRow): StickerSample {
  return {
    id: row.id,
    fileUniqueId: row.file_unique_id,
    chatId: row.chat_id,
    messageId: row.message_id,
    date: row.date,
    fromUserId: row.from_user_id,
    username: row.username,
    replyToMessageId: row.reply_to_message_id,
    replyTargetText: row.reply_target_text,
    contextBefore: row.context_before,
  };
}

// ── Public API ────────────────────────────────────

export function recordStickerUsage(
  meta: StickerMeta,
  sample: Omit<StickerSample, 'id'>,
): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const run = db.transaction(() => {
    // 1. UPSERT sticker_items
    db.prepare(`
      INSERT INTO sticker_items (
        file_unique_id, latest_file_id, set_name, emoji, sticker_format,
        usage_count, sample_count, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)
      ON CONFLICT(file_unique_id) DO UPDATE SET
        latest_file_id = COALESCE(excluded.latest_file_id, latest_file_id),
        set_name = COALESCE(excluded.set_name, set_name),
        emoji = COALESCE(excluded.emoji, emoji),
        sticker_format = CASE
          WHEN excluded.sticker_format != 'unknown' THEN excluded.sticker_format
          ELSE sticker_format
        END,
        usage_count = usage_count + 1,
        first_seen_at = COALESCE(
          MIN(first_seen_at, excluded.first_seen_at),
          excluded.first_seen_at,
          first_seen_at
        ),
        last_seen_at = COALESCE(
          MAX(last_seen_at, excluded.last_seen_at),
          excluded.last_seen_at,
          last_seen_at
        )
    `).run(
      meta.fileUniqueId,
      meta.fileId,
      meta.setName,
      meta.emoji,
      meta.stickerFormat,
      sample.date || now,
      sample.date || now,
    );

    // 2. Enforce per-chat sample limit before inserting
    const chatCount = db.prepare(`
      SELECT COUNT(*) as cnt FROM sticker_samples
      WHERE file_unique_id = ? AND chat_id = ?
    `).get(sample.fileUniqueId, sample.chatId) as { cnt: number };

    if (chatCount.cnt >= MAX_SAMPLES_PER_CHAT) {
      db.prepare(`
        DELETE FROM sticker_samples WHERE id IN (
          SELECT id FROM sticker_samples
          WHERE file_unique_id = ? AND chat_id = ?
          ORDER BY date ASC
          LIMIT 1
        )
      `).run(sample.fileUniqueId, sample.chatId);
    }

    // 3. INSERT sample
    db.prepare(`
      INSERT INTO sticker_samples (
        file_unique_id, chat_id, message_id, date,
        from_user_id, username, reply_to_message_id,
        reply_target_text, context_before
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sample.fileUniqueId,
      sample.chatId,
      sample.messageId,
      sample.date,
      sample.fromUserId,
      sample.username,
      sample.replyToMessageId,
      sample.replyTargetText,
      sample.contextBefore,
    );

    // 4. Enforce overall sample limit
    const totalCount = db.prepare(`
      SELECT COUNT(*) as cnt FROM sticker_samples
      WHERE file_unique_id = ?
    `).get(sample.fileUniqueId) as { cnt: number };

    if (totalCount.cnt > MAX_SAMPLES_PER_STICKER) {
      const excess = totalCount.cnt - MAX_SAMPLES_PER_STICKER;
      db.prepare(`
        DELETE FROM sticker_samples WHERE id IN (
          SELECT id FROM sticker_samples
          WHERE file_unique_id = ?
          ORDER BY date ASC
          LIMIT ?
        )
      `).run(sample.fileUniqueId, excess);
    }

    // 5. Update sample_count
    const finalCount = db.prepare(`
      SELECT COUNT(*) as cnt FROM sticker_samples
      WHERE file_unique_id = ?
    `).get(sample.fileUniqueId) as { cnt: number };

    db.prepare(`
      UPDATE sticker_items SET sample_count = ? WHERE file_unique_id = ?
    `).run(finalCount.cnt, meta.fileUniqueId);
  });

  try {
    run();
  } catch (err) {
    logger.warn({ err, fileUniqueId: meta.fileUniqueId }, 'recordStickerUsage failed');
  }
}

export function getItem(fileUniqueId: string): StickerItem | null {
  const row = getDb().prepare(
    'SELECT * FROM sticker_items WHERE file_unique_id = ?',
  ).get(fileUniqueId) as StickerItemRow | undefined;
  return row ? rowToItem(row) : null;
}

export function listPendingItems(): StickerItem[] {
  const rows = getDb().prepare(
    "SELECT * FROM sticker_items WHERE analysis_status = 'pending'",
  ).all() as StickerItemRow[];
  return rows.map(rowToItem);
}

export function listAnalysisQueueItems(): StickerItem[] {
  const rows = getDb().prepare(`
    SELECT * FROM sticker_items
    WHERE analysis_status = 'pending'
       OR (analysis_status = 'waiting_for_preview'
           AND asset_status IN ('raw_ready', 'preview_ready'))
  `).all() as StickerItemRow[];
  return rows.map(rowToItem);
}

export function storeAnalysisResult(
  fileUniqueId: string,
  analysis: {
    emotionTags?: string[];
    moodMap?: Record<string, number>;
    personaFit?: boolean;
    description?: string;
  },
): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(`
    UPDATE sticker_items SET
      emotion_tags = ?,
      mood_map = ?,
      persona_fit = ?,
      description = ?,
      analysis_status = 'ready',
      analysis_reason = NULL,
      analysis_updated_at = ?
    WHERE file_unique_id = ?
  `).run(
    analysis.emotionTags ? JSON.stringify(analysis.emotionTags) : null,
    analysis.moodMap ? JSON.stringify(analysis.moodMap) : null,
    analysis.personaFit === undefined ? null : analysis.personaFit ? 1 : 0,
    analysis.description ?? null,
    now,
    fileUniqueId,
  );
}

export function markAnalysisFailed(fileUniqueId: string): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(`
    UPDATE sticker_items SET
      analysis_status = 'failed',
      analysis_updated_at = ?
    WHERE file_unique_id = ?
  `).run(now, fileUniqueId);
}

export function markWaitingForPreview(fileUniqueId: string, reason: string): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(`
    UPDATE sticker_items SET
      analysis_status = 'waiting_for_preview',
      analysis_reason = ?,
      analysis_updated_at = ?
    WHERE file_unique_id = ?
  `).run(reason, now, fileUniqueId);
}

export function setRawAssetPath(fileUniqueId: string, rawPath: string): boolean {
  const result = getDb().prepare(`
    UPDATE sticker_items SET
      raw_asset_path = ?,
      asset_status = 'raw_ready'
    WHERE file_unique_id = ?
  `).run(rawPath, fileUniqueId);
  return result.changes > 0;
}

export function getReadyStickersByIntent(
  intent: string,
): Array<{ fileId: string; score: number }> {
  const rows = getDb().prepare(`
    SELECT latest_file_id, emotion_tags, mood_map
    FROM sticker_items
    WHERE analysis_status = 'ready'
      AND (persona_fit IS NULL OR persona_fit != 0)
      AND latest_file_id IS NOT NULL
  `).all() as Array<{
    latest_file_id: string;
    emotion_tags: string | null;
    mood_map: string | null;
  }>;

  const candidates: Array<{ fileId: string; score: number }> = [];

  for (const row of rows) {
    const emotionTags = row.emotion_tags
      ? (JSON.parse(row.emotion_tags) as string[])
      : [];
    const moodMap = row.mood_map
      ? (JSON.parse(row.mood_map) as Record<string, number>)
      : {};

    const score = scoreIntentMatch(intent, emotionTags, moodMap);
    if (score > 0) {
      candidates.push({ fileId: row.latest_file_id, score });
    }
  }

  return candidates;
}

export function getSamples(
  fileUniqueId: string,
  limit = 50,
): StickerSample[] {
  const rows = getDb().prepare(`
    SELECT * FROM sticker_samples
    WHERE file_unique_id = ?
    ORDER BY date DESC
    LIMIT ?
  `).all(fileUniqueId, limit) as StickerSampleRow[];
  return rows.map(rowToSample);
}

export function incrementUsageCount(fileUniqueId: string): void {
  getDb().prepare(`
    UPDATE sticker_items SET usage_count = usage_count + 1
    WHERE file_unique_id = ?
  `).run(fileUniqueId);
}

// ── Internal scoring (port of PHP scoreIntentMatch) ──

function scoreIntentMatch(
  intent: string,
  emotionTags: string[],
  moodMap: Record<string, number>,
): number {
  const synonyms = INTENT_SYNONYMS[intent as StickerIntent] ?? [intent];
  let score = 0;

  for (const tag of emotionTags) {
    if (typeof tag !== 'string') continue;
    const tagLower = tag.toLowerCase();
    for (const syn of synonyms) {
      if (tagLower === syn) {
        score += 3;
      } else if (tagLower.includes(syn) || syn.includes(tagLower)) {
        score += 1;
      }
    }
  }

  for (const moodKey of Object.keys(moodMap)) {
    const keyLower = moodKey.toLowerCase();
    for (const syn of synonyms) {
      if (keyLower === syn || keyLower.includes(syn)) {
        score += 2;
      }
    }
  }

  return score;
}

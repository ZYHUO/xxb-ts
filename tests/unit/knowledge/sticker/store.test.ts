// ────────────────────────────────────────
// Tests: StickerStore — SQLite CRUD
// ────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Mock the sqlite module to use an in-memory database
let testDb: Database.Database;

vi.mock('../../../../src/db/sqlite.js', () => ({
  getDb: () => testDb,
}));

// Must import AFTER mock registration
const {
  recordStickerUsage,
  getItem,
  listPendingItems,
  listAnalysisQueueItems,
  storeAnalysisResult,
  markAnalysisFailed,
  markWaitingForPreview,
  setRawAssetPath,
  getReadyStickersByIntent,
  getSamples,
} = await import('../../../../src/knowledge/sticker/store.js');

function initSchema(db: Database.Database): void {
  // Create tables from migration
  const migrationSql = readFileSync(
    resolve(process.cwd(), 'migrations/0003_stickers.sql'),
    'utf-8',
  );
  db.exec(migrationSql);
}

function makeMeta(overrides: Record<string, unknown> = {}) {
  return {
    fileUniqueId: 'fuid_abc123',
    fileId: 'fid_xyz',
    setName: 'TestSet',
    emoji: '😺',
    stickerFormat: 'static_webp' as const,
    ...overrides,
  };
}

function makeSample(overrides: Record<string, unknown> = {}) {
  return {
    fileUniqueId: 'fuid_abc123',
    chatId: -1001234,
    messageId: 100,
    date: 1700000000,
    fromUserId: 42,
    username: 'tester',
    replyToMessageId: null,
    replyTargetText: null,
    contextBefore: JSON.stringify([{ uid: 1, username: 'alice', text: 'hello' }]),
    ...overrides,
  };
}

describe('StickerStore', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    initSchema(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  describe('recordStickerUsage', () => {
    it('should create a new sticker item on first usage', () => {
      recordStickerUsage(makeMeta(), makeSample());

      const item = getItem('fuid_abc123');
      expect(item).not.toBeNull();
      expect(item!.fileUniqueId).toBe('fuid_abc123');
      expect(item!.latestFileId).toBe('fid_xyz');
      expect(item!.setName).toBe('TestSet');
      expect(item!.emoji).toBe('😺');
      expect(item!.stickerFormat).toBe('static_webp');
      expect(item!.usageCount).toBe(1);
      expect(item!.sampleCount).toBe(1);
      expect(item!.analysisStatus).toBe('pending');
    });

    it('should increment usage_count on subsequent uses', () => {
      recordStickerUsage(makeMeta(), makeSample());
      recordStickerUsage(makeMeta(), makeSample({ messageId: 101, date: 1700000001 }));
      recordStickerUsage(makeMeta(), makeSample({ messageId: 102, date: 1700000002 }));

      const item = getItem('fuid_abc123');
      expect(item!.usageCount).toBe(3);
      expect(item!.sampleCount).toBe(3);
    });

    it('should update timestamps correctly', () => {
      recordStickerUsage(makeMeta(), makeSample({ date: 1700000100 }));
      recordStickerUsage(makeMeta(), makeSample({ messageId: 101, date: 1700000050 }));

      const item = getItem('fuid_abc123');
      expect(item!.firstSeenAt).toBe(1700000050);
      expect(item!.lastSeenAt).toBe(1700000100);
    });

    it('should cap samples per chat at MAX_SAMPLES_PER_CHAT (10)', () => {
      // Insert 12 samples from the same chat
      for (let i = 0; i < 12; i++) {
        recordStickerUsage(
          makeMeta(),
          makeSample({ messageId: 100 + i, date: 1700000000 + i }),
        );
      }

      const samples = getSamples('fuid_abc123');
      const chatSamples = samples.filter((s) => s.chatId === -1001234);
      expect(chatSamples.length).toBeLessThanOrEqual(10);
    });

    it('should update sticker_format from unknown to known', () => {
      recordStickerUsage(
        makeMeta({ stickerFormat: 'unknown' }),
        makeSample(),
      );
      expect(getItem('fuid_abc123')!.stickerFormat).toBe('unknown');

      recordStickerUsage(
        makeMeta({ stickerFormat: 'animated_tgs' }),
        makeSample({ messageId: 101 }),
      );
      expect(getItem('fuid_abc123')!.stickerFormat).toBe('animated_tgs');
    });
  });

  describe('getItem', () => {
    it('should return null for non-existent sticker', () => {
      expect(getItem('nonexistent')).toBeNull();
    });

    it('should return correct item after creation', () => {
      recordStickerUsage(makeMeta(), makeSample());
      const item = getItem('fuid_abc123');
      expect(item).not.toBeNull();
      expect(item!.fileUniqueId).toBe('fuid_abc123');
    });
  });

  describe('listPendingItems', () => {
    it('should return items with pending analysis_status', () => {
      recordStickerUsage(makeMeta(), makeSample());
      recordStickerUsage(
        makeMeta({ fileUniqueId: 'fuid_other' }),
        makeSample({ fileUniqueId: 'fuid_other', messageId: 200 }),
      );

      const pending = listPendingItems();
      expect(pending).toHaveLength(2);
    });

    it('should not return items with non-pending status', () => {
      recordStickerUsage(makeMeta(), makeSample());
      storeAnalysisResult('fuid_abc123', {
        emotionTags: ['cute'],
        personaFit: true,
      });

      const pending = listPendingItems();
      expect(pending).toHaveLength(0);
    });
  });

  describe('listAnalysisQueueItems', () => {
    it('should return pending items', () => {
      recordStickerUsage(makeMeta(), makeSample());
      const queue = listAnalysisQueueItems();
      expect(queue).toHaveLength(1);
    });

    it('should return waiting_for_preview items when asset is ready', () => {
      recordStickerUsage(makeMeta(), makeSample());
      markWaitingForPreview('fuid_abc123', 'needs preview');
      setRawAssetPath('fuid_abc123', '/path/to/raw.webp');

      const queue = listAnalysisQueueItems();
      expect(queue).toHaveLength(1);
      expect(queue[0]!.analysisStatus).toBe('waiting_for_preview');
    });
  });

  describe('storeAnalysisResult', () => {
    it('should set analysis to ready and store tags', () => {
      recordStickerUsage(makeMeta(), makeSample());
      storeAnalysisResult('fuid_abc123', {
        emotionTags: ['cute', 'happy'],
        moodMap: { happy: 0.8, playful: 0.3 },
        personaFit: true,
        description: 'A cute cat sticker',
      });

      const item = getItem('fuid_abc123');
      expect(item!.analysisStatus).toBe('ready');
      expect(item!.emotionTags).toEqual(['cute', 'happy']);
      expect(item!.moodMap).toEqual({ happy: 0.8, playful: 0.3 });
      expect(item!.personaFit).toBe(true);
      expect(item!.description).toBe('A cute cat sticker');
    });
  });

  describe('markAnalysisFailed', () => {
    it('should set analysis_status to failed', () => {
      recordStickerUsage(makeMeta(), makeSample());
      markAnalysisFailed('fuid_abc123');

      const item = getItem('fuid_abc123');
      expect(item!.analysisStatus).toBe('failed');
    });
  });

  describe('markWaitingForPreview', () => {
    it('should set analysis_status to waiting_for_preview with reason', () => {
      recordStickerUsage(makeMeta(), makeSample());
      markWaitingForPreview('fuid_abc123', 'animated needs convert');

      const item = getItem('fuid_abc123');
      expect(item!.analysisStatus).toBe('waiting_for_preview');
      expect(item!.analysisReason).toBe('animated needs convert');
    });
  });

  describe('setRawAssetPath', () => {
    it('should set raw_asset_path and update asset_status', () => {
      recordStickerUsage(makeMeta(), makeSample());
      const ok = setRawAssetPath('fuid_abc123', '/data/sticker_assets/raw/abc/original.webp');

      expect(ok).toBe(true);
      const item = getItem('fuid_abc123');
      expect(item!.rawAssetPath).toBe('/data/sticker_assets/raw/abc/original.webp');
      expect(item!.assetStatus).toBe('raw_ready');
    });

    it('should return false for non-existent sticker', () => {
      const ok = setRawAssetPath('nonexistent', '/some/path');
      expect(ok).toBe(false);
    });
  });

  describe('getReadyStickersByIntent', () => {
    it('should return empty array when no ready stickers exist', () => {
      const result = getReadyStickersByIntent('cute');
      expect(result).toEqual([]);
    });

    it('should return matching stickers with scores', () => {
      recordStickerUsage(makeMeta(), makeSample());
      storeAnalysisResult('fuid_abc123', {
        emotionTags: ['cute', 'happy'],
        moodMap: { happy: 0.8 },
        personaFit: true,
      });

      const result = getReadyStickersByIntent('cute');
      expect(result.length).toBe(1);
      expect(result[0]!.fileId).toBe('fid_xyz');
      expect(result[0]!.score).toBeGreaterThan(0);
    });

    it('should not return stickers with persona_fit = false', () => {
      recordStickerUsage(makeMeta(), makeSample());
      storeAnalysisResult('fuid_abc123', {
        emotionTags: ['cute'],
        personaFit: false,
      });

      const result = getReadyStickersByIntent('cute');
      expect(result).toEqual([]);
    });

    it('should not return non-ready stickers', () => {
      recordStickerUsage(makeMeta(), makeSample());
      // Default status is 'pending'
      const result = getReadyStickersByIntent('cute');
      expect(result).toEqual([]);
    });
  });

  describe('getSamples', () => {
    it('should return samples ordered by date desc', () => {
      recordStickerUsage(makeMeta(), makeSample({ date: 1700000001 }));
      recordStickerUsage(makeMeta(), makeSample({ messageId: 101, date: 1700000003 }));
      recordStickerUsage(makeMeta(), makeSample({ messageId: 102, date: 1700000002 }));

      const samples = getSamples('fuid_abc123');
      expect(samples).toHaveLength(3);
      expect(samples[0]!.date).toBe(1700000003);
      expect(samples[1]!.date).toBe(1700000002);
      expect(samples[2]!.date).toBe(1700000001);
    });

    it('should respect limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        recordStickerUsage(makeMeta(), makeSample({ messageId: 100 + i, date: 1700000000 + i }));
      }

      const samples = getSamples('fuid_abc123', 2);
      expect(samples).toHaveLength(2);
    });

    it('should return empty for non-existent sticker', () => {
      const samples = getSamples('nonexistent');
      expect(samples).toEqual([]);
    });
  });
});
